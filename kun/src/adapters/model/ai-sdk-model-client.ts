import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import {
  jsonSchema,
  Output as aiOutput,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet
} from 'ai'
import type { ModelClient, ModelRequest, ModelStreamChunk, ModelToolSpec } from '../../ports/model-client.js'
import type { TurnItem } from '../../contracts/items.js'
import { emptyUsageSnapshot, type UsageSnapshot } from '../../contracts/usage.js'
import type { ModelProviderKind } from '../../contracts/model-provider.js'
import { isToolResultBridgeItem, repairModelHistoryItems } from '../../domain/model-history-repair.js'
import { estimateDeepseekCacheSavings, estimateDeepseekCost } from './deepseek-pricing.js'
import { isDeepSeekHost } from './model-error-probe.js'

export type AiSdkModelClientConfig = {
  providerKind: ModelProviderKind
  providerId?: string
  baseUrl: string
  apiKey: string
  model: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  historyLimit?: number
  nonStreaming?: boolean
  streamIdleTimeoutMs?: number
}

type ToolCallLike = Extract<TurnItem, { kind: 'tool_call' }>
type ToolResultLike = Extract<TurnItem, { kind: 'tool_result' }>
type ModelStopReason = Extract<ModelStreamChunk, { kind: 'completed' }>['stopReason']

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000

export class AiSdkModelClient implements ModelClient {
  readonly provider = 'ai-sdk'
  readonly model: string

  private readonly config: AiSdkModelClientConfig

  constructor(config: AiSdkModelClientConfig) {
    this.config = config
    this.model = config.model
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    if (request.abortSignal.aborted) {
      yield { kind: 'error', message: 'request was aborted before start' }
      return
    }

    const requestModel = request.model?.trim()
    const modelId = requestModel || this.config.model
    const result = streamText({
      model: this.createLanguageModel(modelId),
      messages: this.collectMessages(request, modelId),
      allowSystemInMessages: true,
      tools: buildAiSdkTools(request.tools),
      abortSignal: request.abortSignal,
      maxRetries: 0,
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      reasoning: reasoningForEffort(request.reasoningEffort),
      output: outputForResponseFormat(request.responseFormat),
      timeout: {
        chunkMs: normalizeStreamIdleTimeoutMs(this.config.streamIdleTimeoutMs)
      }
    })

    try {
      for await (const part of result.fullStream) {
        if (request.abortSignal.aborted) {
          yield { kind: 'completed', stopReason: 'error' }
          return
        }
        yield* this.mapStreamPart(part, modelId)
      }
    } catch (error) {
      yield {
        kind: 'error',
        message: `model request failed: ${errorMessage(error)}`
      }
    }
  }

  private createLanguageModel(modelId: string): LanguageModel {
    const baseURL = this.config.baseUrl.trim()
    const apiKey = this.config.apiKey.trim()
    const headers = this.config.headers
    const fetch = this.config.fetchImpl
    switch (this.config.providerKind) {
      case 'openai': {
        const openai = createOpenAI({ apiKey, baseURL, headers, fetch })
        return modelForOpenAiEndpoint(openai, modelId)
      }
      case 'anthropic':
        return createAnthropic({ apiKey, baseURL, headers, fetch })(modelId)
      case 'google':
        return createGoogle({ apiKey, baseURL, headers, fetch })(modelId)
      case 'mistral':
        return createMistral({ apiKey, baseURL, headers, fetch })(modelId)
      case 'xai':
        return createXai({ apiKey, baseURL, headers, fetch })(modelId)
      case 'openai-compatible':
      default:
        return createOpenAICompatible({
          name: this.config.providerId?.trim() || 'openai-compatible',
          apiKey,
          baseURL,
          headers,
          fetch,
          includeUsage: true,
          transformRequestBody: (body) => transformOpenAiCompatibleRequestBody(body, baseURL)
        })(modelId)
    }
  }

