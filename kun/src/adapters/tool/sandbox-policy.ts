import type { SandboxMode } from '../../contracts/policy.js'
import { DEFAULT_SANDBOX_MODE, SandboxModeSchema } from '../../contracts/policy.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'

export type SandboxBlock = {
  code: 'sandbox_read_only' | 'sandbox_command_blocked'
  message: string
}

export function effectiveSandboxMode(
  context?: Pick<ToolHostContext, 'sandboxMode'>
): SandboxMode {
  const parsed = SandboxModeSchema.safeParse(context?.sandboxMode)
  return parsed.success ? parsed.data : DEFAULT_SANDBOX_MODE
}

export function sandboxBlockForTool(
  tool: Pick<LocalTool, 'name' | 'toolKind'>,
  context?: Pick<ToolHostContext, 'sandboxMode'>
): SandboxBlock | null {
  if (!context) return null
  const mode = effectiveSandboxMode(context)

  if (mode === 'read-only' && tool.toolKind === 'file_change') {
    return {
      code: 'sandbox_read_only',
      message: `tool ${tool.name} cannot modify files in read-only sandbox mode`
    }
  }

  if (
    tool.toolKind === 'command_execution' &&
    (mode === 'read-only' || mode === 'workspace-write')
  ) {
    return {
      code: 'sandbox_command_blocked',
      message: `tool ${tool.name} requires external-sandbox or danger-full-access because plain shell commands cannot be confined reliably`
    }
  }

  return null
}

export function isToolAllowedInSandbox(
  tool: Pick<LocalTool, 'name' | 'toolKind'>,
  context?: Pick<ToolHostContext, 'sandboxMode'>
): boolean {
  return sandboxBlockForTool(tool, context) === null
}
