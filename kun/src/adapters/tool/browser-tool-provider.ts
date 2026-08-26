import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { resolveExecutable, withToolBoundary } from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'
import { assertPublicNetworkUrl } from './network-target-policy.js'

type BrowserProviderOptions = {
  executableResolver?: () => string | null
  controllerFactory?: (config: BrowserCapabilityConfig, executablePath?: string) => BrowserControllerLike
}

export type BrowserControllerLike = {
  open(url: string, context: ToolHostContext): Promise<unknown>
  snapshot(context: ToolHostContext): Promise<unknown>
  click(input: { selector?: string; text?: string; ref?: number }, context: ToolHostContext): Promise<unknown>
  type(input: { selector?: string; ref?: number; text: string; submit: boolean }, context: ToolHostContext): Promise<unknown>
  screenshot(context: ToolHostContext): Promise<unknown>
  closePage(context: ToolHostContext): Promise<unknown>
  close(): Promise<void>
}

export type BrowserToolProviderBundle = {
  providers: CapabilityToolProvider[]
  available: boolean
  reason?: string
  close: () => Promise<void>
}

export function buildBrowserToolProviders(
  config: BrowserCapabilityConfig | undefined,
  options: BrowserProviderOptions = {}
): BrowserToolProviderBundle {
  if (!config?.enabled) return { providers: [], available: false, reason: 'disabled by config', close: async () => undefined }
  const executablePath = config.executablePath
    ?? options.executableResolver?.()
    ?? findBrowserExecutable()
    ?? undefined
  const available = Boolean(config.cdpEndpoint || executablePath || options.controllerFactory)
  const reason = available ? undefined : 'no CDP endpoint or Chromium-based browser executable was found'
  if (!available) {
    return {
      providers: [{ id: 'browser', kind: 'browser', enabled: true, available: false, reason, tools: [] }],
      available: false,
      reason,
      close: async () => undefined
    }
  }
  const controller = options.controllerFactory
    ? options.controllerFactory(config, executablePath)
    : new CdpBrowserController(config, executablePath)
  return {
    providers: [{
      id: 'browser',
      kind: 'browser',
      enabled: true,
      available: true,
      tools: createBrowserTools(controller)
    }],
    available: true,
    close: () => controller.close()
  }
}

function createBrowserTools(controller: BrowserControllerLike) {
  return [
    LocalToolHost.defineTool({
      name: 'browser_open',
      description: 'Open or navigate the isolated CDP browser page to an allowed URL.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', format: 'uri' } },
        required: ['url'],
        additionalProperties: false
      },
      policy: 'on-request',
      execute: (args, context) => withToolBoundary(async () => ({
        output: await controller.open(requiredString(args.url, 'url'), context)
      }))
    }),
    LocalToolHost.defineTool({
      name: 'browser_snapshot',
      description: 'Read the current page URL, title, visible text, and interactive element references.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      policy: 'auto',
      execute: (_args, context) => withToolBoundary(async () => ({ output: await controller.snapshot(context) }))
    }),
    LocalToolHost.defineTool({
      name: 'browser_click',
      description: 'Click an element by CSS selector, exact visible text, or snapshot reference.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          ref: { type: 'integer', minimum: 0 }
        },
        additionalProperties: false
      },
      policy: 'on-request',
      execute: (args, context) => withToolBoundary(async () => ({
        output: await controller.click({
          selector: optionalString(args.selector),
          text: optionalString(args.text),
          ref: optionalInteger(args.ref)
        }, context)
      }))
    }),
    LocalToolHost.defineTool({
      name: 'browser_type',
      description: 'Replace the value of an input selected by CSS selector or snapshot reference.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          ref: { type: 'integer', minimum: 0 },
          text: { type: 'string' },
          submit: { type: 'boolean' }
        },
        required: ['text'],
        additionalProperties: false
      },
      policy: 'on-request',
      execute: (args, context) => withToolBoundary(async () => ({
        output: await controller.type({
          selector: optionalString(args.selector),
          ref: optionalInteger(args.ref),
          text: requiredString(args.text, 'text', true),
          submit: args.submit === true
        }, context)
      }))
    }),
    LocalToolHost.defineTool({
      name: 'browser_screenshot',
      description: 'Capture the current page viewport as a PNG base64 payload.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      policy: 'auto',
      execute: (_args, context) => withToolBoundary(async () => ({ output: await controller.screenshot(context) }))
    }),
    LocalToolHost.defineTool({
      name: 'browser_close',
      description: 'Close the current isolated browser page.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      policy: 'auto',
      execute: (_args, context) => withToolBoundary(async () => ({ output: await controller.closePage(context) }))
    })
  ]
}

