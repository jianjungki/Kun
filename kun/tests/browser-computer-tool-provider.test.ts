import { describe, expect, it, vi } from 'vitest'
import { buildBrowserToolProviders, type BrowserControllerLike } from '../src/adapters/tool/browser-tool-provider.js'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { buildComputerUseToolProviders, type ComputerUseBackend } from '../src/adapters/tool/computer-use-tool-provider.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

describe('Browser and computer-use tool providers', () => {
  it('keeps browser disabled by default and delegates enabled CDP tools', async () => {
    const defaults = KunCapabilitiesConfig.parse({})
    expect(buildBrowserToolProviders(defaults.browser).providers).toEqual([])

    const controller: BrowserControllerLike = {
      open: vi.fn(async (url) => ({ url })),
      snapshot: vi.fn(async () => ({ title: 'Example' })),
      click: vi.fn(async () => ({ clicked: true })),
      type: vi.fn(async () => ({ typed: true })),
      screenshot: vi.fn(async () => ({ mimeType: 'image/png', data: 'AA==' })),
      closePage: vi.fn(async () => ({ closed: true })),
      close: vi.fn(async () => undefined)
    }
    const config = KunCapabilitiesConfig.parse({
      browser: { enabled: true, cdpEndpoint: 'http://127.0.0.1:9222', allowedDomains: ['example.test'] }
    }).browser
    const built = buildBrowserToolProviders(config, { controllerFactory: () => controller })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect((await host.listTools(context())).map((tool) => tool.name)).toEqual([
      'browser_open',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_screenshot',
      'browser_close'
    ])
    await host.execute({
      callId: 'browser_open',
      toolName: 'browser_open',
      arguments: { url: 'https://example.test/docs' }
    }, context())
    expect(controller.open).toHaveBeenCalledWith('https://example.test/docs', expect.any(Object))
    await built.close()
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable computer backend without advertising actions', async () => {
    const backend: ComputerUseBackend = {
      ready: async () => ({ available: false, reason: 'native backend missing' }),
      screenshot: async () => ({ mimeType: 'image/png', data: '', width: 1, height: 1 }),
      move: async () => undefined,
      click: async () => undefined,
      type: async () => undefined,
      key: async () => undefined
    }
    const config = KunCapabilitiesConfig.parse({ computerUse: { enabled: true } }).computerUse
    const built = await buildComputerUseToolProviders(config, { backend })

    expect(built.available).toBe(false)
    expect(built.reason).toBe('native backend missing')
    expect(built.providers[0]).toMatchObject({ enabled: true, available: false, tools: [] })
  })

  it('routes bounded computer actions through an injected backend', async () => {
    const click = vi.fn(async () => undefined)
    const backend: ComputerUseBackend = {
      ready: async () => ({ available: true }),
      screenshot: async () => ({ mimeType: 'image/png', data: 'AA==', width: 800, height: 600 }),
      move: async () => undefined,
      click,
      type: async () => undefined,
      key: async () => undefined
    }
    const config = KunCapabilitiesConfig.parse({
      computerUse: { enabled: true, actionDelayMs: 0 }
    }).computerUse
    const built = await buildComputerUseToolProviders(config, { backend })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const result = await host.execute({
      callId: 'computer_click',
      toolName: 'computer_click',
      arguments: { x: 10, y: 20, button: 'right', count: 2 }
    }, context())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(click).toHaveBeenCalledWith({ x: 10, y: 20, button: 'right', count: 2 })
  })
})

function context(): ToolHostContext {
  return {
    threadId: 'thr_tools',
    turnId: 'turn_tools',
    workspace: process.cwd(),
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}
