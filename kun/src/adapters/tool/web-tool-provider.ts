import type { KunCapabilitiesConfig, WebCapabilityConfig } from '../../contracts/capabilities.js'
import type { WebFetchResult, WebProvider, WebSearchResult } from '../../ports/web-provider.js'
import { sourceIdFor, UnavailableWebProvider } from '../../ports/web-provider.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

const DEFAULT_WEB_TIMEOUT_MS = 15_000
const DEFAULT_WEB_MAX_BYTES = 1_000_000
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 10

export type WebProviderDiagnostic = {
  id: string
  enabled: boolean
  available: boolean
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
  reason?: string
}

export type WebToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: WebProviderDiagnostic[]
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
}

export type WebToolProviderOptions = {
  provider?: WebProvider
  nowIso?: () => string
}

export function buildWebToolProviders(
  config: KunCapabilitiesConfig['web'] | undefined,
  options: WebToolProviderOptions = {}
): WebToolProviderBuildResult {
  const web = config
  if (!web?.enabled) {
    return {
      providers: [],
      diagnostics: [],
      fetchAvailable: false,
      searchAvailable: false
    }
  }

  const provider: WebProvider = options.provider ?? createWebProvider(web, options.nowIso)
  const searchEnabled = web.searchEnabled || normalizeWebProviderId(web.provider) !== 'fetch'
  const tools = []
  if (web.fetchEnabled) {
    tools.push(createFetchTool(web, provider))
  }
  if (searchEnabled) {
    tools.push(createSearchTool(web, provider))
  }
  const fetchAvailable = Boolean(web.fetchEnabled && provider.fetch)
  const searchAvailable = Boolean(searchEnabled && provider.search)
  const reason = !tools.length
    ? 'web tools are disabled by config'
    : !fetchAvailable && !searchAvailable
      ? 'web provider is unavailable'
      : undefined

  return {
    providers: tools.length
      ? [{
          id: 'web',
          kind: 'web',
          enabled: true,
          available: true,
          ...(reason ? { reason } : {}),
          tools
        }]
      : [],
    diagnostics: [{
      id: 'web',
      enabled: true,
      available: fetchAvailable || searchAvailable,
      fetchAvailable,
      searchAvailable,
      provider: provider.id,
      ...(reason ? { reason } : {})
    }],
    fetchAvailable,
    searchAvailable,
    provider: provider.id
  }
}

function createWebProvider(web: WebCapabilityConfig, nowIso: (() => string) | undefined): WebProvider {
  const providerId = normalizeWebProviderId(web.provider)
  const fetchProvider = createFetchProvider(web, nowIso)
  if (providerId === 'fetch') return fetchProvider
  if (providerId === 'brave-search') {
    return compositeSearchProvider(providerId, fetchProvider, web.apiKey?.trim()
      ? new BraveSearchWebProvider({
          apiKey: web.apiKey.trim(),
          baseUrl: web.baseUrl?.trim(),
          nowIso
        })
      : new UnavailableWebProvider(providerId))
  }
  if (providerId === 'duckduckgo') {
    return compositeSearchProvider(providerId, fetchProvider, new DuckDuckGoSearchWebProvider({
      baseUrl: web.baseUrl?.trim(),
      nowIso
    }))
  }
  if (providerId === 'searxng') {
    return compositeSearchProvider(providerId, fetchProvider, new SearxngSearchWebProvider({
      baseUrl: web.baseUrl?.trim(),
      nowIso
    }))
  }
  return web.fetchEnabled ? fetchProvider : new UnavailableWebProvider(providerId)
}

function normalizeWebProviderId(provider: string | undefined): string {
  const id = provider?.trim() || 'fetch'
  return id === 'searchxng' ? 'searxng' : id
}

function compositeSearchProvider(
  providerId: string,
  fetchProvider: WebProvider,
  searchProvider: WebProvider
): WebProvider {
  return new CompositeWebProvider(providerId, {
    fetch: fetchProvider,
    search: searchProvider
  })
}

