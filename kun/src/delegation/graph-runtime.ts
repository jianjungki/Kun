import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import type { GraphCapabilityConfig } from '../contracts/capabilities.js'
import type { DelegationRuntime } from './delegation-runtime.js'

export const GraphNodePlan = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  prompt: z.string().min(1),
  label: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  workspace: z.string().min(1).optional(),
  model: z.string().min(1).optional()
}).strict()
export type GraphNodePlan = z.infer<typeof GraphNodePlan>

export const GraphPlan = z.object({
  label: z.string().min(1).optional(),
  nodes: z.array(GraphNodePlan).min(1)
}).strict()
export type GraphPlan = z.infer<typeof GraphPlan>

const GraphNodeRecord = GraphNodePlan.extend({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'aborted', 'skipped']),
  childId: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
}).strict()

export const GraphRunRecord = z.object({
  id: z.string().min(1),
  parentThreadId: z.string().min(1),
  parentTurnId: z.string().min(1),
  label: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'aborted']),
  nodes: z.array(GraphNodeRecord),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict()
export type GraphRunRecord = z.infer<typeof GraphRunRecord>

export class FileGraphStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly rootDir: string) {}

  async upsert(record: GraphRunRecord): Promise<void> {
    const path = join(this.rootDir, `${record.id}.json`)
    const contents = JSON.stringify(record, null, 2)
    const write = this.writeQueue.then(() => atomicWriteFile(path, contents))
    this.writeQueue = write.catch(() => undefined)
    await write
  }

  async get(id: string): Promise<GraphRunRecord | undefined> {
    const text = await readFile(join(this.rootDir, `${id}.json`), 'utf8').catch(() => undefined)
    if (!text) return undefined
    return GraphRunRecord.parse(JSON.parse(text))
  }

  async list(parentThreadId?: string): Promise<GraphRunRecord[]> {
    await mkdir(this.rootDir, { recursive: true })
    const entries = await readdir(this.rootDir).catch(() => [])
    const records = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readFile(join(this.rootDir, entry), 'utf8')
        .then((text) => GraphRunRecord.parse(JSON.parse(text)))
        .catch(() => undefined)))
    return records
      .filter((record): record is GraphRunRecord => Boolean(record))
      .filter((record) => !parentThreadId || record.parentThreadId === parentThreadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

export class GraphRuntime {
  constructor(private readonly options: {
    config: GraphCapabilityConfig
    delegation: DelegationRuntime
    store: FileGraphStore
    nowIso?: () => string
    idGenerator?: () => string
  }) {}

  async run(input: {
    plan: GraphPlan
    parentThreadId: string
    parentTurnId: string
    workspace: string
    model?: string
    signal: AbortSignal
    onUpdate?: (record: GraphRunRecord) => Promise<void> | void
  }): Promise<GraphRunRecord> {
    if (!this.options.config.enabled) throw new Error('graph orchestration is disabled by config')
    const plan = GraphPlan.parse(input.plan)
    validatePlan(plan, this.options.config.maxNodes)
    const now = this.now()
    let record = GraphRunRecord.parse({
      id: this.options.idGenerator?.() ?? `graph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      parentThreadId: input.parentThreadId,
      parentTurnId: input.parentTurnId,
      label: plan.label,
      status: 'running',
      nodes: plan.nodes.map((node) => ({ ...node, status: 'queued' })),
      createdAt: now,
      updatedAt: now
    })
    await this.persist(record, input.onUpdate)

    const running = new Map<string, Promise<void>>()
    const executeNode = async (nodeId: string): Promise<void> => {
      const node = record.nodes.find((candidate) => candidate.id === nodeId)!
      record = updateNode(record, nodeId, { status: 'running', startedAt: this.now() }, this.now())
      await this.persist(record, input.onUpdate)
      const dependencyContext = node.dependsOn
        .map((dependencyId) => {
          const dependency = record.nodes.find((candidate) => candidate.id === dependencyId)!
          return `Dependency ${dependencyId}:\n${dependency.summary ?? '(no summary)'}`
        })
        .join('\n\n')
      const prompt = dependencyContext
        ? `${node.prompt}\n\nCompleted dependency results:\n${dependencyContext}`
        : node.prompt
      try {
        const child = await this.options.delegation.runChild({
          parentThreadId: input.parentThreadId,
          parentTurnId: input.parentTurnId,
          parentWorkspace: input.workspace,
          label: node.label ?? `${plan.label ?? 'graph'}:${node.id}`,
          prompt,
          workspace: node.workspace ?? input.workspace,
          model: node.model ?? input.model,
          signal: input.signal
        })
        const status = child.status === 'completed' ? 'completed' : child.status === 'aborted' ? 'aborted' : 'failed'
        record = updateNode(record, nodeId, {
          status,
          childId: child.id,
          summary: child.summary,
          error: child.error,
          completedAt: this.now()
        }, this.now())
      } catch (error) {
        record = updateNode(record, nodeId, {
          status: input.signal.aborted ? 'aborted' : 'failed',
          error: errorMessage(error),
          completedAt: this.now()
        }, this.now())
      }
      await this.persist(record, input.onUpdate)
    }

    while (record.nodes.some((node) => node.status === 'queued') || running.size > 0) {
      if (input.signal.aborted) {
        record = skipQueued(record, 'parent graph was aborted', 'aborted', this.now())
      } else if (this.options.config.failFast && record.nodes.some((node) => node.status === 'failed' || node.status === 'aborted')) {
        record = skipQueued(record, 'graph stopped after a node failure', 'failed', this.now())
      } else {
        record = skipBlockedNodes(record, this.now())
        const ready = record.nodes.filter((node) =>
          node.status === 'queued' && node.dependsOn.every((dependencyId) =>
            record.nodes.find((candidate) => candidate.id === dependencyId)?.status === 'completed'
          )
        )
        for (const node of ready.slice(0, Math.max(0, this.options.config.maxParallel - running.size))) {
          const task = executeNode(node.id).finally(() => running.delete(node.id))
          running.set(node.id, task)
        }
      }
      if (running.size > 0) await Promise.race(running.values())
      else if (!record.nodes.some((node) => node.status === 'queued')) break
      else throw new Error('graph scheduler stalled after validation')
    }

    const status = input.signal.aborted || record.nodes.some((node) => node.status === 'aborted')
      ? 'aborted'
      : record.nodes.some((node) => node.status === 'failed' || node.status === 'skipped')
        ? 'failed'
        : 'completed'
    record = GraphRunRecord.parse({ ...record, status, updatedAt: this.now() })
    await this.persist(record, input.onUpdate)
    return record
  }

  get(id: string): Promise<GraphRunRecord | undefined> {
    return this.options.store.get(id)
  }

  list(parentThreadId?: string): Promise<GraphRunRecord[]> {
    return this.options.store.list(parentThreadId)
  }

  private async persist(record: GraphRunRecord, onUpdate?: (record: GraphRunRecord) => Promise<void> | void): Promise<void> {
    await this.options.store.upsert(record)
    await onUpdate?.(record)
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString()
  }
}

export function validatePlan(plan: GraphPlan, maxNodes: number): void {
  if (plan.nodes.length > maxNodes) throw new Error(`graph has ${plan.nodes.length} nodes; maximum is ${maxNodes}`)
  const ids = new Set<string>()
  for (const node of plan.nodes) {
    if (ids.has(node.id)) throw new Error(`duplicate graph node id: ${node.id}`)
    ids.add(node.id)
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`graph node ${node.id} depends on unknown node ${dependency}`)
      if (dependency === node.id) throw new Error(`graph node ${node.id} cannot depend on itself`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(plan.nodes.map((node) => [node.id, node]))
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`graph contains a dependency cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
}

function updateNode(
  record: GraphRunRecord,
  nodeId: string,
  patch: Partial<GraphRunRecord['nodes'][number]>,
  updatedAt: string
): GraphRunRecord {
  return GraphRunRecord.parse({
    ...record,
    updatedAt,
    nodes: record.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node)
  })
}

function skipBlockedNodes(record: GraphRunRecord, now: string): GraphRunRecord {
  return GraphRunRecord.parse({
    ...record,
    updatedAt: now,
    nodes: record.nodes.map((node) => {
      if (node.status !== 'queued') return node
      const blockedBy = node.dependsOn.find((dependencyId) => {
        const status = record.nodes.find((candidate) => candidate.id === dependencyId)?.status
        return status === 'failed' || status === 'aborted' || status === 'skipped'
      })
      return blockedBy
        ? { ...node, status: 'skipped', error: `dependency ${blockedBy} did not complete`, completedAt: now }
        : node
    })
  })
}

function skipQueued(
  record: GraphRunRecord,
  reason: string,
  graphStatus: 'failed' | 'aborted',
  now: string
): GraphRunRecord {
  return GraphRunRecord.parse({
    ...record,
    status: graphStatus,
    updatedAt: now,
    nodes: record.nodes.map((node) => node.status === 'queued'
      ? { ...node, status: 'skipped', error: reason, completedAt: now }
      : node)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
