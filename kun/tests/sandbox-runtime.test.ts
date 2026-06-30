import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import {
  configForSandboxMode,
  createBashLocalTool,
  createSandboxRuntimeBashOperations,
  type AnthropicSandboxManagerLike,
  type SandboxRuntimeConfig
} from '../src/adapters/tool/builtin-tools.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

function buildContext(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_sandbox',
    turnId: 'turn_sandbox',
    workspace,
    approvalPolicy: 'on-request',
    sandboxMode: 'external-sandbox',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function nodeArgv(script: string): string[] {
  return [process.execPath, '-e', script]
}

describe('sandbox-runtime bash backend', () => {
  it('runs bash commands through the Windows SandboxManager path and modifies workspace files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-sandbox-runtime-'))
    const calls: Array<{ kind: string; config?: SandboxRuntimeConfig; command?: string; binShell?: string }> = []
    const manager: AnthropicSandboxManagerLike = {
      initialize: async (config) => {
        calls.push({ kind: 'initialize', config })
      },
      wrapWithSandboxArgv: async (command, binShell, config) => {
        calls.push({ kind: 'wrap', config: config as SandboxRuntimeConfig, command, binShell })
        return {
          argv: nodeArgv([
            "const { writeFileSync } = require('node:fs')",
            "writeFileSync('sandbox-edited.txt', 'changed in sandbox\\n')",
            "process.stdout.write('sandbox stdout\\n')"
          ].join(';')),
          env: process.env
        }
      },
      reset: async () => {
        calls.push({ kind: 'reset' })
      }
    }
    const host = new LocalToolHost({
      tools: [
        createBashLocalTool({
          sandbox: createSandboxRuntimeBashOperations({ manager, platform: 'win32' })
        })
      ]
    })

    try {
      const result = await host.execute(
        {
          callId: 'call_sandbox_bash',
          toolName: 'bash',
          arguments: { command: 'echo edited > sandbox-edited.txt' }
        },
        buildContext(workspace)
      )

      expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
      const disk = await readFile(join(workspace, 'sandbox-edited.txt'), 'utf8')
      expect(disk).toBe('changed in sandbox\n')
      expect(calls.map((call) => call.kind)).toEqual(['initialize', 'wrap', 'reset'])
      expect(calls[0]?.config?.filesystem.allowWrite).toEqual([])
      expect(String(calls[1]?.command)).toBe('echo edited > sandbox-edited.txt')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('uses Windows-compatible ACL/WFP config without allow-only filesystem rules', () => {
    const config = configForSandboxMode(
      { sandboxMode: 'external-sandbox' },
      'C:\\work\\project',
      'win32'
    )

    expect(config.network).toEqual({ allowedDomains: [], deniedDomains: [] })
    expect(config.filesystem).toEqual({
      denyRead: [],
      allowWrite: [],
      denyWrite: []
    })
  })

  it('keeps workspace write allow-list semantics for Bubblewrap platforms', () => {
    const config = configForSandboxMode(
      { sandboxMode: 'external-sandbox' },
      '/tmp/project',
      'linux'
    )

    expect(config.filesystem.allowRead).toEqual(['/tmp/project'])
    expect(config.filesystem.allowWrite).toEqual(['/tmp/project'])
  })
})
