import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { buildExtensionToolProviders } from '../src/adapters/tool/extension-tool-provider.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { runExtensionCommand } from '../src/cli/extension-cli.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { ExtensionRuntime } from '../src/extensions/extension-runtime.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

describe('Extension runtime and CLI', () => {
  let root = ''
  let workspace = ''
  let extensionDir = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pengcodex-extension-'))
    workspace = join(root, 'workspace')
    extensionDir = join(root, 'source-extension')
    await mkdir(workspace, { recursive: true })
    await mkdir(extensionDir, { recursive: true })
    const helper = join(extensionDir, 'tool.mjs')
    await writeFile(helper, [
      "let input = ''",
      "for await (const chunk of process.stdin) input += chunk",
      "process.stdout.write(JSON.stringify({ input: JSON.parse(input), path: process.env.PATH }))"
    ].join('\n'), 'utf8')
    await writeFile(join(extensionDir, 'pengcodex-extension.json'), JSON.stringify({
      manifestVersion: 1,
      id: 'example.tools',
      name: 'Example Tools',
      version: '1.0.0',
      tools: [{
        name: 'echo',
        description: 'Echo structured input',
        executable: process.execPath,
        args: [helper],
        output: 'json',
        env: { PATH: 'extension-controlled-path' }
      }]
    }, null, 2), 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads only allowlisted commands and advertises them in trusted workspaces', async () => {
    const config = KunCapabilitiesConfig.parse({
      extensions: {
        enabled: true,
        roots: [extensionDir],
        trustedWorkspaceRoots: [workspace],
        allowExecutables: [process.execPath],
        envAllowlist: ['PATH']
      }
    }).extensions
    const runtime = await ExtensionRuntime.create(config, join(root, 'managed'))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildExtensionToolProviders(runtime))
    })

    expect((await host.listTools(context(workspace))).map((tool) => tool.name)).toEqual([
      'ext_example_tools_echo'
    ])
    expect(await host.listTools(context(join(root, 'untrusted')))).toEqual([])

    const result = await host.execute({
      callId: 'extension_echo',
      toolName: 'ext_example_tools_echo',
      arguments: { message: 'hello' }
    }, context(workspace))
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        input: {
          arguments: { message: 'hello' },
          context: { extensionId: 'example.tools', workspace }
        }
      })
      expect((result.item.output as { path?: string }).path).not.toBe('extension-controlled-path')
    }
  })

  it('compares allowlisted executables by canonical path instead of basename', async () => {
    const bundledExecutable = join(extensionDir, basename(process.execPath))
    await writeFile(bundledExecutable, 'not the system executable', 'utf8')
    const manifestPath = join(extensionDir, 'pengcodex-extension.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      tools: Array<{ executable: string }>
    }
    manifest.tools[0]!.executable = `./${basename(process.execPath)}`
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

    const config = KunCapabilitiesConfig.parse({
      extensions: {
        enabled: true,
        roots: [extensionDir],
        trustedWorkspaceRoots: [workspace],
        allowExecutables: [basename(process.execPath)]
      }
    }).extensions
    const runtime = await ExtensionRuntime.create(config, join(root, 'managed'))

    expect(runtime.extensions).toHaveLength(0)
    expect(runtime.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'example.tools', status: 'blocked' })
    ]))
  })

  it('blocks colliding extension tool names without failing the registry', async () => {
    const first = join(root, 'a-b')
    const second = join(root, 'a_b')
    await Promise.all([mkdir(first), mkdir(second)])
    const manifest = (id: string) => ({
      manifestVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      tools: [{
        name: 'run',
        description: 'Run',
        executable: process.execPath,
        args: ['--version'],
        output: 'text'
      }]
    })
    await Promise.all([
      writeFile(join(first, 'pengcodex-extension.json'), JSON.stringify(manifest('a-b')), 'utf8'),
      writeFile(join(second, 'pengcodex-extension.json'), JSON.stringify(manifest('a_b')), 'utf8')
    ])
    const config = KunCapabilitiesConfig.parse({
      extensions: {
        enabled: true,
        roots: [first, second],
        trustedWorkspaceRoots: [workspace],
        allowExecutables: [process.execPath]
      }
    }).extensions
    const runtime = await ExtensionRuntime.create(config, join(root, 'managed'))

    expect(runtime.extensions).toHaveLength(1)
    expect(runtime.diagnostics.filter((item) => item.status === 'blocked')).toHaveLength(1)
    expect(() => new CapabilityRegistry(buildExtensionToolProviders(runtime))).not.toThrow()
  })

  it('installs, lists, validates, and removes managed extensions with JSON output', async () => {
    const dataDir = join(root, 'data')
    const validated = await runCli(['validate', extensionDir, '--json'])
    expect(validated.code).toBe(0)
    expect(JSON.parse(validated.stdout)).toMatchObject({ ok: true, valid: true, id: 'example.tools' })

    const installed = await runCli(['install', extensionDir, '--data-dir', dataDir, '--json'])
    expect(installed.code).toBe(0)
    expect(JSON.parse(installed.stdout)).toMatchObject({ ok: true, installed: true, id: 'example.tools' })

    const listed = await runCli(['list', '--data-dir', dataDir, '--json'])
    expect(JSON.parse(listed.stdout).extensions).toEqual([
      expect.objectContaining({ id: 'example.tools', tools: ['echo'] })
    ])

    const removed = await runCli(['remove', 'example.tools', '--data-dir', dataDir, '--json'])
    expect(JSON.parse(removed.stdout)).toMatchObject({ ok: true, removed: true })
    await expect(readFile(join(dataDir, 'extensions', 'example.tools', 'pengcodex-extension.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function context(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_extension',
    turnId: 'turn_extension',
    workspace,
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runExtensionCommand(argv, {
    stdout: { write: (chunk) => { stdout += chunk } },
    stderr: { write: (chunk) => { stderr += chunk } },
    env: {}
  })
  return { code, stdout, stderr }
}