function createFetchProvider(web: WebCapabilityConfig, nowIso: (() => string) | undefined): WebProvider {
  const direct = new FetchWebProvider(nowIso)
  const fetchProvider = normalizeWebFetchProviderId(web.fetchProvider)
  if (!web.fetchFallbackEnabled || fetchProvider === 'direct') return direct
  if (fetchProvider === 'jina-reader') {
    return new BackoffFetchWebProvider(new JinaReaderWebProvider({
      baseUrl: web.fetchReaderBaseUrl?.trim(),
      apiKey: web.fetchApiKey?.trim(),
      nowIso
    }), direct)
  }
  if (fetchProvider === 'firecrawl') {
    return new BackoffFetchWebProvider(new FirecrawlWebProvider({
      baseUrl: web.fetchReaderBaseUrl?.trim(),
      apiKey: web.fetchApiKey?.trim(),
      nowIso
    }), direct)
  }
  return direct
}

function normalizeWebFetchProviderId(provider: string | undefined): string {
  const id = provider?.trim() || 'direct'
  return ['direct', 'jina-reader', 'firecrawl', 'browser-mcp'].includes(id) ? id : 'direct'
}

function createFetchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_fetch',
    description: 'Fetch an allowed HTTP or HTTPS URL and return extracted text with source metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_bytes: { type: 'number' },
        timeout_ms: { type: 'number' }
      },
      required: ['url'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const rawUrl = pickString(args.url)
      if (!rawUrl) return toolError('invalid_url', 'url is required')
      const policy = validateUrlPolicy(rawUrl, config)
      if (!policy.ok) return toolError('policy_blocked', policy.reason, telemetry({ startedAt, policy: 'blocked', url: rawUrl }))
      if (!provider.fetch) return toolError('provider_unavailable', 'web fetch provider is unavailable')
      const maxBytes = boundedInt(args.max_bytes, DEFAULT_WEB_MAX_BYTES, 1, DEFAULT_WEB_MAX_BYTES)
      const timeoutMs = boundedInt(args.timeout_ms, DEFAULT_WEB_TIMEOUT_MS, 1, DEFAULT_WEB_TIMEOUT_MS)
      try {
        const result = await provider.fetch({
          url: policy.url.href,
          maxBytes,
          timeoutMs,
          signal: context.abortSignal
        })
        return {
          output: fetchOutput(result, telemetry({
            startedAt,
            policy: 'allowed',
            url: policy.url.href,
            provider: provider.id,
            byteCount: result.byteCount
          }))
        }
      } catch (error) {
        return toolError('fetch_failed', errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          url: policy.url.href,
          provider: provider.id
        }))
      }
    }
  })
}

function createSearchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_search',
    description: 'Search the web through the configured search provider, such as SearXNG, DuckDuckGo, or Brave Search. Use this for open-ended web research queries when web search is needed; do not claim web search is unavailable when this tool is advertised. Returns ranked results with source metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The natural-language web search query.' },
        limit: { type: 'number', description: 'Maximum number of ranked results to return.' },
        timeout_ms: { type: 'number', description: 'Maximum time to wait for the configured search provider.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const query = pickString(args.query)
      if (!query) return toolError('invalid_query', 'query is required')
      if (!provider.search) return toolError('provider_unavailable', 'web search provider is unavailable')
      const limit = boundedInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
      const timeoutMs = boundedInt(args.timeout_ms, DEFAULT_WEB_TIMEOUT_MS, 1, DEFAULT_WEB_TIMEOUT_MS)
      try {
        const results = await provider.search({
          query,
          limit,
          timeoutMs,
          signal: context.abortSignal
        })
        return {
          output: searchOutput(query, provider.id, results, telemetry({
            startedAt,
            policy: 'allowed',
            provider: provider.id,
            query,
            resultCount: results.length
          }))
        }
      } catch (error) {
        return toolError('search_failed', errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          provider: provider.id,
          query
        }))
      }
    }
  })
}

class FetchWebProvider implements WebProvider {
  readonly id = 'fetch'
  private readonly nowIso: () => string

  constructor(nowIso: (() => string) | undefined) {
    this.nowIso = nowIso ?? (() => new Date().toISOString())
  }