  private collectMessages(request: ModelRequest, model: string): ModelMessage[] {
    const out: ModelMessage[] = []
    if (request.systemPrompt) {
      out.push({ role: 'system', content: request.systemPrompt })
    }
    if (request.modeInstruction) {
      out.push({ role: 'system', content: request.modeInstruction })
    }
    for (const instruction of request.contextInstructions ?? []) {
      if (instruction.trim()) out.push({ role: 'system', content: instruction })
    }
    const windowSize = this.config.historyLimit
    const history = windowSize
      ? limitHistoryPreservingCompaction(request.history, windowSize)
      : request.history
    const includeReasoning = shouldRoundTripReasoning(request.reasoningEffort, model, this.config.baseUrl)
    out.push(...itemsToMessages(
      repairModelHistoryItems([...request.prefix, ...history]),
      includeReasoning
    ))
    if (request.attachments?.length) {
      attachImagesToLatestUserMessage(out, request.attachments)
    }
    if (request.attachmentTextFallbacks?.length) {
      attachTextFallbacksToLatestUserMessage(out, request.attachmentTextFallbacks)
    }
    return healToolMessagePairs(out)
  }

  private *mapStreamPart(
    part: TextStreamPart<ToolSet>,
    modelId: string
  ): Iterable<ModelStreamChunk> {
    switch (part.type) {
      case 'text-delta':
        if (part.text) yield { kind: 'assistant_text_delta', text: part.text }
        break
      case 'reasoning-delta':
        if (part.text) yield { kind: 'assistant_reasoning_delta', text: part.text }
        break
      case 'tool-input-start':
        yield { kind: 'tool_call_delta', callId: part.id, toolName: part.toolName }
        break
      case 'tool-input-delta':
        yield { kind: 'tool_call_delta', callId: part.id, argumentsDelta: part.delta }
        break
      case 'tool-call':
        yield {
          kind: 'tool_call_complete',
          callId: part.toolCallId,
          toolName: part.toolName,
          arguments: recordInput(part.input)
        }
        break
      case 'finish':
        yield { kind: 'usage', usage: usageFromAiSdkUsage(part.totalUsage, modelId, this.config.baseUrl) }
        yield { kind: 'completed', stopReason: mapFinishReason(part.finishReason) }
        break
      case 'abort':
        yield { kind: 'completed', stopReason: 'error' }
        break
      case 'error':
        yield { kind: 'error', message: errorMessage(part.error) }
        break
    }
  }
}

function modelForOpenAiEndpoint(
  provider: ReturnType<typeof createOpenAI>,
  modelId: string
): LanguageModel {
  const normalized = modelId.trim().toLowerCase()
  if (normalized.startsWith('gpt-5') || normalized.startsWith('o')) {
    return provider.responses(modelId)
  }
  return provider.chat(modelId)
}

function buildAiSdkTools(tools: ModelToolSpec[]): ToolSet | undefined {
  if (tools.length === 0) return undefined
  const entries = tools.map((spec) => [
    spec.name,
    tool({
      description: spec.description,
      inputSchema: jsonSchema(canonicalizeSchema(spec.inputSchema))
    })
  ])
  return Object.fromEntries(entries) as ToolSet
}

function outputForResponseFormat(
  responseFormat: ModelRequest['responseFormat']
): ReturnType<typeof aiOutput.json> | undefined {
  return responseFormat === 'json_object' ? aiOutput.json() : undefined
}

function itemsToMessages(items: TurnItem[], includeReasoning: boolean): ModelMessage[] {
  const out: ModelMessage[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (isBridgeItemBeforeToolCall(items, index)) continue
    if (includeReasoning && item?.kind === 'assistant_reasoning') {
      const next = items[index + 1]
      if (next?.kind === 'assistant_text' && next.turnId === item.turnId) {
        out.push({
          role: 'assistant',
          content: [
            { type: 'reasoning', text: reasoningContentOrSpace(item.text) },
            { type: 'text', text: next.text }
          ]
        })
        index += 1
      }
      continue
    }
    if (item?.kind === 'tool_call') {
      const block = toolCallBlockToMessages(items, index, includeReasoning)
      if (block) {
        out.push(...block.messages)
        index = block.nextIndex - 1
      }
      continue
    }
    if (item?.kind === 'tool_result') continue
    const message = itemToMessage(item, includeReasoning)
    if (message) out.push(message)
  }
  return out
}

