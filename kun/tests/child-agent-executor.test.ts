import { describe, expect, it } from 'vitest'

import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import {
  LocalToolHost,
  requestUserInputTool
} from '../src/adapters/tool/local-tool-host.js'
import { createImmutablePrefix } from '../src/cache/immutable-prefix.js'
import { createChildAgentExecutor } from '../src/delegation/child-agent-executor.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'

function model(chunks: ModelStreamChunk[], seen: ModelRequest[] = []): ModelClient {
  return {
    provider: 'child-test',
    model: 'child-test',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      seen.push(request)
      for (const chunk of chunks) yield chunk
    }
  }
}

describe('child agent executor', () => {
  it('runs a real child AgentLoop and returns assistant summary plus usage', async () => {
    const seen: ModelRequest[] = []
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'child ' },
        { kind: 'assistant_text_delta', text: 'answer' },
        {
          kind: 'usage',
          usage: {
            promptTokens: 11,
            completionTokens: 3,
            totalTokens: 14,
            cacheHitTokens: 5,
            cacheMissTokens: 6,
            cacheHitRate: 5 / 11,
            cachedTokens: 5,
            turns: 1,
            costUsd: 0.001,
            cacheSavingsUsd: 0.0002
          }
        },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_1',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      label: 'research',
      prompt: 'Research the issue',
      workspace: '/tmp/project',
      signal: new AbortController().signal
    })

    expect(result.summary).toBe('child answer')
    expect(result.usage).toMatchObject({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
      cacheHitTokens: 5,
      cacheSavingsUsd: 0.0002,
      turns: 1
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      threadId: 'child_1',
      model: 'child-test',
      systemPrompt: 'child system',
      history: [
        expect.objectContaining({
          kind: 'user_message',
          text: 'Research the issue'
        })
      ]
    })
    expect(seen[0]?.tools).toEqual([])
  })

  it('fails the child run when the child loop cannot produce a completed turn', async () => {
    const executor = createChildAgentExecutor({
      model: model([{ kind: 'error', message: 'model failed', code: 'bad_model' }]),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await expect(executor({
      childId: 'child_fail',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Fail',
      signal: new AbortController().signal
    })).rejects.toThrow(/child agent failed|model failed/i)
  })

  it('settles approval and user-input requests without waiting for interactive gates', async () => {
    let streamCalls = 0
    let sensitiveToolRuns = 0
    const sensitiveTool = LocalToolHost.defineTool({
      name: 'sensitive_action',
      description: 'A tool that requires explicit approval.',
      inputSchema: { type: 'object' },
      policy: 'on-request',
      execute: async () => {
        sensitiveToolRuns += 1
        return { output: { ok: true } }
      }
    })
    const executor = createChildAgentExecutor({
      model: {
        provider: 'child-test',
        model: 'child-test',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          streamCalls += 1
          if (streamCalls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_approval',
              toolName: 'sensitive_action',
              arguments: {}
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          if (streamCalls === 2) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_input',
              toolName: 'request_user_input',
              arguments: { prompt: 'Choose a value' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      toolHost: new LocalToolHost({ tools: [sensitiveTool, requestUserInputTool] }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      approvalPolicy: 'on-request',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const execution = executor({
      childId: 'child_non_interactive',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Run both gated actions',
      signal: new AbortController().signal
    })
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('child executor waited for an interactive gate')), 1_000).unref()
    })

    await expect(Promise.race([execution, timeout])).rejects.toThrow(
      /child agents cannot request interactive user input/i
    )
    expect(streamCalls).toBe(2)
    expect(sensitiveToolRuns).toBe(0)
  })
})
