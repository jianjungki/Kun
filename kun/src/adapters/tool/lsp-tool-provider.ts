import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LspCapabilityConfig, LspServerConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import {
  assertWorkspacePathBoundary,
  resolveExecutable,
  resolveWorkspacePath,
  workspaceRoot,
  withToolBoundary
} from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'

type JsonRpcId = number | string
type JsonRpcResponse = { id?: JsonRpcId; result?: unknown; error?: { code?: number; message?: string } }

export type LspClientLike = {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params: unknown): void
  diagnostics(uri: string): unknown[]
  waitForDiagnostics?(uri: string, timeoutMs: number, signal: AbortSignal): Promise<unknown[]>
  close(): Promise<void>
}

export type LspProviderDiagnostic = {
  id: string
  enabled: boolean
  available: boolean
  command: string
  reason?: string
}

export type LspToolProviderBundle = {
  providers: CapabilityToolProvider[]
  diagnostics: LspProviderDiagnostic[]
  available: boolean
  connectedServers: () => number
  close: () => Promise<void>
}

type LspProviderOptions = {
  executableResolver?: (command: string) => string | null
  clientFactory?: (input: {
    id: string
    server: LspServerConfig
    command: string
    workspace: string
  }) => Promise<LspClientLike>
}

export function buildLspToolProviders(
  config: LspCapabilityConfig | undefined,
  options: LspProviderOptions = {}
): LspToolProviderBundle {
  if (!config?.enabled) return emptyBundle()
  const diagnostics: LspProviderDiagnostic[] = []
  const availableServers = new Map<string, { server: LspServerConfig; command: string }>()
  for (const [id, server] of Object.entries(config.servers)) {
    if (!server.enabled) {
      diagnostics.push({ id, enabled: false, available: false, command: server.command, reason: 'disabled by config' })
      continue
    }
    const command = options.executableResolver
      ? options.executableResolver(server.command)
      : resolveExecutable([server.command])
    if (!command) {
      diagnostics.push({ id, enabled: true, available: false, command: server.command, reason: 'executable not found' })
      continue
    }
    availableServers.set(id, { server, command })
    diagnostics.push({ id, enabled: true, available: true, command })
  }

  const clients = new Map<string, LspClientLike>()
  const clientStarts = new Map<string, Promise<LspClientLike>>()
  const openDocuments = new Map<LspClientLike, Map<string, { version: number; text: string }>>()
  const getClient = async (serverId: string, context: ToolHostContext): Promise<LspClientLike> => {
    const entry = availableServers.get(serverId)
    if (!entry) throw new Error(`LSP server is unavailable: ${serverId}`)
    const root = workspaceRoot(context.workspace)
    const key = `${serverId}\u0000${root}`
    const existing = clients.get(key)
    if (existing) return existing
    const starting = clientStarts.get(key)
    if (starting) return starting
    const start = (options.clientFactory
      ? options.clientFactory({ id: serverId, ...entry, workspace: root })
      : StdioLspClient.start({ ...entry, workspace: root }))
      .then((client) => {
        clients.set(key, client)
        clientStarts.delete(key)
        return client
      }, (error) => {
        clientStarts.delete(key)
        throw error
      })
    clientStarts.set(key, start)
    return start
  }

  const provider: CapabilityToolProvider = {
    id: 'lsp',
    kind: 'lsp',
    enabled: true,
    available: availableServers.size > 0,
    ...(availableServers.size === 0 ? { reason: 'no configured LSP executable was found' } : {}),
    tools: availableServers.size > 0 ? [createLspQueryTool(config, availableServers, getClient, openDocuments)] : []
  }
  return {
    providers: [provider],
    diagnostics,
    available: availableServers.size > 0,
    connectedServers: () => clients.size,
    close: async () => {
      const active = [...clients.values()]
      clients.clear()
      const starting = [...clientStarts.values()]
      clientStarts.clear()
      const started = await Promise.allSettled(starting)
      for (const result of started) {
        if (result.status === 'fulfilled' && !active.includes(result.value)) active.push(result.value)
      }
      for (const client of active) {
        for (const uri of openDocuments.get(client)?.keys() ?? []) {
          client.notify('textDocument/didClose', { textDocument: { uri } })
        }
      }
      openDocuments.clear()
      await Promise.all(active.map((client) => client.close().catch(() => undefined)))
    }
  }
}

