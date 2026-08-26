import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeUserItem } from '../src/domain/item.js'
import { AiSdkModelClient } from '../src/adapters/model/ai-sdk-model-client.js'
import type { ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'

const mockState = vi.hoisted(() => ({
  streamText: vi.fn(),
  parts: [] as Array<Record<string, unknown>>,
  openAiCompatibleConfig: undefined as Record<string, unknown> | undefined,
  openAiConfig: undefined as Record<string, unknown> | undefined,
  openAiProvider: undefined as { chat: ReturnType<typeof vi.fn>; responses: ReturnType<typeof vi.fn> } | undefined
}))

vi.mock('ai', () => ({
  jsonSchema: vi.fn((schema: unknown) => ({ kind: 'json-schema', schema })),
  Output: {
    json: vi.fn(() => ({ kind: 'output-json' }))
  },
  streamText: mockState.streamText,
  tool: vi.fn((spec: unknown) => ({ kind: 'tool', spec }))
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((config: Record<string, unknown>) => {
    mockState.openAiCompatibleConfig = config
    return (modelId: string) => ({
      providerKind: 'openai-compatible',
      modelId
    })
  })
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((config: Record<string, unknown>) => {
    mockState.openAiConfig = config
    const provider = {
      chat: vi.fn((modelId: string) => ({ providerKind: 'openai-chat', modelId })),
      responses: vi.fn((modelId: string) => ({ providerKind: 'openai-responses', modelId }))
    }
    mockState.openAiProvider = provider
    return provider
  })
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ providerKind: 'anthropic', modelId }))
}))

vi.mock('@ai-sdk/google', () => ({
  createGoogle: vi.fn(() => (modelId: string) => ({ providerKind: 'google', modelId }))
}))

vi.mock('@ai-sdk/mistral', () => ({
  createMistral: vi.fn(() => (modelId: string) => ({ providerKind: 'mistral', modelId }))
}))

vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn(() => (modelId: string) => ({ providerKind: 'xai', modelId }))
}))

function buildRequest(): ModelRequest {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    model: 'request-model',
    systemPrompt: 'You are a helpful assistant.',
    modeInstruction: 'Use agent mode.',
    contextInstructions: ['Use active skill guidance.'],
    prefix: [],
    history: [
      makeUserItem({
        id: 'user_1',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'Hello'
      })
    ],
    tools: [
      {
        name: 'echo',
        description: 'Echo input.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        }
      }
    ],
    abortSignal: new AbortController().signal
  }
}

async function collect(chunks: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const out: ModelStreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

async function *mockFullStream(): AsyncIterable<Record<string, unknown>> {
  for (const part of mockState.parts) yield part
}

function usage(inputTokens = 4, outputTokens = 6): Record<string, unknown> {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: Math.max(inputTokens - 1, 0),
      cacheReadTokens: inputTokens > 0 ? 1 : 0,
      cacheWriteTokens: undefined
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined
    },
    totalTokens: inputTokens + outputTokens
  }
}

beforeEach(() => {
  mockState.parts = []
  mockState.openAiCompatibleConfig = undefined
  mockState.openAiConfig = undefined
  mockState.openAiProvider = undefined
  mockState.streamText.mockReset()
  mockState.streamText.mockImplementation((options: unknown) => ({
    options,
    fullStream: mockFullStream()
  }))
})

