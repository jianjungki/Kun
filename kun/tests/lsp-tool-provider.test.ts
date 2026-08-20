import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { buildLspToolProviders, type LspClientLike } from '../src/adapters/tool/lsp-tool-provider.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

describe('LSP tool provider', () => {
  let workspace = ''

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'pengcodex-lsp-'))
    await writeFile(join(workspace, 'main.ts'), 'export const value = 1\n', 'utf8')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('selects a server by extension, reuses its client, and closes it', async () => {
    const request = vi.fn(async (method: string) => ({ method }))
    const notify = vi.fn()
    const close = vi.fn(async () => undefined)
    const client: LspClientLike = { request, notify, diagnostics: () => [], close }
    const clientFactory = vi.fn(async () => client)
    const config = KunCapabilitiesConfig.parse({
      lsp: {
        enabled: true,
        servers: {
          typescript: { command: 'fake-ts-lsp', extensions: ['ts'] }
        }
      }
    }).lsp
    const built = buildLspToolProviders(config, {
      executableResolver: () => 'fake-ts-lsp',
      clientFactory
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    const first = await host.execute({
      callId: 'call_1',
      toolName: 'lsp_query',
      arguments: { operation: 'hover', path: 'main.ts', line: 0, character: 7 }
    }, context(workspace))
    await writeFile(join(workspace, 'main.ts'), 'export const value = 2\n', 'utf8')
    const second = await host.execute({
      callId: 'call_2',
      toolName: 'lsp_query',
      arguments: { operation: 'documentSymbols', path: 'main.ts' }
    }, context(workspace))

    expect(first.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(second.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(clientFactory).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      'textDocument/hover',
      expect.objectContaining({ position: { line: 0, character: 7 } }),
      expect.any(AbortSignal)
    )
    expect(notify).toHaveBeenCalledWith('textDocument/didOpen', expect.any(Object))
    expect(notify).toHaveBeenCalledWith('textDocument/didChange', expect.objectContaining({
      textDocument: expect.objectContaining({ version: 2 }),
      contentChanges: [{ text: 'export const value = 2\n' }]
    }))
    expect(built.connectedServers()).toBe(1)
    await built.close()
    expect(notify).toHaveBeenCalledWith('textDocument/didClose', expect.any(Object))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('starts one client for concurrent first queries in the same workspace', async () => {
    const client: LspClientLike = {
      request: async () => ({}),
      notify: () => undefined,
      diagnostics: () => [],
      close: async () => undefined
    }
    const clientFactory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return client
    })
    const config = KunCapabilitiesConfig.parse({
      lsp: { enabled: true, servers: { typescript: { command: 'fake', extensions: ['ts'] } } }
    }).lsp
    const built = buildLspToolProviders(config, {
      executableResolver: () => 'fake',
      clientFactory
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    await Promise.all(['call_1', 'call_2'].map((callId) => host.execute({
      callId,
      toolName: 'lsp_query',
      arguments: { operation: 'documentSymbols', path: 'main.ts' }
    }, context(workspace))))

    expect(clientFactory).toHaveBeenCalledTimes(1)
    await built.close()
  })

  it('rejects paths outside the active workspace', async () => {
    const config = KunCapabilitiesConfig.parse({
      lsp: { enabled: true, servers: { typescript: { command: 'fake', extensions: ['ts'] } } }
    }).lsp
    const built = buildLspToolProviders(config, {
      executableResolver: () => 'fake',
      clientFactory: async () => ({
        request: async () => ({}),
        notify: () => undefined,
        diagnostics: () => [],
        close: async () => undefined
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const result = await host.execute({
      callId: 'call_outside',
      toolName: 'lsp_query',
      arguments: { operation: 'hover', path: '../outside.ts', line: 0, character: 0 }
    }, context(workspace))

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      expect(JSON.stringify(result.item.output)).toMatch(/outside|workspace/i)
    }
  })
})

function context(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_lsp',
    turnId: 'turn_lsp',
    workspace,
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}