function createLspQueryTool(
  config: LspCapabilityConfig,
  servers: ReadonlyMap<string, { server: LspServerConfig }>,
  getClient: (serverId: string, context: ToolHostContext) => Promise<LspClientLike>,
  openDocuments: Map<LspClientLike, Map<string, { version: number; text: string }>>
) {
  return LocalToolHost.defineTool({
    name: 'lsp_query',
    description: 'Query a configured language server for definitions, references, hover, symbols, implementations, or diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['definition', 'references', 'hover', 'documentSymbols', 'workspaceSymbols', 'implementation', 'diagnostics']
        },
        path: { type: 'string' },
        line: { type: 'integer', minimum: 0 },
        character: { type: 'integer', minimum: 0 },
        query: { type: 'string' },
        server: { type: 'string', enum: [...servers.keys()] }
      },
      required: ['operation'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: (args, context) => withToolBoundary(async () => {
      const operation = requiredString(args.operation, 'operation')
      const file = typeof args.path === 'string' && args.path.trim()
        ? resolveWorkspacePath(args.path, context)
        : undefined
      if (operation !== 'workspaceSymbols' && !file) throw new Error(`path is required for ${operation}`)
      if (file) await assertWorkspacePathBoundary(context.workspace, file.absolutePath, 'read')
      const serverId = selectServer(args.server, file?.absolutePath, config, servers)
      const client = await getClient(serverId, context)
      if (operation === 'workspaceSymbols') {
        return { output: await client.request('workspace/symbol', { query: stringValue(args.query) }, context.abortSignal) }
      }

      const target = file!
      const uri = pathToFileURL(target.absolutePath).href
      const text = await readFile(target.absolutePath, 'utf8')
      const diagnostics = operation === 'diagnostics'
        ? client.waitForDiagnostics?.(uri, 1_000, context.abortSignal)
        : undefined
      syncDocument(client, openDocuments, uri, target.absolutePath, text)
      if (operation === 'diagnostics') {
        return { output: { uri, diagnostics: diagnostics ? await diagnostics : client.diagnostics(uri) } }
      }
      if (operation === 'documentSymbols') {
        return { output: await client.request('textDocument/documentSymbol', { textDocument: { uri } }, context.abortSignal) }
      }
      const position = {
        line: nonNegativeInteger(args.line, 'line'),
        character: nonNegativeInteger(args.character, 'character')
      }
      const method = {
        definition: 'textDocument/definition',
        references: 'textDocument/references',
        hover: 'textDocument/hover',
        implementation: 'textDocument/implementation'
      }[operation]
      if (!method) throw new Error(`unsupported LSP operation: ${operation}`)
      const params: Record<string, unknown> = { textDocument: { uri }, position }
      if (operation === 'references') params.context = { includeDeclaration: true }
      return { output: await client.request(method, params, context.abortSignal) }
    })
  })
}

function selectServer(
  requested: unknown,
  filePath: string | undefined,
  config: LspCapabilityConfig,
  available: ReadonlyMap<string, unknown>
): string {
  if (typeof requested === 'string' && requested.trim()) {
    if (!available.has(requested)) throw new Error(`LSP server is unavailable: ${requested}`)
    return requested
  }
  const extension = filePath ? extname(filePath).toLowerCase() : ''
  const matches = Object.entries(config.servers)
    .filter(([id, server]) => available.has(id) && (server.extensions.length === 0 || server.extensions.some((item) => normalizeExtension(item) === extension)))
    .map(([id]) => id)
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new Error(`no LSP server matches ${extension || 'this request'}`)
  throw new Error(`multiple LSP servers match; specify server (${matches.join(', ')})`)
}