function toolCallBlockToMessages(
  items: TurnItem[],
  startIndex: number,
  includeReasoning: boolean
): { messages: ModelMessage[]; nextIndex: number } | null {
  const calls: ToolCallLike[] = []
  let index = startIndex
  while (index < items.length && items[index]?.kind === 'tool_call') {
    calls.push(items[index] as ToolCallLike)
    index += 1
  }
  if (calls.length === 0) return null

  const turnId = calls[0]?.turnId ?? ''
  const expectedCallIds = new Set(calls.map((call) => call.callId))
  const seenResultIds = new Set<string>()
  const resultParts: Array<Extract<ModelMessage, { role: 'tool' }>['content'][number]> = []
  const assistantText: string[] = []
  const reasoningText: string[] = []
  let bridgeIndex = startIndex - 1
  while (bridgeIndex >= 0) {
    const item = items[bridgeIndex]
    if (!item || !isPreToolCallBridgeItem(item, turnId)) break
    if (item.kind === 'assistant_text' && item.text.trim()) {
      assistantText.unshift(item.text)
    } else if (item.kind === 'assistant_reasoning' && item.text.trim()) {
      reasoningText.unshift(item.text)
    }
    bridgeIndex -= 1
  }
  let sawResult = false
  while (index < items.length) {
    const item = items[index]
    if (!item) break
    if (item.kind === 'tool_result') {
      sawResult = true
      if (expectedCallIds.has(item.callId) && !seenResultIds.has(item.callId)) {
        seenResultIds.add(item.callId)
        resultParts.push(toolResultToPart(item))
      }
      index += 1
      continue
    }
    if (isToolResultBridgeItem(item, { turnId, sawResult })) {
      if (!sawResult) {
        if (item.kind === 'assistant_text' && item.text.trim()) {
          assistantText.push(item.text)
        } else if (item.kind === 'assistant_reasoning' && item.text.trim()) {
          reasoningText.push(item.text)
        }
      }
      index += 1
      continue
    }
    break
  }

  if (![...expectedCallIds].every((callId) => seenResultIds.has(callId))) {
    return null
  }
  const assistantContent: Extract<ModelMessage, { role: 'assistant' }>['content'] = []
  if (includeReasoning) {
    assistantContent.push({ type: 'reasoning', text: reasoningContentOrSpace(reasoningText.join('\n')) })
  }
  assistantContent.push({ type: 'text', text: assistantText.join('\n') })
  assistantContent.push(...calls.map(toolCallToPart))
  return {
    messages: [
      { role: 'assistant', content: assistantContent },
      { role: 'tool', content: resultParts }
    ],
    nextIndex: index
  }
}

function itemToMessage(item: TurnItem, includeReasoning: boolean): ModelMessage | null {
  switch (item.kind) {
    case 'user_message':
      return { role: 'user', content: item.text }
    case 'assistant_text':
      return includeReasoning
        ? { role: 'assistant', content: [{ type: 'reasoning', text: ' ' }, { type: 'text', text: item.text }] }
        : { role: 'assistant', content: item.text }
    case 'assistant_reasoning':
      return null
    case 'tool_call':
      return {
        role: 'assistant',
        content: includeReasoning
          ? [{ type: 'reasoning', text: ' ' }, toolCallToPart(item)]
          : [toolCallToPart(item)]
      }
    case 'tool_result':
      return { role: 'tool', content: [toolResultToPart(item)] }
    case 'compaction':
      return item.replacedTokens > 0
        ? { role: 'system', content: `Conversation summary from earlier turns:\n${item.summary}` }
        : null
    case 'review':
      return item.status === 'completed' && item.reviewText?.trim()
        ? { role: 'system', content: `Code review result from an earlier turn:\n${item.reviewText}` }
        : null
    case 'approval':
    case 'user_input':
    case 'error':
      return null
  }
}

function toolCallToPart(item: ToolCallLike): Extract<
  Extract<ModelMessage, { role: 'assistant' }>['content'],
  unknown[]
>[number] {
  return {
    type: 'tool-call',
    toolCallId: item.callId,
    toolName: item.toolName,
    input: item.arguments
  }
}

function toolResultToPart(item: ToolResultLike): Extract<ModelMessage, { role: 'tool' }>['content'][number] {
  return {
    type: 'tool-result',
    toolCallId: item.callId,
    toolName: item.toolName,
    output: item.isError
      ? { type: 'error-text', value: toolResultContent(item.output) }
      : { type: 'text', value: toolResultContent(item.output) }
  }
}

