import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { buildWebToolProviders } from '../src/adapters/tool/web-tool-provider.js'
import {
  buildRuntimeCapabilityManifest,
  KunCapabilitiesConfig
} from '../src/contracts/capabilities.js'
import { modelCapabilitiesForModel } from '../src/loop/model-context-profile.js'
import { DeterministicWebProvider } from '../src/ports/web-provider.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

function buildContext(): ToolHostContext {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    workspace: '/tmp/project',
    threadMode: 'agent',
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function deterministicProvider() {
  return new DeterministicWebProvider({
    id: 'test-search',
    nowIso: () => '2026-06-03T00:00:00.000Z',
    pages: {
      'https://docs.example.test/page': {
        url: 'https://docs.example.test/page',
        finalUrl: 'https://docs.example.test/page',
        title: 'Docs Page',
        contentType: 'text/plain',
        text: 'Current docs content'
      }
    },
    searchResults: {
      'kun web': [
        {
          url: 'https://docs.example.test/page',
          title: 'Kun Web Docs',
          snippet: 'How Kun web access works.'
        }
      ]
    }
  })
}

describe('Web tool provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not advertise web tools when web access is disabled', async () => {
    const config = KunCapabilitiesConfig.parse({})
    const built = buildWebToolProviders(config.web, { provider: deterministicProvider() })

    expect(built.providers).toEqual([])
    expect(built.fetchAvailable).toBe(false)
    expect(built.searchAvailable).toBe(false)
  })

  it('fetches allowed URLs with source metadata and telemetry', async () => {
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        allowDomains: ['docs.example.test']
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web, {
        provider: deterministicProvider()
      }).providers)
    })

    const tools = await host.listTools(buildContext())
    expect(tools.map((tool) => tool.name)).toEqual(['web_fetch'])

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://docs.example.test/page' }
    }, buildContext())

    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind === 'tool_result') {
      expect(result.item.isError).toBe(false)
      const output = result.item.output as {
        sourceId: string
        text: string
        sources: Array<{ sourceId: string; url: string; retrievedAt: string }>
        citations: Array<{ sourceId: string }>
        telemetry: { policy: string; provider: string; byteCount: number }
      }
      expect(output.text).toBe('Current docs content')
      expect(output.sources[0]).toMatchObject({
        sourceId: output.sourceId,
        url: 'https://docs.example.test/page',
        retrievedAt: '2026-06-03T00:00:00.000Z'
      })
      expect(output.citations[0]?.sourceId).toBe(output.sourceId)
      expect(output.telemetry).toMatchObject({
        policy: 'allowed',
        provider: 'test-search',
        byteCount: 20
      })
    }
  })

  it('rejects fetch responses when content-length exceeds max_bytes', async () => {
    vi.stubGlobal('fetch', async () => new Response('abcdefghijklmnopqrstuvwxyz', {
      headers: {
        'content-length': '26',
        'content-type': 'text/plain'
      }
    }))
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        allowDomains: ['docs.example.test']
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://docs.example.test/large', max_bytes: 10 }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        error: {
          code: 'fetch_failed',
          message: expect.stringContaining('content exceeds')
        },
        telemetry: {
          policy: 'allowed',
          provider: 'fetch'
        }
      })
    }
  })

  it('truncates oversized fetch responses via streaming when content-length is unknown', async () => {
    vi.stubGlobal('fetch', async () => new Response('abcdefghijklmnopqrstuvwxyz', {
      headers: {
        'content-type': 'text/plain'
      }
    }))
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        allowDomains: ['docs.example.test']
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://docs.example.test/large', max_bytes: 10 }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        text: 'abcdefghij',
        byteCount: 10,
        truncated: true,
        telemetry: {
          policy: 'allowed',
          provider: 'fetch',
          byteCount: 10
        }
      })
    }
  })

  it('fetches pages with browser-like request headers', async () => {
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Accept: expect.stringContaining('text/html'),
        'Accept-Language': expect.stringContaining('zh-CN'),
        Referer: 'https://docs.example.test/',
        'User-Agent': expect.stringContaining('Mozilla/5.0')
      })
      return new Response('Readable page', {
        headers: {
          'content-type': 'text/plain'
        }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://docs.example.test/page' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
  })

  it('explains target-site fetch denials with a fallback hint', async () => {
    vi.stubGlobal('fetch', async () => new Response('Forbidden', { status: 403 }))
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://blocked.example.test/page' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        error: {
          code: 'fetch_failed',
          message: expect.stringContaining('target site rejected direct HTTP fetching')
        }
      })
    }
  })

  it('uses Jina Reader before direct fetch when configured as the page reader', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      expect(url).toBe('https://r.jina.ai/https://blocked.example.test/page')
      return new Response('Reader content', {
        headers: { 'content-type': 'text/plain' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        fetchProvider: 'jina-reader',
        fetchFallbackEnabled: true,
        fetchReaderBaseUrl: 'https://r.jina.ai/'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://blocked.example.test/page' }
    }, buildContext())

    expect(calls).toEqual([
      'https://r.jina.ai/https://blocked.example.test/page'
    ])
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        finalUrl: 'https://blocked.example.test/page',
        text: 'Reader content',
        telemetry: {
          provider: 'jina-reader+fetch'
        }
      })
    }
  })

  it('backs off to direct fetch when Jina Reader fails', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://r.jina.ai/https://docs.example.test/page') {
        return new Response('Reader unavailable', { status: 403 })
      }
      expect(url).toBe('https://docs.example.test/page')
      return new Response('Direct content', {
        headers: { 'content-type': 'text/plain' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        fetchProvider: 'jina-reader',
        fetchFallbackEnabled: true,
        fetchReaderBaseUrl: 'https://r.jina.ai/'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://docs.example.test/page' }
    }, buildContext())

    expect(calls).toEqual([
      'https://r.jina.ai/https://docs.example.test/page',
      'https://docs.example.test/page'
    ])
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        text: 'Direct content',
        telemetry: {
          provider: 'jina-reader+fetch'
        }
      })
    }
  })

  it('uses Firecrawl before direct fetch when configured as the page reader', async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe('https://api.firecrawl.dev/v1/scrape')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer fire-key'
      })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        url: 'https://blocked.example.test/page',
        formats: ['markdown']
      })
      return new Response(JSON.stringify({
        data: {
          markdown: 'Firecrawl content',
          metadata: {
            title: 'Firecrawl Page',
            sourceURL: 'https://blocked.example.test/page'
          }
        }
      }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        fetchProvider: 'firecrawl',
        fetchFallbackEnabled: true,
        fetchApiKey: 'fire-key'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://blocked.example.test/page' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        title: 'Firecrawl Page',
        text: 'Firecrawl content',
        telemetry: {
          provider: 'firecrawl+fetch'
        }
      })
    }
  })

  it('rejects disallowed fetch URLs before contacting the provider', async () => {
    let contacted = false
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        denyDomains: ['blocked.example.test']
      }
    })
    const provider = new DeterministicWebProvider({
      pages: {
        'https://blocked.example.test/page': {
          url: 'https://blocked.example.test/page',
          finalUrl: 'https://blocked.example.test/page',
          text: 'secret'
        }
      }
    })
    provider.fetch = async (request) => {
      contacted = true
      return DeterministicWebProvider.prototype.fetch.call(provider, request)
    }
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web, { provider }).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://blocked.example.test/page' }
    }, buildContext())

    expect(contacted).toBe(false)
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        error: { code: 'policy_blocked' },
        telemetry: { policy: 'blocked' }
      })
    }
  })

  it('returns unavailable-provider errors for search without a search provider', async () => {
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        searchEnabled: true,
        provider: 'missing'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_search',
      arguments: { query: 'kun web' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        error: {
          code: 'provider_unavailable',
          message: 'web search provider is unavailable'
        }
      })
    }
  })

  it('searches through a configured provider with citations and telemetry', async () => {
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        searchEnabled: true,
        provider: 'test-search'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web, {
        provider: deterministicProvider()
      }).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_search',
      arguments: { query: 'kun web', limit: 3 }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      const output = result.item.output as {
        results: Array<{ sourceId: string; url: string; provider: string; rank: number }>
        sources: Array<{ sourceId: string }>
        telemetry: { resultCount: number; provider: string }
      }
      expect(output.results[0]).toMatchObject({
        url: 'https://docs.example.test/page',
        provider: 'test-search',
        rank: 1
      })
      expect(output.sources[0]?.sourceId).toBe(output.results[0]?.sourceId)
      expect(output.telemetry).toMatchObject({
        resultCount: 1,
        provider: 'test-search'
      })
    }
  })

  it('searches through Brave Search when API key is configured', async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain('q=kun+web')
      expect(init?.headers).toMatchObject({
        Accept: 'application/json',
        'X-Subscription-Token': 'brave-key'
      })
      return new Response(JSON.stringify({
        web: {
          results: [
            {
              url: 'https://docs.example.test/brave',
              title: 'Brave Result',
              description: 'Search result from Brave.'
            }
          ]
        }
      }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        searchEnabled: true,
        provider: 'brave-search',
        apiKey: 'brave-key'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_search',
      arguments: { query: 'kun web', limit: 3 }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        provider: 'brave-search',
        results: [
          {
            url: 'https://docs.example.test/brave',
            title: 'Brave Result',
            snippet: 'Search result from Brave.',
            provider: 'brave-search',
            rank: 1
          }
        ]
      })
    }
  })

  it('keeps built-in fetch available when Brave Search is configured', async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('api.search.brave.com')) {
        expect(init?.headers).toMatchObject({
          Accept: 'application/json',
          'X-Subscription-Token': 'brave-key'
        })
        return new Response(JSON.stringify({
          web: {
            results: [
              {
                url: 'https://docs.example.test/brave',
                title: 'Brave Result',
                description: 'Search result from Brave.'
              }
            ]
          }
        }), {
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response('<title>Fetched Page</title><p>Fetched content</p>', {
        headers: { 'content-type': 'text/html' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        searchEnabled: true,
        provider: 'brave-search',
        apiKey: 'brave-key'
      }
    })
    const built = buildWebToolProviders(config.web)
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(built.providers)
    })

    expect(built.fetchAvailable).toBe(true)
    expect(built.searchAvailable).toBe(true)
    await expect(host.listTools(buildContext())).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'web_fetch' }),
        expect.objectContaining({ name: 'web_search' })
      ])
    )

    const fetchResult = await host.execute({
      callId: 'call_1',
      toolName: 'web_fetch',
      arguments: { url: 'https://docs.example.test/page' }
    }, buildContext())
    const searchResult = await host.execute({
      callId: 'call_2',
      toolName: 'web_search',
      arguments: { query: 'kun web' }
    }, buildContext())

    expect(fetchResult.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (fetchResult.item.kind === 'tool_result') {
      expect(fetchResult.item.output).toMatchObject({
        title: 'Fetched Page',
        text: 'Fetched Page Fetched content',
        telemetry: {
          provider: 'brave-search'
        }
      })
    }
    expect(searchResult.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (searchResult.item.kind === 'tool_result') {
      expect(searchResult.item.output).toMatchObject({
        provider: 'brave-search',
        results: [
          {
            url: 'https://docs.example.test/brave',
            provider: 'brave-search'
          }
        ]
      })
    }
  })

  it('searches through DuckDuckGo Instant Answer without an API key', async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain('api.duckduckgo.com')
      expect(url).toContain('q=kun+web')
      expect(url).toContain('format=json')
      expect(init?.headers).toMatchObject({ Accept: 'application/json' })
      return new Response(JSON.stringify({
        Heading: 'Kun',
        AbstractText: 'Kun overview.',
        AbstractURL: 'https://docs.example.test/kun',
        RelatedTopics: [
          {
            FirstURL: 'https://docs.example.test/topic',
            Text: 'Kun Topic - Related result'
          }
        ]
      }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        searchEnabled: true,
        provider: 'duckduckgo'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_search',
      arguments: { query: 'kun web', limit: 3 }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        provider: 'duckduckgo',
        results: [
          {
            url: 'https://docs.example.test/kun',
            title: 'Kun',
            snippet: 'Kun overview.',
            provider: 'duckduckgo',
            rank: 1
          },
          {
            url: 'https://docs.example.test/topic',
            title: 'Kun Topic',
            snippet: 'Related result',
            provider: 'duckduckgo',
            rank: 2
          }
        ]
      })
    }
  })

  it('searches through a configured SearXNG JSON endpoint', async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain('search.example.test/search')
      expect(url).toContain('q=kun+web')
      expect(url).toContain('format=json')
      expect(init?.headers).toMatchObject({ Accept: 'application/json' })
      return new Response(JSON.stringify({
        results: [
          {
            url: 'https://docs.example.test/searxng',
            title: 'SearXNG Result',
            content: 'Search result from SearXNG.'
          }
        ]
      }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        searchEnabled: true,
        provider: 'searxng',
        baseUrl: 'https://search.example.test'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildWebToolProviders(config.web).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_search',
      arguments: { query: 'kun web', limit: 3 }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        provider: 'searxng',
        results: [
          {
            url: 'https://docs.example.test/searxng',
            title: 'SearXNG Result',
            snippet: 'Search result from SearXNG.',
            provider: 'searxng',
            rank: 1
          }
        ]
      })
    }
  })

  it('accepts searchxng as a compatibility alias for SearXNG', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      expect(String(input)).toContain('search.example.test/search')
      return new Response(JSON.stringify({
        results: [
          {
            url: 'https://docs.example.test/searchxng',
            title: 'Alias Result',
            content: 'Search result from the alias provider.'
          }
        ]
      }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        searchEnabled: true,
        provider: 'searchxng',
        baseUrl: 'https://search.example.test/search'
      }
    })
    const built = buildWebToolProviders(config.web)
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(built.providers)
    })

    expect(built.provider).toBe('searxng')
    const result = await host.execute({
      callId: 'call_1',
      toolName: 'web_search',
      arguments: { query: 'kun web' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        provider: 'searxng',
        results: [
          {
            url: 'https://docs.example.test/searchxng',
            provider: 'searxng'
          }
        ]
      })
    }
  })

  it('advertises web_search for search providers even when legacy searchEnabled is false', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      results: [
        {
          url: 'https://docs.example.test/searxng-fallback',
          title: 'Fallback Result',
          content: 'Search result from SearXNG fallback.'
        }
      ]
    }), {
      headers: { 'content-type': 'application/json' }
    }))
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        searchEnabled: false,
        provider: 'searxng',
        baseUrl: 'https://search.example.test/search'
      }
    })
    const built = buildWebToolProviders(config.web)
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(built.providers)
    })

    expect(built.searchAvailable).toBe(true)
    await expect(host.listTools(buildContext())).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'web_fetch' }),
        expect.objectContaining({ name: 'web_search' })
      ])
    )
  })

  it('reports web availability in the runtime capability manifest', () => {
    const config = KunCapabilitiesConfig.parse({
      web: {
        enabled: true,
        fetchEnabled: true,
        searchEnabled: true,
        provider: 'test-search'
      }
    })
    const built = buildWebToolProviders(config.web, { provider: deterministicProvider() })
    const manifest = buildRuntimeCapabilityManifest({
      config,
      model: modelCapabilitiesForModel('deepseek-chat'),
      web: {
        fetchAvailable: built.fetchAvailable,
        searchAvailable: built.searchAvailable,
        provider: built.provider
      }
    })

    expect(manifest.web.available).toBe(true)
    expect(manifest.web.fetch.available).toBe(true)
    expect(manifest.web.search.available).toBe(true)
    expect(manifest.web.provider).toBe('test-search')
  })
})
