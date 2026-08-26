import { z } from 'zod'

export const EXTENSION_MANIFEST_FILENAME = 'pengcodex-extension.json'
export const EXTENSION_MANIFEST_VERSION = 1

const ExtensionToolManifest = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  description: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  cwd: z.enum(['workspace', 'extension']).default('workspace'),
  output: z.enum(['json', 'text']).default('json'),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  env: z.record(z.string(), z.string()).default({})
}).strict()

export const ExtensionManifest = z.object({
  manifestVersion: z.literal(EXTENSION_MANIFEST_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  tools: z.array(ExtensionToolManifest).min(1)
}).strict().superRefine((manifest, context) => {
  const names = new Set<string>()
  for (const [index, tool] of manifest.tools.entries()) {
    const normalized = tool.name.toLowerCase()
    if (names.has(normalized)) {
      context.addIssue({ code: 'custom', path: ['tools', index, 'name'], message: `duplicate extension tool name: ${tool.name}` })
    }
    names.add(normalized)
    if (tool.inputSchema.type !== undefined && tool.inputSchema.type !== 'object') {
      context.addIssue({ code: 'custom', path: ['tools', index, 'inputSchema', 'type'], message: 'extension tool inputSchema must describe an object' })
    }
  }
})
export type ExtensionManifest = z.infer<typeof ExtensionManifest>

export function extensionToolName(extensionId: string, toolName: string): string {
  return `ext_${slug(extensionId)}_${slug(toolName)}`
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}
