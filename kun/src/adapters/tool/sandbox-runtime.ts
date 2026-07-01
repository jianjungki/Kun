import { spawn } from 'node:child_process'
import type { SandboxMode } from '../../contracts/policy.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { BashLocalToolOperations } from './builtin-tool-types.js'
import { shellRuntimeInfo, terminateSpawnTree, waitForSpawnExit } from './builtin-tool-utils.js'

export type SandboxRuntimeConfig = {
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
  }
  filesystem: {
    disabled?: boolean
    denyRead: string[]
    allowRead?: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
  windows?: {
    groupName?: string
    groupSid?: string
    wfpSublayerGuid?: string
    asSandboxUser?: boolean
    proxyPortRange?: [number, number]
  }
}

export type AnthropicSandboxRuntimeConfig = SandboxRuntimeConfig

export type AnthropicSandboxManagerLike = {
  initialize(config: SandboxRuntimeConfig): Promise<void>
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
  reset(): Promise<void>
}

export type SandboxRuntimeBashOptions = {
  manager?: AnthropicSandboxManagerLike
  platform?: NodeJS.Platform
}

export type AnthropicSandboxRuntimeOptions = SandboxRuntimeBashOptions

export function createSandboxRuntimeBashOperations(
  options: SandboxRuntimeBashOptions = {}
): BashLocalToolOperations {
  return {
    exec: async (command, cwd, execOptions) => {
      if (execOptions.context?.sandboxMode !== 'external-sandbox') {
        throw new Error('sandbox-runtime backend requires sandboxMode=external-sandbox')
      }
      const manager = options.manager ?? await loadAnthropicSandboxManager()
      const config = configForSandboxMode(execOptions.context, cwd, options.platform)
      const shell = shellRuntimeInfo()
      const binShell = sandboxRuntimeBinShell(shell.shell, shell.name, options.platform ?? process.platform)
      await manager.initialize(config)
      try {
        const wrapped = await manager.wrapWithSandboxArgv(
          command,
          binShell,
          config,
          execOptions.signal
        )
        return await spawnSandboxedArgv(wrapped.argv, cwd, {
          ...execOptions,
          env: wrapped.env,
          shellName: shell.name
        })
      } finally {
        await manager.reset()
      }
    }
  }
}

function sandboxRuntimeBinShell(
  shell: string,
  name: string,
  platform: NodeJS.Platform
): string {
  if (platform !== 'win32') return shell
  if (name === 'pwsh') return 'pwsh'
  if (name === 'powershell') return 'powershell'
  if (name === 'cmd.exe') return 'cmd'
  return shell
}

export const createAnthropicSandboxBashOperations = createSandboxRuntimeBashOperations

export function configForSandboxMode(
  context: Pick<ToolHostContext, 'sandboxMode'> | undefined,
  workspace: string,
  platform: NodeJS.Platform = process.platform
): SandboxRuntimeConfig {
  const mode: SandboxMode = context?.sandboxMode ?? 'danger-full-access'
  if (platform === 'win32') {
    return windowsConfigForSandboxMode(mode)
  }
  if (mode === 'read-only') {
    return {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [workspace],
        allowWrite: [],
        denyWrite: []
      }
    }
  }
  if (mode === 'workspace-write' || mode === 'external-sandbox') {
    return {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [workspace],
        allowWrite: [workspace],
        denyWrite: []
      }
    }
  }
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      disabled: true,
      denyRead: [],
      allowWrite: [],
      denyWrite: []
    }
  }
}

function windowsConfigForSandboxMode(mode: SandboxMode): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      ...(mode === 'danger-full-access' ? { disabled: true } : {}),
      denyRead: [],
      allowWrite: [],
      denyWrite: []
    }
  }
}

async function loadAnthropicSandboxManager(): Promise<AnthropicSandboxManagerLike> {
  try {
    const mod = await import('@anthropic-ai/sandbox-runtime')
    return mod.SandboxManager as AnthropicSandboxManagerLike
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`@anthropic-ai/sandbox-runtime is unavailable: ${message}`)
  }
}

async function spawnSandboxedArgv(
  argv: readonly string[],
  cwd: string,
  options: {
    signal: AbortSignal
    timeoutSeconds: number
    onData?: (data: Buffer) => void
    env: NodeJS.ProcessEnv
    shellName: string
  }
): Promise<{ exitCode: number | null; shell?: string }> {
  const [file, ...args] = argv
  if (!file) throw new Error('sandbox runtime returned an empty argv')
  const child = spawn(file, args, {
    cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let timedOut = false
  const kill = () => terminateSpawnTree(child)
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, options.timeoutSeconds * 1000)
  const onAbort = () => kill()
  options.signal.addEventListener('abort', onAbort, { once: true })
  child.stdout?.on('data', (chunk: Buffer | string) => {
    options.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    options.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
  const exitCode = await waitForSpawnExit(child).finally(() => {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  })
  if (options.signal.aborted) throw new Error('command aborted')
  if (timedOut) throw new Error(`command timed out after ${options.timeoutSeconds} seconds`)
  return { exitCode, shell: `sandbox-runtime:${options.shellName}` }
}
