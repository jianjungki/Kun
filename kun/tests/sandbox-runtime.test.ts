import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { createBashLocalTool } from '../src/adapters/tool/builtin-tools.js'
import {
  configForSandboxMode,
  createSandboxRuntimeBashOperations,
  type AnthropicSandboxManagerLike,
  type SandboxRuntimeConfig
} from '../src/adapters/tool/sandbox-runtime.js'
import type { SandboxMode } from '../src/contracts/policy.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

function buildContext(workspace: string, sandboxMode: SandboxMode = 'external-sandbox'): ToolHostContext {
  return {
    threadId: 'thr_sandbox',
    turnId: 'turn_sandbox',
    workspace,
    approvalPolicy: 'on-request',
    sandboxMode,
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

async function executeBash(host: LocalToolHost, workspace: string, command: string) {
  const result = await host.execute(
    {
      callId: 'call_sandbox_bash',
      toolName: 'bash',
      arguments: { command }
    },
    buildContext(workspace)
  )
  expect(result.item.kind).toBe('tool_result')
  if (result.item.kind !== 'tool_result') {
    throw new Error('expected tool_result')
  }
  return result.item.output as Record<string, unknown>
}

describe('sandbox-runtime bash adapter', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-sandbox-runtime-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('runs external-sandbox bash commands through sandbox-runtime argv and modifies workspace files', async () => {
    const seenConfigs: SandboxRuntimeConfig[] = []
    const wrappedCommands: string[] = []
    const manager: AnthropicSandboxManagerLike = {
      async initialize(config) {
        seenConfigs.push(config)
      },
      async wrapWithSandboxArgv(command, _binShell, customConfig) {
        wrappedCommands.push(command)
        if (customConfig) seenConfigs.push(customConfig as SandboxRuntimeConfig)
        return {
          argv: [
            process.execPath,
            '-e',
            [
              "const { writeFileSync } = require('node:fs')",
              "writeFileSync('sandboxed.txt', process.argv[1], 'utf8')"
            ].join(';'),
            command
          ],
          env: { ...process.env, KUN_SANDBOX_TEST: '1' }
        }
      },
      async reset() {}
    }
    const host = new LocalToolHost({
      tools: [
        createBashLocalTool({
          sandbox: createSandboxRuntimeBashOperations({ manager, platform: 'linux' })
        })
      ]
    })

    const output = await executeBash(host, workspace, 'modified by sandbox runtime')

    expect(output.shell).toContain('sandbox-runtime:')
    expect(wrappedCommands).toEqual(['modified by sandbox runtime'])
    await expect(readFile(join(workspace, 'sandboxed.txt'), 'utf8'))
      .resolves.toBe('modified by sandbox runtime')
    expect(seenConfigs[0]).toMatchObject({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [workspace],
        allowWrite: [workspace],
        denyWrite: []
      }
    })
  })

  it('maps Kun sandbox modes to sandbox-runtime filesystem config on macOS/Linux', () => {
    expect(configForSandboxMode({ sandboxMode: 'read-only' }, workspace, 'linux').filesystem).toMatchObject({
      denyRead: [],
      allowRead: [workspace],
      allowWrite: [],
      denyWrite: []
    })
    expect(configForSandboxMode({ sandboxMode: 'workspace-write' }, workspace, 'darwin').filesystem).toMatchObject({
      denyRead: [],
      allowRead: [workspace],
      allowWrite: [workspace],
      denyWrite: []
    })
    expect(configForSandboxMode({ sandboxMode: 'external-sandbox' }, workspace, 'linux').filesystem).toMatchObject({
      denyRead: [],
      allowRead: [workspace],
      allowWrite: [workspace],
      denyWrite: []
    })
  })

  it('uses a Windows-compatible deny-only filesystem config', () => {
    const config = configForSandboxMode({ sandboxMode: 'external-sandbox' }, workspace, 'win32')

    expect(config.filesystem).toMatchObject({
      denyRead: [],
      allowWrite: [],
      denyWrite: []
    })
    expect(config.filesystem.allowRead).toBeUndefined()
  })
})
