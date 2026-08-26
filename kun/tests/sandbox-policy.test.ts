import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalToolHost, defaultLocalTools } from '../src/adapters/tool/local-tool-host.js'
import type { SandboxMode } from '../src/contracts/policy.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

function buildContext(workspace: string, sandboxMode: SandboxMode): ToolHostContext {
  return {
    threadId: 'thr_policy',
    turnId: 'turn_policy',
    workspace,
    approvalPolicy: 'auto',
    sandboxMode,
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

describe('sandbox policy', () => {
  let workspace: string
  let external: string
  let host: LocalToolHost

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-sandbox-policy-workspace-'))
    external = await mkdtemp(join(tmpdir(), 'kun-sandbox-policy-external-'))
    host = new LocalToolHost({ tools: defaultLocalTools })
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  })

  it('advertises only read-only tools in read-only mode', async () => {
    const tools = await host.listTools(buildContext(workspace, 'read-only'))
    const names = tools.map((tool) => tool.name)

    expect(names).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls']))
    expect(names).not.toEqual(expect.arrayContaining(['write', 'edit', 'bash']))
  })

  it('keeps workspace file tools but hides unconstrained shell in workspace-write mode', async () => {
    const tools = await host.listTools(buildContext(workspace, 'workspace-write'))
    const names = tools.map((tool) => tool.name)

    expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit']))
    expect(names).not.toContain('bash')
  })

  it('keeps the existing external-sandbox command path available', async () => {
    const tools = await host.listTools(buildContext(workspace, 'external-sandbox'))
    expect(tools.map((tool) => tool.name)).toContain('bash')
  })

  it('rejects reads and writes that escape through a workspace symlink', async () => {
    await writeFile(join(external, 'secret.txt'), 'outside\n', 'utf8')
    await symlink(external, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    const read = await host.execute({
      callId: 'call_symlink_read',
      toolName: 'read',
      arguments: { path: 'linked/secret.txt' }
    }, buildContext(workspace, 'danger-full-access'))
    expect(read.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: { error: expect.stringContaining('outside the workspace root') }
    })

    const write = await host.execute({
      callId: 'call_symlink_write',
      toolName: 'write',
      arguments: { path: 'linked/new.txt', content: 'blocked' }
    }, buildContext(workspace, 'workspace-write'))
    expect(write.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: { error: expect.stringContaining('outside the workspace root') }
    })

    const grep = await host.execute({
      callId: 'call_symlink_grep',
      toolName: 'grep',
      arguments: { path: '.', pattern: 'outside' }
    }, buildContext(workspace, 'read-only'))
    expect(grep.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (grep.item.kind === 'tool_result') {
      expect(grep.item.output).toMatchObject({ matches: [] })
    }

    const find = await host.execute({
      callId: 'call_symlink_find',
      toolName: 'find',
      arguments: { path: '.', pattern: '**/secret.txt' }
    }, buildContext(workspace, 'read-only'))
    expect(find.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (find.item.kind === 'tool_result') {
      expect(find.item.output).toMatchObject({ matches: [] })
    }
  })
})
