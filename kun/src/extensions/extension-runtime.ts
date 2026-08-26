import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveExecutable } from '../adapters/tool/builtin-tool-utils.js'
import type { ExtensionsCapabilityConfig } from '../contracts/capabilities.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { EXTENSION_MANIFEST_FILENAME, ExtensionManifest, extensionToolName } from './extension-manifest.js'

export type LoadedExtension = {
  manifest: ExtensionManifest
  manifestPath: string
  directory: string
}

export type ExtensionDiagnostic = {
  id?: string
  manifestPath: string
  status: 'loaded' | 'invalid' | 'blocked'
  toolCount: number
  reason?: string
}

export class ExtensionRuntime {
  private constructor(
    readonly extensions: LoadedExtension[],
    readonly diagnostics: ExtensionDiagnostic[],
    readonly config: ExtensionsCapabilityConfig,
    private readonly allowedExecutables: ReadonlySet<string>,
    private readonly trustedWorkspaceRoots: readonly string[]
  ) {}

  static async create(config: ExtensionsCapabilityConfig, managedRoot: string): Promise<ExtensionRuntime> {
    const roots = uniquePaths([managedRoot, ...config.roots])
    const discovered = await discoverManifestPaths(roots)
    const loaded: LoadedExtension[] = []
    const diagnostics: ExtensionDiagnostic[] = []
    const ids = new Set<string>()
    const toolNames = new Set<string>()
    const allowedExecutables = await canonicalizeExecutableAllowlist(config.allowExecutables)
    const trustedWorkspaceRoots = config.trustedWorkspaceRoots.flatMap((root) => {
      try { return [normalizeExecutablePath(realpathSync(resolve(root)))] } catch { return [] }
    })
    for (const manifestPath of discovered) {
      try {
        const extension = await readExtensionManifest(manifestPath)
        if (ids.has(extension.manifest.id)) {
          diagnostics.push({
            id: extension.manifest.id,
            manifestPath,
            status: 'blocked',
            toolCount: 0,
            reason: 'duplicate extension id'
          })
          continue
        }
        ids.add(extension.manifest.id)
        const allowedTools: ExtensionManifest['tools'] = []
        for (const tool of extension.manifest.tools) {
          const executable = await canonicalExecutablePath(tool.executable, extension.directory)
          if (executable && allowedExecutables.has(normalizeExecutablePath(executable))) {
            allowedTools.push({ ...tool, executable })
          }
        }
        if (allowedTools.length === 0) {
          diagnostics.push({
            id: extension.manifest.id,
            manifestPath,
            status: 'blocked',
            toolCount: 0,
            reason: 'no extension executables are in capabilities.extensions.allowExecutables'
          })
          continue
        }
        const extensionToolNames = allowedTools.map((tool) => extensionToolName(extension.manifest.id, tool.name))
        if (new Set(extensionToolNames).size !== extensionToolNames.length || extensionToolNames.some((name) => toolNames.has(name))) {
          diagnostics.push({
            id: extension.manifest.id,
            manifestPath,
            status: 'blocked',
            toolCount: 0,
            reason: 'extension tool name collides with another loaded extension tool'
          })
          continue
        }
        for (const name of extensionToolNames) toolNames.add(name)
        loaded.push({ ...extension, manifest: { ...extension.manifest, tools: allowedTools } })
        diagnostics.push({ id: extension.manifest.id, manifestPath, status: 'loaded', toolCount: allowedTools.length })
      } catch (error) {
        diagnostics.push({ manifestPath, status: 'invalid', toolCount: 0, reason: errorMessage(error) })
      }
    }
    return new ExtensionRuntime(loaded, diagnostics, config, allowedExecutables, trustedWorkspaceRoots)
  }

  toolCount(): number {
    return this.extensions.reduce((total, extension) => total + extension.manifest.tools.length, 0)
  }

  isWorkspaceTrusted(workspace: string): boolean {
    let candidate: string
    try {
      candidate = normalizeExecutablePath(realpathSync(resolve(workspace)))
    } catch {
      return false
    }
    return this.trustedWorkspaceRoots.some((root) => isPathWithin(root, candidate))
  }

  async execute(
    extension: LoadedExtension,
    tool: ExtensionManifest['tools'][number],
    args: Record<string, unknown>,
    context: ToolHostContext
  ): Promise<unknown> {
    if (!this.isWorkspaceTrusted(context.workspace)) throw new Error('extension execution is not trusted for this workspace')
    const executable = await canonicalExecutablePath(tool.executable, extension.directory)
    if (!executable || !this.allowedExecutables.has(normalizeExecutablePath(executable))) {
      throw new Error(`extension executable is not allowed: ${tool.executable}`)
    }
    const cwd = tool.cwd === 'extension' ? extension.directory : resolve(context.workspace)
    const result = await spawnExtensionCommand({
      executable,
      args: tool.args,
      cwd,
      input: {
        arguments: args,
        context: {
          workspace: resolve(context.workspace),
          threadId: context.threadId,
          turnId: context.turnId,
          extensionId: extension.manifest.id,
          tool: extensionToolName(extension.manifest.id, tool.name)
        }
      },
      timeoutMs: tool.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
      env: buildExtensionEnv(tool.env, this.config.envAllowlist),
      signal: context.abortSignal
    })
    if (result.exitCode !== 0) {
      throw new Error(`extension command exited with ${result.exitCode}: ${result.stderr.trim().slice(0, 2000)}`)
    }
    if (tool.output === 'text') return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
    try {
      return JSON.parse(result.stdout) as unknown
    } catch {
      throw new Error('extension declared JSON output but returned invalid JSON')
    }
  }
}