function healToolMessagePairs(messages: ModelMessage[]): ModelMessage[] {
  const healed: ModelMessage[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role === 'tool') continue
    if (message.role === 'assistant') {
      const callIds = assistantToolCallIds(message)
      if (callIds.length > 0) {
        const expectedIds = new Set(callIds)
        const toolResults: Extract<ModelMessage, { role: 'tool' }>['content'] = []
        let j = i + 1
        while (j < messages.length && messages[j].role === 'tool') {
          for (const result of (messages[j] as Extract<ModelMessage, { role: 'tool' }>).content) {
            if (result.type === 'tool-result' && expectedIds.has(result.toolCallId)) {
              toolResults.push(result)
            }
          }
          j += 1
        }
        const seenIds = new Set(toolResults.map((result) => result.type === 'tool-result' ? result.toolCallId : ''))
        if ([...expectedIds].every((id) => seenIds.has(id))) {
          healed.push(message, { role: 'tool', content: toolResults })
        }
        i = j - 1
        continue
      }
    }
    healed.push(message)
  }
  return healed
}

function assistantToolCallIds(message: Extract<ModelMessage, { role: 'assistant' }>): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((part): part is Extract<typeof part, { type: 'tool-call' }> => part.type === 'tool-call')
    .map((part) => part.toolCallId)
}

function attachImagesToLatestUserMessage(
  messages: ModelMessage[],
  attachments: NonNullable<ModelRequest['attachments']>
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const parts: Extract<ModelMessage, { role: 'user' }>['content'] = []
    if (typeof message.content === 'string' && message.content) {
      parts.push({ type: 'text', text: message.content })
    } else if (Array.isArray(message.content)) {
      parts.push(...message.content)
    }
    for (const attachment of attachments) {
      parts.push({
        type: 'file',
        mediaType: attachment.mimeType,
        filename: attachment.name,
        data: { type: 'data', data: attachment.dataBase64 }
      })
    }
    message.content = parts
    return
  }
}

function attachTextFallbacksToLatestUserMessage(
  messages: ModelMessage[],
  attachments: NonNullable<ModelRequest['attachmentTextFallbacks']>
): void {
  const text = attachments.map(formatAttachmentTextFallback).join('\n\n')
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      message.content = message.content ? `${message.content}\n\n${text}` : text
      return
    }
    if (Array.isArray(message.content)) {
      message.content.push({ type: 'text', text })
      return
    }
  }
}

function formatAttachmentTextFallback(
  attachment: NonNullable<ModelRequest['attachmentTextFallbacks']>[number]
): string {
  return [
    '[Attached image as base64 text]',
    `Name: ${attachment.name}`,
    `MIME: ${attachment.mimeType}`,
    `Dimensions: ${formatAttachmentDimensions(attachment)}`,
    `Bytes: ${attachment.byteSize}`,
    'Base64:',
    '```base64',
    attachment.dataBase64,
    '```',
    '[/Attached image]'
  ].join('\n')
}

function usageFromAiSdkUsage(usage: LanguageModelUsage, modelId: string, baseUrl: string): UsageSnapshot {
  const promptTokens = Math.max(0, Math.floor(usage.inputTokens ?? 0))
  const completionTokens = Math.max(0, Math.floor(usage.outputTokens ?? 0))
  const totalTokens = Math.max(0, Math.floor(usage.totalTokens ?? promptTokens + completionTokens))
  const cacheHitTokens = positiveOptional(usage.inputTokenDetails.cacheReadTokens)
  const cacheMissTokens = positiveOptional(usage.inputTokenDetails.noCacheTokens)
  const cachedTokens = cacheHitTokens
  const cacheHitRate = promptTokens > 0 && cacheHitTokens !== undefined
    ? Math.max(0, Math.min(1, cacheHitTokens / promptTokens))
    : null
  const snapshot: UsageSnapshot = {
    ...emptyUsageSnapshot(),
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate,
    turns: 1
  }
  if (isDeepSeekHost(baseUrl)) {
    const cost = estimateDeepseekCost({
      model: modelId,
      cacheMissTokens: cacheMissTokens ?? Math.max(0, promptTokens - (cacheHitTokens ?? 0)),
      outputTokens: completionTokens,
      cacheHitTokens: cacheHitTokens ?? 0,
      providerHost: baseUrl
    })
    const savings = estimateDeepseekCacheSavings({
      model: modelId,
      cacheHitTokens: cacheHitTokens ?? 0,
      providerHost: baseUrl
    })
    if (cost) {
      snapshot.costUsd = cost.costUsd
      snapshot.costCny = cost.costCny
    }
    if (savings) {
      snapshot.cacheSavingsUsd = savings.costUsd
      snapshot.cacheSavingsCny = savings.costCny
    }
  }
  return snapshot
}