class CdpBrowserController implements BrowserControllerLike {
  private readonly sessions = new Map<string, { client: CdpClient; pageId?: string }>()
  private readonly actionCounts = new Map<string, number>()
  private launched?: { child: ChildProcess; userDataDir: string; endpoint: string }

  constructor(
    private readonly config: BrowserCapabilityConfig,
    private readonly executablePath?: string
  ) {}

  async open(url: string, context: ToolHostContext): Promise<unknown> {
    this.consumeBudget(context)
    await this.assertAllowedUrl(url)
    let session = this.sessions.get(context.threadId)
    if (!session) {
      session = await this.createSession(url, context.abortSignal)
      this.sessions.set(context.threadId, session)
    } else {
      await session.client.request('Page.navigate', { url }, context.abortSignal)
    }
    await delay(150, context.abortSignal)
    return this.pageInfo(session.client, context.abortSignal)
  }

  async snapshot(context: ToolHostContext): Promise<unknown> {
    this.consumeBudget(context)
    const client = this.requireSession(context.threadId)
    const result = await evaluate(client, `(() => {
      const selector = 'a,button,input,textarea,select,[role="button"],[tabindex]';
      const elements = Array.from(document.querySelectorAll(selector)).slice(0, 200);
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 20000),
        elements: elements.map((element, ref) => ({
          ref,
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.textContent || '').trim().slice(0, 300),
          ariaLabel: element.getAttribute('aria-label') || undefined,
          placeholder: element.getAttribute('placeholder') || undefined,
          type: element.getAttribute('type') || undefined,
          disabled: Boolean(element.disabled)
        }))
      };
    })()`, context.abortSignal)
    await this.assertAllowedUrl(objectString(result, 'url'))
    return result
  }

  async click(input: { selector?: string; text?: string; ref?: number }, context: ToolHostContext): Promise<unknown> {
    this.consumeBudget(context)
    if (!input.selector && !input.text && input.ref === undefined) throw new Error('selector, text, or ref is required')
    const client = this.requireSession(context.threadId)
    const expression = `(() => {
      const selector = 'a,button,input,textarea,select,[role="button"],[tabindex]';
      const element = ${input.selector
        ? `document.querySelector(${JSON.stringify(input.selector)})`
        : input.text
          ? `Array.from(document.querySelectorAll(selector)).find((item) => (item.innerText || item.textContent || '').trim() === ${JSON.stringify(input.text)})`
          : `Array.from(document.querySelectorAll(selector))[${input.ref}]`};
      if (!element) throw new Error('browser element not found');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { clicked: true, tag: element.tagName.toLowerCase() };
    })()`
    const result = await evaluate(client, expression, context.abortSignal)
    await delay(100, context.abortSignal)
    const page = await this.pageInfo(client, context.abortSignal)
    await this.assertAllowedUrl(objectString(page, 'url'))
    return { ...objectRecord(result), page }
  }

  async type(input: { selector?: string; ref?: number; text: string; submit: boolean }, context: ToolHostContext): Promise<unknown> {
    this.consumeBudget(context)
    if (!input.selector && input.ref === undefined) throw new Error('selector or ref is required')
    const client = this.requireSession(context.threadId)
    const expression = `(() => {
      const selector = 'a,button,input,textarea,select,[role="button"],[tabindex]';
      const element = ${input.selector
        ? `document.querySelector(${JSON.stringify(input.selector)})`
        : `Array.from(document.querySelectorAll(selector))[${input.ref}]`};
      if (!element) throw new Error('browser input not found');
      element.focus();
      element.value = ${JSON.stringify(input.text)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      if (${input.submit}) {
        const form = element.form || element.closest('form');
        if (form?.requestSubmit) form.requestSubmit();
        else element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      return { typed: true, submitted: ${input.submit} };
    })()`
    const result = await evaluate(client, expression, context.abortSignal)
    await delay(100, context.abortSignal)
    const page = await this.pageInfo(client, context.abortSignal)
    await this.assertAllowedUrl(objectString(page, 'url'))
    return { ...objectRecord(result), page }
  }

  async screenshot(context: ToolHostContext): Promise<unknown> {
    this.consumeBudget(context)
    const client = this.requireSession(context.threadId)
    const result = objectRecord(await client.request('Page.captureScreenshot', { format: 'png', fromSurface: true }, context.abortSignal))
    return { mimeType: 'image/png', data: result.data }
  }