class StdioLspClient implements LspClientLike {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly publishedDiagnostics = new Map<string, unknown[]>()
  private readonly diagnosticVersions = new Map<string, number>()
  private readonly diagnosticWaiters = new Map<string, Set<{
    afterVersion: number
    resolve: (diagnostics: unknown[]) => void
    timer: NodeJS.Timeout
    signal: AbortSignal
    onAbort: () => void
  }>>()
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private closed = false

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    child.stderr.on('data', () => undefined)
    child.once('error', (error) => this.failAll(error))
    child.once('exit', (code, signal) => this.failAll(new Error(`LSP server exited (${code ?? signal ?? 'unknown'})`)))
  }

  static async start(input: { server: LspServerConfig; command: string; workspace: string }): Promise<StdioLspClient> {
    const child = spawn(input.command, input.server.args, {
      cwd: input.workspace,
      env: { ...process.env, ...input.server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const client = new StdioLspClient(child, input.server.timeoutMs)
    try {
      await client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(input.workspace).href,
        capabilities: {},
        initializationOptions: input.server.initializationOptions
      })
      client.notify('initialized', {})
      return client
    } catch (error) {
      client.terminate()
      throw error
    }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('LSP client is closed'))
    if (signal?.aborted) return Promise.reject(new Error('LSP request aborted'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`LSP request timed out: ${method}`))
      }, this.timeoutMs)
      const onAbort = () => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        this.notify('$/cancelRequest', { id })
        reject(new Error(`LSP request aborted: ${method}`))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params })
  }

  diagnostics(uri: string): unknown[] {
    return this.publishedDiagnostics.get(uri) ?? []
  }

  waitForDiagnostics(uri: string, timeoutMs: number, signal: AbortSignal): Promise<unknown[]> {
    if (signal.aborted) return Promise.reject(new Error('LSP request aborted'))
    const afterVersion = this.diagnosticVersions.get(uri) ?? 0
    return new Promise((resolve, reject) => {
      const waiters = this.diagnosticWaiters.get(uri) ?? new Set()
      const cleanup = (waiter: {
        afterVersion: number
        resolve: (diagnostics: unknown[]) => void
        timer: NodeJS.Timeout
        signal: AbortSignal
        onAbort: () => void
      }) => {
        clearTimeout(waiter.timer)
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.diagnosticWaiters.delete(uri)
      }
      const waiter = {
        afterVersion,
        resolve: (diagnostics: unknown[]) => {
          cleanup(waiter)
          resolve(diagnostics)
        },
        timer: setTimeout(() => {
          cleanup(waiter)
          resolve(this.diagnostics(uri))
        }, timeoutMs),
        signal,
        onAbort: () => {
          cleanup(waiter)
          reject(new Error('LSP request aborted'))
        }
      }
      waiters.add(waiter)
      this.diagnosticWaiters.set(uri, waiters)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.request('shutdown', null).catch(() => undefined)
    this.notify('exit', null)
    this.closed = true
    this.child.kill()
    this.failAll(new Error('LSP client closed'))
  }

  private write(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }

  private terminate(): void {
    if (this.closed) return
    this.closed = true
    this.child.kill()
    this.failAll(new Error('LSP client closed'))
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(lengthMatch[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + length)
      try {
        this.handle(JSON.parse(body) as JsonRpcResponse & { method?: string; params?: unknown })
      } catch {
        // Ignore malformed server frames; the originating request will time out.
      }
    }
  }

  private handle(message: JsonRpcResponse & { method?: string; params?: unknown }): void {
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: unknown; diagnostics?: unknown }
      if (typeof params?.uri === 'string' && Array.isArray(params.diagnostics)) {
        this.publishedDiagnostics.set(params.uri, params.diagnostics)
        const version = (this.diagnosticVersions.get(params.uri) ?? 0) + 1
        this.diagnosticVersions.set(params.uri, version)
        for (const waiter of this.diagnosticWaiters.get(params.uri) ?? []) {
          if (version > waiter.afterVersion) waiter.resolve(params.diagnostics)
        }
      }
      return
    }
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message.id, message.method, message.params)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message ?? `LSP error ${message.error.code ?? ''}`.trim()))
    else pending.resolve(message.result)
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === 'workspace/configuration') {
      const items = (params as { items?: unknown })?.items
      this.write({ jsonrpc: '2.0', id, result: Array.isArray(items) ? items.map(() => null) : [] })
      return
    }
    if (method === 'workspace/applyEdit') {
      this.write({ jsonrpc: '2.0', id, result: { applied: false, failureReason: 'workspace edits are not accepted through LSP' } })
      return
    }
    if (method === 'window/showMessageRequest' || method === 'client/registerCapability' || method === 'client/unregisterCapability') {
      this.write({ jsonrpc: '2.0', id, result: null })
      return
    }
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported server request: ${method}` } })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const [uri, waiters] of this.diagnosticWaiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.resolve(this.diagnostics(uri))
      }
    }
    this.diagnosticWaiters.clear()
  }
}

function syncDocument(
  client: LspClientLike,
  documents: Map<LspClientLike, Map<string, { version: number; text: string }>>,
  uri: string,
  path: string,
  text: string
): void {
  const clientDocuments = documents.get(client) ?? new Map()
  const current = clientDocuments.get(uri)
  if (!current) {
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdForPath(path), version: 1, text }
    })
    clientDocuments.set(uri, { version: 1, text })
    documents.set(client, clientDocuments)
    return
  }
  if (current.text === text) return
  const version = current.version + 1
  client.notify('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }]
  })
  clientDocuments.set(uri, { version, text })
}

function emptyBundle(): LspToolProviderBundle {
  return { providers: [], diagnostics: [], available: false, connectedServers: () => 0, close: async () => undefined }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative integer`)
  return Number(value)
}

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

function languageIdForPath(path: string): string {
  const extension = extname(path).toLowerCase()
  return {
    '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.cc': 'cpp', '.cs': 'csharp', '.json': 'json', '.css': 'css', '.html': 'html'
  }[extension] ?? (extension.slice(1) || 'plaintext')
}
