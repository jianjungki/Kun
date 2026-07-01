import { createHash } from 'node:crypto'
import type { TurnItem } from '../contracts/items.js'
import type { ModelRequest } from '../ports/model-client.js'
import type { ThreadRecord } from '../contracts/threads.js'

export type RuntimeCacheEngineMode = ThreadRecord['cacheEngineMode']

export type CacheEngineContext = {
  thread: ThreadRecord
  request: ModelRequest
}

export type CacheEngine = {
  mode: RuntimeCacheEngineMode
  prepareRequest(input: CacheEngineContext): ModelRequest
}

export function createCacheEngine(mode: RuntimeCacheEngineMode): CacheEngine {
  switch (mode) {
    case 'legacy':
      return legacyCacheEngine
    case 'platform':
      return platformCacheEngine
    case 'app':
      return appCacheEngine
    case 'hybrid':
    default:
      return hybridCacheEngine
  }
}

export function resolveCacheEngineMode(
  thread: ThreadRecord | null | undefined,
  fallback: RuntimeCacheEngineMode
): RuntimeCacheEngineMode {
  return thread?.cacheEngineMode ?? fallback
}

export function prepareRequestWithCacheEngine(input: CacheEngineContext, fallback: RuntimeCacheEngineMode): ModelRequest {
  return createCacheEngine(resolveCacheEngineMode(input.thread, fallback)).prepareRequest(input)
}

const legacyCacheEngine: CacheEngine = {
  mode: 'legacy',
  prepareRequest({ request }) {
    return request
  }
}

const platformCacheEngine: CacheEngine = {
  mode: 'platform',
  prepareRequest({ request }) {
    return request
  }
}

const appCacheEngine: CacheEngine = {
  mode: 'app',
  prepareRequest({ request }) {
    return request
  }
}

const hybridCacheEngine: CacheEngine = {
  mode: 'hybrid',
  prepareRequest({ thread, request }) {
    const liveZone = buildLiveZone(request.history)
    const recallZone = buildRecallZone(thread, request.history)
    const requestPrefix = compactPrefix(request.prefix)
    return {
      ...request,
      prefix: requestPrefix,
      history: [...liveZone, ...recallZone],
      contextInstructions: [
        ...(request.contextInstructions ?? []),
        'Cache engine: hybrid.',
        `Thread cache engine: ${thread.cacheEngineMode}`,
        'Frozen prefix stays byte-stable.',
        'Live zone keeps recent turns, recent tool output, and current task state.',
        'Recall zone compresses older volatile content into indexed reminder turns.'
      ]
    }
  }
}

function buildLiveZone(history: readonly TurnItem[]): TurnItem[] {
  return history.slice(-8).map((item) => compactHistoryItem(item))
}

function buildRecallZone(thread: ThreadRecord, history: readonly TurnItem[]): TurnItem[] {
  const older = history.slice(0, Math.max(0, history.length - 8))
  if (older.length === 0) return []
  const digest = digestItems(older)
  const summary = summarizeHistory(older)
  return [
    {
      id: `cache_recall_${thread.id}_${digest.slice(0, 8)}`,
      turnId: history[0]?.turnId ?? thread.id,
      threadId: thread.id,
      role: 'system',
      status: 'completed',
      kind: 'compaction',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary,
      replacedTokens: estimateRecallTokens(older),
      pinnedConstraints: [],
      sourceDigest: digest,
      digestMarker: `cache:${thread.id}:${digest.slice(0, 12)}`,
      sourceItemIds: older.map((item) => item.id).slice(-20)
    } satisfies TurnItem
  ]
}

function compactPrefix(prefix: readonly TurnItem[]): TurnItem[] {
  return prefix.map((item) => compactHistoryItem(item))
}

function compactHistoryItem(item: TurnItem): TurnItem {
  switch (item.kind) {
    case 'user_message':
      return compactUserMessage(item)
    case 'assistant_text':
      return compactAssistantText(item)
    case 'assistant_reasoning':
      return compactAssistantReasoning(item)
    case 'tool_result':
      return compactToolResult(item)
    case 'tool_call':
      return compactToolCall(item)
    default:
      return item
  }
}