function transformOpenAiCompatibleRequestBody(
  body: Record<string, unknown>,
  baseUrl: string
): Record<string, unknown> {
  if (!isDeepSeekHost(baseUrl)) return body
  const model = typeof body.model === 'string' ? body.model : ''
  if (!isThinkingProducerModel(model)) return body
  const next = { ...body }
  if (next.reasoning_effort === 'none') {
    delete next.reasoning_effort
    next.thinking = { type: 'disabled' }
    return next
  }
  if (!Object.prototype.hasOwnProperty.call(next, 'thinking')) {
    next.thinking = { type: 'enabled' }
  }
  return next
}

function reasoningForEffort(effort: string | undefined): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  const normalized = effort?.trim().toLowerCase()
  switch (normalized) {
    case 'off':
    case 'disabled':
    case 'none':
    case 'false':
      return 'none'
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
    case 'mid':
      return 'medium'
    case 'high':
      return 'high'
    case 'max':
    case 'maximum':
    case 'xhigh':
      return 'xhigh'
    default:
      return undefined
  }
}

function shouldRoundTripReasoning(
  effort: string | undefined,
  model: string | undefined,
  baseUrl: string
): boolean {
  return isThinkingMode(effort) || (isDeepSeekHost(baseUrl) && isThinkingProducerModel(model))
}

function isThinkingMode(effort: string | undefined): boolean {
  const normalized = effort?.trim().toLowerCase()
  if (!normalized) return false
  return !['off', 'disabled', 'none', 'false'].includes(normalized)
}

function isThinkingProducerModel(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase() ?? ''
  if (!normalized) return false
  return normalized === 'deepseek-v4-pro' ||
    normalized === 'deepseek-v4-flash' ||
    normalized.includes('deepseek-reasoner') ||
    normalized.endsWith('/deepseek-v4-pro') ||
    normalized.endsWith('/deepseek-v4-flash')
}

function mapFinishReason(reason: string | undefined): ModelStopReason {
  switch (reason) {
    case 'tool-calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'error':
      return 'error'
    default:
      return 'stop'
  }
}

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function positiveOptional(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function canonicalizeSchema(value: unknown): Record<string, unknown> {
  const canonical = canonicalize(value)
  return canonical && typeof canonical === 'object' && !Array.isArray(canonical)
    ? canonical as Record<string, unknown>
    : {}
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return out
}

function toolResultContent(output: unknown): string {
  if (typeof output === 'string') return output
  return JSON.stringify(output) ?? ''
}

function reasoningContentOrSpace(text: string): string {
  return text.trim() ? text : ' '
}

function isPreToolCallBridgeItem(item: TurnItem, turnId: string): boolean {
  if (item.turnId !== turnId) return false
  return item.kind === 'assistant_reasoning' || item.kind === 'assistant_text'
}

function isBridgeItemBeforeToolCall(items: TurnItem[], index: number): boolean {
  const item = items[index]
  if (!item || (item.kind !== 'assistant_reasoning' && item.kind !== 'assistant_text')) {
    return false
  }
  let cursor = index + 1
  while (cursor < items.length) {
    const next = items[cursor]
    if (!next) return false
    if (next.kind === 'assistant_reasoning' || next.kind === 'assistant_text') {
      if (next.turnId !== item.turnId) return false
      cursor += 1
      continue
    }
    return next.kind === 'tool_call' && next.turnId === item.turnId
  }
  return false
}

function limitHistoryPreservingCompaction(history: TurnItem[], windowSize: number): TurnItem[] {
  if (history.length <= windowSize) return history
  const windowStart = history.length - windowSize
  const limited = history.slice(windowStart)
  if (limited.some((item) => item.kind === 'compaction' && item.replacedTokens > 0)) {
    return limited
  }
  for (let index = windowStart - 1; index >= 0; index -= 1) {
    const item = history[index]
    if (item.kind !== 'compaction' || item.replacedTokens === 0) continue
    return windowSize <= 1 ? [item] : [item, ...history.slice(-(windowSize - 1))]
  }
  return limited
}

function formatAttachmentDimensions(
  attachment: NonNullable<ModelRequest['attachmentTextFallbacks']>[number]
): string {
  return attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : 'unknown'
}

function normalizeStreamIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(value)) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  return Math.max(0, Math.floor(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