  async fetch(request: {
    url: string
    maxBytes: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebFetchResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(request.url, {
        signal: controller.signal,
        headers: browserLikeFetchHeaders(request.url)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      // Fast-fail if content-length is known and exceeds limit
      const contentLength = response.headers.get('content-length')
      if (contentLength && Number(contentLength) > request.maxBytes) {
        throw new Error(`content exceeds ${request.maxBytes} byte limit`)
      }

      // Stream response body with size limit
      const reader = response.body?.getReader()
      if (!reader) throw new Error('response body is not readable')

      const chunks: Uint8Array[] = []
      let totalBytes = 0
      let truncated = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const remaining = request.maxBytes - totalBytes
        if (remaining <= 0) {
          truncated = true
          reader.cancel()
          break
        }

        if (value.length > remaining) {
          chunks.push(value.subarray(0, remaining))
          totalBytes += remaining
          truncated = true
          reader.cancel()
          break
        }

        chunks.push(value)
        totalBytes += value.length
      }

      const buffer = Buffer.concat(chunks)
      const contentType = response.headers.get('content-type') ?? undefined
      const raw = buffer.toString('utf8')
      const extracted = extractReadableText(raw, contentType)
      const finalUrl = response.url || request.url
      return {
        sourceId: sourceIdFor('fetch', finalUrl),
        url: request.url,
        finalUrl,
        title: extracted.title,
        contentType,
        text: extracted.text,
        retrievedAt: this.nowIso(),
        byteCount: totalBytes,
        truncated
      }
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

class BackoffFetchWebProvider implements WebProvider {
  readonly id: string
  readonly fetch: WebProvider['fetch']

  constructor(private readonly primary: WebProvider, private readonly backoff: WebProvider) {
    this.id = `${primary.id}+${backoff.id}`
    this.fetch = this.fetchWithBackoff.bind(this)
  }

  private async fetchWithBackoff(request: {
    url: string
    maxBytes: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebFetchResult> {
    try {
      if (!this.primary.fetch) throw new Error('primary fetch provider is unavailable')
      return await this.primary.fetch(request)
    } catch (error) {
      if (!shouldBackoffFetch(error)) throw error
      if (!this.backoff.fetch) throw error
      return this.backoff.fetch(request)
    }
  }
}

class JinaReaderWebProvider implements WebProvider {
  readonly id = 'jina-reader'
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly nowIso: () => string

  constructor(input: { baseUrl?: string; apiKey?: string; nowIso?: () => string }) {
    this.baseUrl = input.baseUrl || 'https://r.jina.ai/'
    this.apiKey = input.apiKey || undefined
    this.nowIso = input.nowIso ?? (() => new Date().toISOString())
  }

  async fetch(request: {
    url: string
    maxBytes: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebFetchResult> {
    const readerUrl = jinaReaderUrl(this.baseUrl, request.url)
    const result = await fetchTextResponse(readerUrl.href, request, {
      Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.7',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
    })
    return {
      ...result,
      sourceId: sourceIdFor('fetch', request.url),
      url: request.url,
      finalUrl: request.url,
      title: result.title,
      retrievedAt: this.nowIso()
    }
  }
}

class FirecrawlWebProvider implements WebProvider {
  readonly id = 'firecrawl'
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly nowIso: () => string

  constructor(input: { baseUrl?: string; apiKey?: string; nowIso?: () => string }) {
    this.baseUrl = input.baseUrl || 'https://api.firecrawl.dev/v1/scrape'
    this.apiKey = input.apiKey || undefined
    this.nowIso = input.nowIso ?? (() => new Date().toISOString())
  }

  async fetch(request: {
    url: string
    maxBytes: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebFetchResult> {
    const response = await fetchJsonResponse(this.baseUrl, request, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        url: request.url,
        formats: ['markdown']
      })
    })
    const extracted = firecrawlResult(response)
    const bytes = Buffer.byteLength(extracted.text, 'utf8')
    return {
      sourceId: sourceIdFor('fetch', request.url),
      url: request.url,
      finalUrl: extracted.url ?? request.url,
      title: extracted.title,
      contentType: 'text/markdown',
      text: extracted.text.slice(0, request.maxBytes),
      retrievedAt: this.nowIso(),
      byteCount: Math.min(bytes, request.maxBytes),
      truncated: bytes > request.maxBytes
    }
  }
}

class CompositeWebProvider implements WebProvider {
  readonly id: string
  readonly fetch?: WebProvider['fetch']
  readonly search?: WebProvider['search']

  constructor(id: string, providers: { fetch: WebProvider; search: WebProvider }) {
    this.id = id
    const fetch = providers.fetch.fetch?.bind(providers.fetch)
    if (fetch) {
      this.fetch = fetch
    }
    const search = providers.search.search?.bind(providers.search)
    if (search) {
      this.search = search
    }
  }
}

class BraveSearchWebProvider implements WebProvider {
  readonly id = 'brave-search'
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly nowIso: () => string

  constructor(input: { apiKey: string; baseUrl?: string; nowIso?: () => string }) {
    this.apiKey = input.apiKey
    this.baseUrl = input.baseUrl || 'https://api.search.brave.com/res/v1/web/search'
    this.nowIso = input.nowIso ?? (() => new Date().toISOString())
  }

  async search(request: {
    query: string
    limit: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebSearchResult[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const url = new URL(this.baseUrl)
      url.searchParams.set('q', request.query)
      url.searchParams.set('count', String(Math.min(request.limit, MAX_SEARCH_LIMIT)))
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.apiKey
        }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = await response.json() as unknown
      const rawResults = braveSearchResults(parsed).slice(0, request.limit)
      return rawResults.map((result, index) => ({
        sourceId: sourceIdFor('search', `${request.query}:${result.url}:${index}`),
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        retrievedAt: this.nowIso(),
        provider: this.id,
        rank: index + 1
      }))
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

class DuckDuckGoSearchWebProvider implements WebProvider {
  readonly id = 'duckduckgo'
  private readonly baseUrl: string
  private readonly nowIso: () => string

  constructor(input: { baseUrl?: string; nowIso?: () => string }) {
    this.baseUrl = input.baseUrl || 'https://api.duckduckgo.com/'
    this.nowIso = input.nowIso ?? (() => new Date().toISOString())
  }

  async search(request: {
    query: string
    limit: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebSearchResult[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const url = new URL(this.baseUrl)
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('no_redirect', '1')
      url.searchParams.set('no_html', '1')
      url.searchParams.set('skip_disambig', '1')
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = await response.json() as unknown
      return duckDuckGoSearchResults(parsed)
        .slice(0, request.limit)
        .map((result, index) => ({
          sourceId: sourceIdFor('search', `${request.query}:${result.url}:${index}`),
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          retrievedAt: this.nowIso(),
          provider: this.id,
          rank: index + 1
        }))
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

class SearxngSearchWebProvider implements WebProvider {
  readonly id = 'searxng'
  private readonly baseUrl: string
  private readonly nowIso: () => string

  constructor(input: { baseUrl?: string; nowIso?: () => string }) {
    this.baseUrl = input.baseUrl || 'http://127.0.0.1:8080/search'
    this.nowIso = input.nowIso ?? (() => new Date().toISOString())
  }

  async search(request: {
    query: string
    limit: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebSearchResult[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const url = searxngSearchUrl(this.baseUrl)
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = await response.json() as unknown
      return searxngSearchResults(parsed)
        .slice(0, request.limit)
        .map((result, index) => ({
          sourceId: sourceIdFor('search', `${request.query}:${result.url}:${index}`),
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          retrievedAt: this.nowIso(),
          provider: this.id,
          rank: index + 1
        }))
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

function braveSearchResults(value: unknown): Array<{ url: string; title: string; snippet: string }> {
  const root = recordValue(value)
  const web = recordValue(root.web)
  const results = Array.isArray(web.results) ? web.results : []
  return results
    .map((item) => {
      const result = recordValue(item)
      const url = pickString(result.url)
      if (!url) return null
      return {
        url,
        title: pickString(result.title) ?? url,
        snippet: pickString(result.description) ?? pickString(result.snippet) ?? ''
      }
    })
    .filter((item): item is { url: string; title: string; snippet: string } => item !== null)
}

function duckDuckGoSearchResults(value: unknown): Array<{ url: string; title: string; snippet: string }> {
  const root = recordValue(value)
  const results: Array<{ url: string; title: string; snippet: string }> = []
  const abstractUrl = pickString(root.AbstractURL)
  if (abstractUrl) {
    results.push({
      url: abstractUrl,
      title: pickString(root.Heading) ?? abstractUrl,
      snippet: pickString(root.AbstractText) ?? ''
    })
  }
  collectDuckDuckGoTopics(root.RelatedTopics, results)
  return dedupeSearchResults(results)
}

function collectDuckDuckGoTopics(
  value: unknown,
  results: Array<{ url: string; title: string; snippet: string }>
): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    const topic = recordValue(item)
    if (Array.isArray(topic.Topics)) {
      collectDuckDuckGoTopics(topic.Topics, results)
      continue
    }
    const url = pickString(topic.FirstURL)
    if (!url) continue
    const text = pickString(topic.Text) ?? url
    const separator = text.indexOf(' - ')
    results.push({
      url,
      title: separator > 0 ? text.slice(0, separator) : text,
      snippet: separator > 0 ? text.slice(separator + 3) : text
    })
  }
}

function searxngSearchUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/search'
  }
  return url
}

function searxngSearchResults(value: unknown): Array<{ url: string; title: string; snippet: string }> {
  const root = recordValue(value)
  const results = Array.isArray(root.results) ? root.results : []
  return dedupeSearchResults(results
    .map((item) => {
      const result = recordValue(item)
      const url = pickString(result.url)
      if (!url) return null
      return {
        url,
        title: pickString(result.title) ?? url,
        snippet: pickString(result.content) ?? pickString(result.snippet) ?? ''
      }
    })
    .filter((item): item is { url: string; title: string; snippet: string } => item !== null))
}

function dedupeSearchResults(
  results: Array<{ url: string; title: string; snippet: string }>
): Array<{ url: string; title: string; snippet: string }> {
  const seen = new Set<string>()
  return results.filter((result) => {
    if (seen.has(result.url)) return false
    seen.add(result.url)
    return true
  })
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function fetchOutput(result: WebFetchResult, toolTelemetry: Record<string, unknown>) {
  const source = {
    sourceId: result.sourceId,
    url: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt
  }
  return {
    sourceId: result.sourceId,
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt,
    contentType: result.contentType,
    text: result.text,
    byteCount: result.byteCount,
    truncated: result.truncated,
    sources: [source],
    citations: [source],
    telemetry: toolTelemetry
  }
}

function searchOutput(
  query: string,
  provider: string,
  results: WebSearchResult[],
  toolTelemetry: Record<string, unknown>
) {
  const sources = results.map((result) => ({
    sourceId: result.sourceId,
    url: result.url,
    title: result.title,
    retrievedAt: result.retrievedAt
  }))
  return {
    query,
    provider,
    results,
    sources,
    citations: sources,
    telemetry: toolTelemetry
  }
}

function validateUrlPolicy(rawUrl: string, config: WebCapabilityConfig): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL must be absolute' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https URLs are allowed' }
  }
  const hostname = url.hostname.toLowerCase()
  if (config.denyDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is denied: ${hostname}` }
  }
  if (config.allowDomains.length > 0 && !config.allowDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is not allowed: ${hostname}` }
  }
  return { ok: true, url }
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, '')
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

function extractReadableText(raw: string, contentType: string | undefined): { title?: string; text: string } {
  if (!contentType?.toLowerCase().includes('html')) {
    return { text: normalizeWhitespace(raw) }
  }
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const text = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return {
    ...(title ? { title: normalizeWhitespace(decodeHtmlEntities(title)) } : {}),
    text: normalizeWhitespace(decodeHtmlEntities(text))
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function browserLikeFetchHeaders(url: string): Record<string, string> {
  const parsed = new URL(url)
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: `${parsed.protocol}//${parsed.host}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  }
}

function shouldBackoffFetch(error: unknown): boolean {
  const message = errorMessage(error)
  return message === 'fetch failed' ||
    message.startsWith('HTTP 401') ||
    message.startsWith('HTTP 403') ||
    message.startsWith('HTTP 429')
}

function jinaReaderUrl(baseUrl: string, targetUrl: string): URL {
  const base = new URL(baseUrl)
  if (base.hostname === 'r.jina.ai') {
    const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
    base.pathname = `${prefix}${targetUrl}`
    return base
  }
  base.searchParams.set('url', targetUrl)
  return base
}

async function fetchTextResponse(
  url: string,
  request: { maxBytes: number; timeoutMs: number; signal: AbortSignal },
  headers: Record<string, string>
): Promise<Omit<WebFetchResult, 'sourceId' | 'url' | 'finalUrl' | 'retrievedAt'>> {
  const response = await fetchWithTimeout(url, request, { headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await boundedResponseText(response, request.maxBytes)
  const contentType = response.headers.get('content-type') ?? undefined
  const extracted = extractReadableText(text.text, contentType)
  return {
    title: extracted.title,
    contentType,
    text: extracted.text,
    byteCount: text.byteCount,
    truncated: text.truncated
  }
}

async function fetchJsonResponse(
  url: string,
  request: { timeoutMs: number; signal: AbortSignal },
  init: { method: string; headers: Record<string, string>; body: string }
): Promise<unknown> {
  const response = await fetchWithTimeout(url, request, init)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<unknown>
}

async function fetchWithTimeout(
  url: string,
  request: { timeoutMs: number; signal: AbortSignal },
  init: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
  const onAbort = () => controller.abort()
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', onAbort)
  }
}

async function boundedResponseText(
  response: Response,
  maxBytes: number
): Promise<{ text: string; byteCount: number; truncated: boolean }> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`content exceeds ${maxBytes} byte limit`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('response body is not readable')
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - totalBytes
    if (remaining <= 0) {
      truncated = true
      reader.cancel()
      break
    }
    if (value.length > remaining) {
      chunks.push(value.subarray(0, remaining))
      totalBytes += remaining
      truncated = true
      reader.cancel()
      break
    }
    chunks.push(value)
    totalBytes += value.length
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    byteCount: totalBytes,
    truncated
  }
}

function firecrawlResult(value: unknown): { url?: string; title?: string; text: string } {
  const root = recordValue(value)
  const data = recordValue(root.data)
  const metadata = recordValue(data.metadata)
  const markdown = pickString(data.markdown) ?? pickString(root.markdown)
  const html = pickString(data.html) ?? pickString(root.html)
  const extracted = markdown
    ? { text: markdown }
    : extractReadableText(html ?? '', html ? 'text/html' : 'text/plain')
  return {
    url: pickString(metadata.sourceURL) ?? pickString(data.url),
    title: pickString(metadata.title) ?? extracted.title,
    text: extracted.text
  }
}

function telemetry(input: {
  startedAt: number
  policy: 'allowed' | 'blocked'
  provider?: string
  url?: string
  query?: string
  byteCount?: number
  resultCount?: number
}): Record<string, unknown> {
  return {
    provider: input.provider,
    url: input.url,
    query: input.query,
    byteCount: input.byteCount,
    resultCount: input.resultCount,
    durationMs: Date.now() - input.startedAt,
    cacheStatus: 'miss',
    policy: input.policy
  }
}

function toolError(code: string, message: string, toolTelemetry?: Record<string, unknown>) {
  return {
    output: {
      error: {
        code,
        message
      },
      ...(toolTelemetry ? { telemetry: toolTelemetry } : {})
    },
    isError: true
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'HTTP 401' || message === 'HTTP 403') {
    return `${message}; the target site rejected direct HTTP fetching. Try a public source, official API, reader fallback, or browser/MCP fetch for pages that require normal browser access.`
  }
  if (message === 'HTTP 429') {
    return `${message}; the target site rate-limited direct fetching. Retry later or use a configured search/reader provider.`
  }
  return message
}