  async closePage(context: ToolHostContext): Promise<unknown> {
    const session = this.sessions.get(context.threadId)
    if (!session) return { closed: false }
    this.sessions.delete(context.threadId)
    this.clearThreadBudgets(context.threadId)
    session.client.close()
    const endpoint = await this.httpEndpoint()
    if (session.pageId && endpoint) {
      await fetchWithTimeout(`${endpoint}/json/close/${encodeURIComponent(session.pageId)}`, { method: 'GET' }, this.config.actionTimeoutMs).catch(() => undefined)
    }
    return { closed: true }
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.client.close()
    this.sessions.clear()
    this.actionCounts.clear()
    if (this.launched) {
      const launched = this.launched
      this.launched = undefined
      launched.child.kill()
      await rm(launched.userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private consumeBudget(context: ToolHostContext): void {
    const key = `${context.threadId}\u0000${context.turnId}`
    for (const existing of this.actionCounts.keys()) {
      if (existing.startsWith(`${context.threadId}\u0000`) && existing !== key) this.actionCounts.delete(existing)
    }
    const count = (this.actionCounts.get(key) ?? 0) + 1
    if (count > this.config.maxActionsPerTurn) throw new Error('browser action budget exhausted for this turn')
    this.actionCounts.set(key, count)
  }

  private clearThreadBudgets(threadId: string): void {
    for (const key of this.actionCounts.keys()) {
      if (key.startsWith(`${threadId}\u0000`)) this.actionCounts.delete(key)
    }
  }

  private requireSession(threadId: string): CdpClient {
    const session = this.sessions.get(threadId)
    if (!session) throw new Error('browser page is not open; call browser_open first')
    return session.client
  }

  private async createSession(url: string, signal: AbortSignal): Promise<{ client: CdpClient; pageId?: string }> {
    const configured = this.config.cdpEndpoint
    if (configured?.startsWith('ws:') || configured?.startsWith('wss:')) {
      const client = await CdpClient.connect(configured, this.config.actionTimeoutMs, signal)
      await initializePage(client, signal, (value) => this.assertAllowedUrl(value))
      await client.request('Page.navigate', { url }, signal)
      return { client }
    }
    const endpoint = await this.httpEndpoint()
    if (!endpoint) throw new Error('CDP HTTP endpoint is unavailable')
    let page: Record<string, unknown> | undefined
    const created = await fetchWithTimeout(`${endpoint}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }, this.config.actionTimeoutMs)
      .then((response) => response.ok ? response.json() as Promise<Record<string, unknown>> : undefined)
      .catch(() => undefined)
    page = created
    if (!page) {
      const listed = await fetchWithTimeout(`${endpoint}/json/list`, {}, this.config.actionTimeoutMs).then((response) => response.json()) as unknown
      page = Array.isArray(listed)
        ? listed.find((item): item is Record<string, unknown> => objectString(item, 'webSocketDebuggerUrl').length > 0)
        : undefined
    }
    const websocketUrl = page ? objectString(page, 'webSocketDebuggerUrl') : ''
    if (!websocketUrl) throw new Error('CDP endpoint did not provide a page websocket')
    const client = await CdpClient.connect(websocketUrl, this.config.actionTimeoutMs, signal)
    await initializePage(client, signal, (value) => this.assertAllowedUrl(value))
    await client.request('Page.navigate', { url }, signal)
    return { client, pageId: objectString(page, 'id') || undefined }
  }

  private async httpEndpoint(): Promise<string | undefined> {
    if (this.config.cdpEndpoint?.startsWith('http:') || this.config.cdpEndpoint?.startsWith('https:')) {
      return this.config.cdpEndpoint.replace(/\/+$/, '')
    }
    if (this.launched) return this.launched.endpoint
    if (!this.executablePath) return undefined
    const userDataDir = await mkdtemp(join(tmpdir(), 'pengcodex-browser-'))
    const child = spawn(this.executablePath, [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      ...(this.config.headless ? ['--headless=new', '--disable-gpu'] : []),
      ...this.config.args,
      'about:blank'
    ], { stdio: 'ignore', windowsHide: true })
    const portFile = join(userDataDir, 'DevToolsActivePort')
    let port = ''
    for (let attempt = 0; attempt < 50; attempt += 1) {
      port = await readFile(portFile, 'utf8').then((text) => text.split(/\r?\n/)[0]?.trim() ?? '').catch(() => '')
      if (port) break
      if (child.exitCode !== null) break
      await delay(100)
    }
    if (!port) {
      child.kill()
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('browser failed to expose a CDP port')
    }
    const endpoint = `http://127.0.0.1:${port}`
    this.launched = { child, userDataDir, endpoint }
    return endpoint
  }

  private async assertAllowedUrl(value: string): Promise<void> {
    const url = new URL(value)
    if (['about:', 'data:', 'blob:'].includes(url.protocol)) return
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`browser URL protocol is not allowed: ${url.protocol}`)
    const host = url.hostname.toLowerCase()
    if (this.config.allowedDomains.length > 0) {
      const allowed = this.config.allowedDomains.some((domain) => {
        const normalized = domain.trim().toLowerCase().replace(/^\./, '')
        return host === normalized || host.endsWith(`.${normalized}`)
      })
      if (!allowed) throw new Error(`browser domain is not allowed: ${host}`)
    }
    await assertPublicNetworkUrl(url)
  }

  private async pageInfo(client: CdpClient, signal: AbortSignal): Promise<Record<string, unknown>> {
    return objectRecord(await evaluate(client, '({ url: location.href, title: document.title })', signal))
  }
}

type WebSocketLike = {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void, options?: { once?: boolean }): void
  removeEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void): void
}

class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly eventHandlers = new Map<string, Set<(params: unknown) => void>>()