export async function readExtensionManifest(path: string): Promise<LoadedExtension> {
  const target = (await stat(path)).isDirectory() ? join(path, EXTENSION_MANIFEST_FILENAME) : path
  const manifest = ExtensionManifest.parse(JSON.parse(await readFile(target, 'utf8')))
  return { manifest, manifestPath: resolve(target), directory: dirname(resolve(target)) }
}

export async function validateExtension(path: string): Promise<LoadedExtension> {
  return readExtensionManifest(resolve(path))
}

export async function listManagedExtensions(dataDir: string): Promise<LoadedExtension[]> {
  const root = managedExtensionRoot(dataDir)
  const paths = await discoverManifestPaths([root])
  const loaded = await Promise.all(paths.map((path) => readExtensionManifest(path).catch(() => undefined)))
  return loaded.filter((extension): extension is LoadedExtension => Boolean(extension))
}

export async function installManagedExtension(input: {
  source: string
  dataDir: string
  force?: boolean
}): Promise<LoadedExtension> {
  const source = resolve(input.source)
  const extension = await readExtensionManifest(source)
  const destination = join(managedExtensionRoot(input.dataDir), extension.manifest.id)
  const exists = await stat(destination).then(() => true).catch(() => false)
  if (exists && !input.force) throw new Error(`extension already installed: ${extension.manifest.id} (use --force to replace it)`)
  await mkdir(managedExtensionRoot(input.dataDir), { recursive: true })
  if (exists) await rm(destination, { recursive: true, force: true })
  const sourceStat = await stat(source)
  if (sourceStat.isDirectory()) {
    await cp(source, destination, { recursive: true, errorOnExist: true })
  } else {
    await mkdir(destination, { recursive: true })
    await copyFile(source, join(destination, EXTENSION_MANIFEST_FILENAME))
  }
  return readExtensionManifest(destination)
}

export async function removeManagedExtension(dataDir: string, id: string): Promise<boolean> {
  const parsedId = ExtensionManifest.shape.id.safeParse(id)
  if (!parsedId.success) throw new Error('invalid extension id')
  const target = join(managedExtensionRoot(dataDir), parsedId.data)
  const exists = await stat(target).then(() => true).catch(() => false)
  if (!exists) return false
  await rm(target, { recursive: true, force: true })
  return true
}

export function managedExtensionRoot(dataDir: string): string {
  return join(resolve(dataDir), 'extensions')
}

async function discoverManifestPaths(roots: readonly string[]): Promise<string[]> {
  const manifests: string[] = []
  for (const rawRoot of roots) {
    const root = resolve(rawRoot)
    const rootStat = await stat(root).catch(() => undefined)
    if (!rootStat) continue
    if (rootStat.isFile()) {
      manifests.push(root)
      continue
    }
    const direct = join(root, EXTENSION_MANIFEST_FILENAME)
    if (await stat(direct).then((value) => value.isFile()).catch(() => false)) manifests.push(direct)
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        const nested = join(root, entry.name, EXTENSION_MANIFEST_FILENAME)
        if (await stat(nested).then((value) => value.isFile()).catch(() => false)) manifests.push(nested)
      }
    }
  }
  return [...new Set(manifests.map((manifest) => resolve(manifest)))].sort()
}

function resolveExtensionExecutable(executable: string, directory: string): string {
  return isAbsolute(executable) ? executable : executable.includes('/') || executable.includes('\\')
    ? resolve(directory, executable)
    : executable
}

async function canonicalizeExecutableAllowlist(allowlist: readonly string[]): Promise<Set<string>> {
  const canonical = await Promise.all(allowlist.map((entry) => canonicalExecutablePath(entry, process.cwd())))
  return new Set(canonical.filter((entry): entry is string => Boolean(entry)).map(normalizeExecutablePath))
}

async function canonicalExecutablePath(executable: string, directory: string): Promise<string | null> {
  const candidate = resolveExtensionExecutable(executable, directory)
  const located = isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')
    ? candidate
    : resolveExecutable([candidate])
  if (!located) return null
  try {
    const info = await stat(located)
    if (!info.isFile()) return null
    return await realpath(located)
  } catch {
    return null
  }
}

function normalizeExecutablePath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function buildExtensionEnv(manifestEnv: Record<string, string>, allowlist: readonly string[]): NodeJS.ProcessEnv {
  const baseKeys = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
  const env: NodeJS.ProcessEnv = {}
  for (const key of baseKeys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const key of allowlist) {
    if (PROTECTED_EXECUTION_ENV_KEYS.has(key.toUpperCase())) continue
    const value = manifestEnv[key] ?? process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

const PROTECTED_EXECUTION_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS'
])

async function spawnExtensionCommand(input: {
  executable: string
  args: string[]
  cwd: string
  input: unknown
  timeoutMs: number
  maxOutputBytes: number
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (input.signal.aborted) throw new Error('extension command aborted')
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let overflow = false
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > input.maxOutputBytes) {
      overflow = true
      child.kill()
      return
    }
    target.push(chunk)
  }
  child.stdout.on('data', collect(stdout))
  child.stderr.on('data', collect(stderr))
  child.stdin.end(JSON.stringify(input.input))
  const onAbort = () => child.kill()
  input.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => child.kill(), input.timeoutMs)
  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', resolvePromise)
  }).finally(() => {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', onAbort)
  })
  if (input.signal.aborted) throw new Error('extension command aborted')
  if (overflow) throw new Error(`extension output exceeded ${input.maxOutputBytes} bytes`)
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    exitCode
  }
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
