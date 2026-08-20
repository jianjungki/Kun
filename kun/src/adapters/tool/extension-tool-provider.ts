import type { ExtensionRuntime } from '../../extensions/extension-runtime.js'
import { extensionToolName } from '../../extensions/extension-manifest.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { withToolBoundary } from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'

export function buildExtensionToolProviders(runtime: ExtensionRuntime | undefined): CapabilityToolProvider[] {
  if (!runtime) return []
  const tools = runtime.extensions.flatMap((extension) => extension.manifest.tools.map((tool) =>
    LocalToolHost.defineTool({
      name: extensionToolName(extension.manifest.id, tool.name),
      description: `[${extension.manifest.name}] ${tool.description}`,
      inputSchema: tool.inputSchema,
      toolKind: 'command_execution',
      policy: 'on-request',
      shouldAdvertise: (context) => runtime.isWorkspaceTrusted(context.workspace),
      execute: (args, context) => withToolBoundary(async () => ({
        output: await runtime.execute(extension, tool, args, context)
      }))
    })
  ))
  return [{
    id: 'extensions',
    kind: 'extension',
    enabled: true,
    available: tools.length > 0,
    ...(tools.length === 0 ? { reason: 'no trusted extension command tools were loaded' } : {}),
    tools
  }]
}