  private constructor(private readonly socket: WebSocketLike, private readonly timeoutMs: number) {
    socket.addEventListener('message', (event) => this.onMessage(event.data))
    socket.addEventListener('close', () => this.failAll(new Error('CDP websocket closed')))
    socket.addEventListener('error', () => this.failAll(new Error('CDP websocket failed')))
  }

  static async connect(url: string, timeoutMs: number, signal: AbortSignal): Promise<CdpClient> {
    const Constructor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
    if (!Constructor) throw new Error('this Node runtime does not provide WebSocket support')
    if (signal.aborted) throw new Error('browser action aborted')
    const socket = new Constructor(url)
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      const onOpen = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new Error('CDP websocket connection failed')) }
      const onAbort = () => { cleanup(); socket.close(); reject(new Error('browser action aborted')) }
      const timer = setTimeout(() => {
        cleanup()
        socket.close()
        reject(new Error('CDP websocket connection timed out'))
      }, timeoutMs)
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return new CdpClient(socket, timeoutMs)
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('browser action aborted'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`CDP request timed out: ${method}`))
      }, this.timeoutMs)
      const onAbort = () => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(new Error(`browser action aborted: ${method}`))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error) },
        timer
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.eventHandlers.get(method) ?? new Set()
    handlers.add(handler)
    this.eventHandlers.set(method, handlers)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.eventHandlers.delete(method)
    }
  }

  close(): void {
    this.eventHandlers.clear()
    this.socket.close()
    this.failAll(new Error('CDP client closed'))
  }

  private onMessage(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8') : String(raw)
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
    try { message = JSON.parse(text) as typeof message } catch { return }
    if (message.method) {
      for (const handler of this.eventHandlers.get(message.method) ?? []) handler(message.params)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message ?? 'CDP request failed'))
    else pending.resolve(message.result)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

async function initializePage(
  client: CdpClient,
  signal: AbortSignal,
  assertAllowedUrl: (url: string) => Promise<void>
): Promise<void> {
  await client.request('Page.enable', {}, signal)
  await client.request('Runtime.enable', {}, signal)
  client.on('Fetch.requestPaused', (raw) => {
    const event = objectRecord(raw)
    const requestId = objectString(event, 'requestId')
    const request = objectRecord(event.request)
    const url = objectString(request, 'url')
    void (async () => {
      try {
        await assertAllowedUrl(url)
      } catch {
        await client.request('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        return
      }
      await client.request('Fetch.continueRequest', { requestId })
    })().catch(() => undefined)
  })
  await client.request('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }]
  }, signal)
}

async function evaluate(client: CdpClient, expression: string, signal: AbortSignal): Promise<unknown> {
  const response = objectRecord(await client.request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, signal))
  const exception = objectRecord(response.exceptionDetails)
  if (Object.keys(exception).length > 0) throw new Error(objectString(exception, 'text') || 'browser script failed')
  return objectRecord(response.result).value
}

function findBrowserExecutable(): string | null {
  const explicit = process.platform === 'win32'
    ? [
        join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
      ].filter((path) => path && existsSync(path))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : []
  return resolveExecutable([...explicit, 'google-chrome', 'chromium', 'chromium-browser', 'msedge'])
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${field} is required`)
  return allowEmpty ? value : value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function objectString(value: unknown, field: string): string {
  const candidate = objectRecord(value)[field]
  return typeof candidate === 'string' ? candidate : ''
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('browser action aborted'))
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('browser action aborted'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
