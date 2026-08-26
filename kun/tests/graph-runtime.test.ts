import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { FileGraphStore, GraphRuntime, validatePlan } from '../src/delegation/graph-runtime.js'
import type { DelegationRuntime } from '../src/delegation/delegation-runtime.js'

describe('GraphRuntime', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pengcodex-graph-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('validates node limits, missing dependencies, and cycles', () => {
    expect(() => validatePlan({ nodes: [{ id: 'a', prompt: 'a', dependsOn: [] }] }, 0)).toThrow(/maximum/)
    expect(() => validatePlan({ nodes: [{ id: 'a', prompt: 'a', dependsOn: ['b'] }] }, 2)).toThrow(/unknown/)
    expect(() => validatePlan({
      nodes: [
        { id: 'a', prompt: 'a', dependsOn: ['b'] },
        { id: 'b', prompt: 'b', dependsOn: ['a'] }
      ]
    }, 2)).toThrow(/cycle/)
  })

  it('runs ready nodes with bounded concurrency and persists dependency summaries', async () => {
    let active = 0
    let maxActive = 0
    const runChild = vi.fn(async (input: { prompt: string }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return {
        id: `child_${runChild.mock.calls.length}`,
        status: 'completed' as const,
        summary: `done: ${input.prompt}`
      }
    })
    const runtime = createRuntime(root, runChild)
    const result = await runtime.run({
      plan: {
        label: 'build',
        nodes: [
          { id: 'a', prompt: 'A', dependsOn: [] },
          { id: 'b', prompt: 'B', dependsOn: [] },
          { id: 'c', prompt: 'C', dependsOn: ['a', 'b'] }
        ]
      },
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      workspace: root,
      signal: new AbortController().signal
    })

    expect(result.status).toBe('completed')
    expect(maxActive).toBe(2)
    expect(runChild.mock.calls[2]?.[0].prompt).toContain('Dependency a:')
    expect((await runtime.get(result.id))?.nodes.every((node) => node.status === 'completed')).toBe(true)
  })

  it('skips downstream nodes after a dependency failure', async () => {
    const runChild = vi.fn(async (input: { prompt: string }) => ({
      id: `child_${input.prompt}`,
      status: input.prompt === 'fail' ? 'failed' as const : 'completed' as const,
      summary: input.prompt,
      ...(input.prompt === 'fail' ? { error: 'failed intentionally' } : {})
    }))
    const runtime = createRuntime(root, runChild)
    const result = await runtime.run({
      plan: {
        nodes: [
          { id: 'a', prompt: 'fail', dependsOn: [] },
          { id: 'b', prompt: 'blocked', dependsOn: ['a'] }
        ]
      },
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      workspace: root,
      signal: new AbortController().signal
    })

    expect(result.status).toBe('failed')
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', status: 'failed' }),
      expect.objectContaining({ id: 'b', status: 'skipped' })
    ]))
    expect(runChild).toHaveBeenCalledTimes(1)
  })
})

function createRuntime(root: string, runChild: ReturnType<typeof vi.fn>): GraphRuntime {
  const config = KunCapabilitiesConfig.parse({
    graph: { enabled: true, maxParallel: 2, maxNodes: 8 }
  }).graph
  return new GraphRuntime({
    config,
    delegation: { runChild } as unknown as DelegationRuntime,
    store: new FileGraphStore(root),
    idGenerator: () => 'graph_test',
    nowIso: () => '2026-08-18T00:00:00.000Z'
  })
}