function compactUserMessage(item: Extract<TurnItem, { kind: 'user_message' }>): TurnItem {
  return {
    ...item,
    text: truncateText(item.text, 1_200)
  }
}

function compactAssistantText(item: Extract<TurnItem, { kind: 'assistant_text' }>): TurnItem {
  return {
    ...item,
    text: truncateText(item.text, 1_200)
  }
}

function compactAssistantReasoning(item: Extract<TurnItem, { kind: 'assistant_reasoning' }>): TurnItem {
  return {
    ...item,
    text: truncateText(item.text, 800)
  }
}

function compactToolCall(item: Extract<TurnItem, { kind: 'tool_call' }>): TurnItem {
  return {
    ...item,
    summary: item.summary ? truncateText(item.summary, 220) : item.summary,
    arguments: compactJsonObject(item.arguments, 2)
  }
}

function compactToolResult(item: Extract<TurnItem, { kind: 'tool_result' }>): TurnItem {
  return {
    ...item,
    output: compactToolOutput(item.toolName, item.output)
  }
}

function compactToolOutput(toolName: string, output: unknown): unknown {
  if (typeof output === 'string') {
    if (looksLikeCode(output)) return compressCodeText(output)
    if (looksLikeJson(output)) return compressJsonText(output)
    return compressProseText(output)
  }
  if (Array.isArray(output) || isRecord(output)) {
    return compactJsonValue(output, 2)
  }
  return output
}

function compactJsonValue(value: unknown, depth: number): unknown {
  if (depth <= 0) return truncateUnknown(value)
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => compactJsonValue(item, depth - 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === 'description' && typeof child === 'string'
      ? compressProseText(child)
      : compactJsonValue(child, depth - 1)
  }
  return out
}

function compactJsonObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const compacted = compactJsonValue(value, depth)
  return isRecord(compacted) ? compacted : value
}

function truncateUnknown(value: unknown): unknown {
  if (typeof value === 'string') return truncateText(value, 256)
  if (Array.isArray(value)) return value.slice(0, 8)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).slice(0, 8))
}

function compressProseText(text: string): string {
  return truncateText(text.replace(/\s+/g, ' ').trim(), 900)
}

function compressCodeText(text: string): string {
  const lines = text.split('\n')
  const head = lines.slice(0, 80)
  const tail = lines.slice(Math.max(80, lines.length - 20))
  return [...head, ...(lines.length > 100 ? ['...'] : []), ...tail].join('\n')
}

function compressJsonText(text: string): string {
  return truncateText(text.replace(/\s+/g, ' ').trim(), 1_200)
}

function summarizeHistory(items: readonly TurnItem[]): string {
  const parts: string[] = []
  for (const item of items.slice(-12)) {
    switch (item.kind) {
      case 'user_message':
        parts.push(`user: ${truncateText(item.text, 180)}`)
        break
      case 'assistant_text':
        parts.push(`assistant: ${truncateText(item.text, 180)}`)
        break
      case 'tool_result':
        parts.push(`tool:${item.toolName}`)
        break
      case 'compaction':
        parts.push(`memory: ${truncateText(item.summary, 180)}`)
        break
      default:
        break
    }
  }
  return parts.length ? parts.join('\n') : 'Earlier context summarized.'
}

function estimateRecallTokens(items: readonly TurnItem[]): number {
  return Math.max(1, items.length * 120)
}

function digestItems(items: readonly TurnItem[]): string {
  return createHash('sha256').update(JSON.stringify(items.map((item) => ({
    id: item.id,
    kind: item.kind,
    text: 'text' in item && typeof item.text === 'string' ? item.text : undefined,
    summary: 'summary' in item && typeof item.summary === 'string' ? item.summary : undefined
  })))).digest('hex')
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function looksLikeCode(text: string): boolean {
  return /```|function\s+\w+|class\s+\w+|=>|import\s+.+from|const\s+\w+\s*=/.test(text)
}

function truncateText(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
