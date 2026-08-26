import { GraphPlan, type GraphRuntime } from '../../delegation/graph-runtime.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { withToolBoundary } from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'

export function buildGraphToolProviders(runtime: GraphRuntime | undefined): CapabilityToolProvider[] {
  if (!runtime) return []
  return [{
    id: 'graph',
    kind: 'graph',
    enabled: true,
    available: true,
    tools: [
      LocalToolHost.defineTool({
        name: 'run_task_graph',
        description: 'Run a validated bounded DAG of child-agent tasks. Dependency summaries are passed to downstream nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            nodes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  prompt: { type: 'string' },
                  label: { type: 'string' },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  workspace: { type: 'string' },
                  model: { type: 'string' }
                },
                required: ['id', 'prompt'],
                additionalProperties: false
              }
            }
          },
          required: ['nodes'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: (args, context, onUpdate) => withToolBoundary(async () => {
          const plan = GraphPlan.parse(args)
          const record = await runtime.run({
            plan,
            parentThreadId: context.threadId,
            parentTurnId: context.turnId,
            workspace: context.workspace,
            model: context.model?.id,
            signal: context.abortSignal,
            onUpdate: async (update) => {
              await onUpdate?.({ output: summarizeGraph(update) })
            }
          })
          return {
            output: summarizeGraph(record),
            isError: record.status === 'failed' || record.status === 'aborted'
          }
        })
      }),
      LocalToolHost.defineTool({
        name: 'graph_status',
        description: 'Read a persisted task graph by id, or list recent graphs for the current thread.',
        inputSchema: {
          type: 'object',
          properties: { graphId: { type: 'string' } },
          additionalProperties: false
        },
        policy: 'auto',
        execute: (args, context) => withToolBoundary(async () => {
          if (typeof args.graphId === 'string' && args.graphId.trim()) {
            const record = await runtime.get(args.graphId.trim())
            if (!record || record.parentThreadId !== context.threadId) throw new Error('graph not found for this thread')
            return { output: summarizeGraph(record) }
          }
          return { output: { graphs: (await runtime.list(context.threadId)).map(summarizeGraph) } }
        })
      })
    ]
  }]
}

function summarizeGraph(record: Awaited<ReturnType<GraphRuntime['run']>>) {
  return {
    graphId: record.id,
    label: record.label,
    status: record.status,
    nodes: record.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      childId: node.childId,
      summary: node.summary,
      error: node.error,
      dependsOn: node.dependsOn
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}