describe('AiSdkModelClient', () => {
  it('maps AI SDK stream parts to ModelStreamChunk values', async () => {
    mockState.parts = [
      { type: 'text-delta', text: 'Hi' },
      { type: 'reasoning-delta', text: 'Thinking' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'echo' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"text":"ok"}' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'echo', input: { text: 'ok' } },
      { type: 'finish', finishReason: 'tool-calls', totalUsage: usage() }
    ]
    const client = new AiSdkModelClient({
      providerKind: 'openai-compatible',
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'key',
      model: 'default-model'
    })

    const chunks = await collect(client.stream(buildRequest()))

    expect(chunks).toEqual([
      { kind: 'assistant_text_delta', text: 'Hi' },
      { kind: 'assistant_reasoning_delta', text: 'Thinking' },
      { kind: 'tool_call_delta', callId: 'call_1', toolName: 'echo' },
      { kind: 'tool_call_delta', callId: 'call_1', argumentsDelta: '{"text":"ok"}' },
      { kind: 'tool_call_complete', callId: 'call_1', toolName: 'echo', arguments: { text: 'ok' } },
      {
        kind: 'usage',
        usage: expect.objectContaining({
          promptTokens: 4,
          completionTokens: 6,
          totalTokens: 10,
          cacheHitTokens: 1,
          cacheMissTokens: 3
        })
      },
      { kind: 'completed', stopReason: 'tool_calls' }
    ])
  })

  it('passes provider, model, messages, and tool schemas into streamText', async () => {
    mockState.parts = [{ type: 'finish', finishReason: 'stop', totalUsage: usage(0, 0) }]
    const client = new AiSdkModelClient({
      providerKind: 'openai-compatible',
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'key',
      model: 'default-model'
    })
    const request = buildRequest()
    request.maxTokens = 128
    request.temperature = 0
    request.topP = 0.5
    request.reasoningEffort = 'high'
    request.responseFormat = 'json_object'

    await collect(client.stream(request))

    expect(mockState.openAiCompatibleConfig).toMatchObject({
      name: 'openrouter',
      apiKey: 'key',
      baseURL: 'https://openrouter.ai/api/v1',
      includeUsage: true
    })
    expect(mockState.streamText).toHaveBeenCalledTimes(1)
    const options = mockState.streamText.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).toMatchObject({
      allowSystemInMessages: true,
      maxRetries: 0,
      maxOutputTokens: 128,
      temperature: 0,
      topP: 0.5,
      reasoning: 'high',
      output: { kind: 'output-json' }
    })
    expect(options.model).toEqual({
      providerKind: 'openai-compatible',
      modelId: 'request-model'
    })
    expect(options.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'system', content: 'Use agent mode.' },
      { role: 'system', content: 'Use active skill guidance.' },
      { role: 'user', content: 'Hello' }
    ])
    expect(options.tools).toMatchObject({
      echo: {
        kind: 'tool',
        spec: {
          description: 'Echo input.',
          inputSchema: {
            kind: 'json-schema',
            schema: expect.objectContaining({ type: 'object' })
          }
        }
      }
    })
  })

  it('keeps DeepSeek thinking request transforms scoped to the official host', async () => {
    mockState.parts = [{ type: 'finish', finishReason: 'stop', totalUsage: usage(0, 0) }]
    const client = new AiSdkModelClient({
      providerKind: 'openai-compatible',
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'key',
      model: 'deepseek-v4-pro'
    })

    await collect(client.stream(buildRequest()))

    const transform = mockState.openAiCompatibleConfig?.transformRequestBody as
      | ((body: Record<string, unknown>) => Record<string, unknown>)
      | undefined
    expect(transform).toBeTypeOf('function')
    expect(transform?.({ model: 'deepseek-v4-pro', reasoning_effort: 'none' })).toEqual({
      model: 'deepseek-v4-pro',
      thinking: { type: 'disabled' }
    })
    expect(transform?.({ model: 'deepseek-v4-pro' })).toEqual({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled' }
    })
  })

  it('uses OpenAI responses models for GPT-5 and o-series ids', async () => {
    mockState.parts = [{ type: 'finish', finishReason: 'stop', totalUsage: usage(0, 0) }]
    const client = new AiSdkModelClient({
      providerKind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      model: 'gpt-5-mini'
    })
    const request = buildRequest()
    request.model = 'gpt-5-mini'

    await collect(client.stream(request))

    expect(mockState.openAiConfig).toMatchObject({
      apiKey: 'key',
      baseURL: 'https://api.openai.com/v1'
    })
    expect(mockState.openAiProvider?.responses).toHaveBeenCalledWith('gpt-5-mini')
    expect(mockState.openAiProvider?.chat).not.toHaveBeenCalled()
  })
})
