import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

export const PENGCODEX_CLI_FORWARD_ARG = '--pengcodex-cli'
export const PENGCODEX_CLI_INSTALL_ARG = '--install-pengcodex-cli'
export const PENGCODEX_CLI_UNINSTALL_ARG = '--uninstall-pengcodex-cli'

const MANAGED_LAUNCHER_MARKER = 'PengCodex managed CLI launcher'
const PROFILE_MARKER_START = '# >>> PengCodex CLI >>>'
const PROFILE_MARKER_END = '# <<< PengCodex CLI <<<'
const execFileAsync = promisify(execFile)

export type PengCodexCliPathResult = {
  binDir: string
  launcherPath: string
  profilePaths: string[]
}

export type PengCodexCliPathDependencies = {
  platform?: NodeJS.Platform
  homeDir?: string
  env?: Record<string, string | undefined>
  updateWindowsUserPath?: (binDir: string, install: boolean) => Promise<void>
}

export async function ensurePengCodexCliOnPath(
  executablePath: string,
  dependencies: PengCodexCliPathDependencies = {}
): Promise<PengCodexCliPathResult> {
  const platform = dependencies.platform ?? process.platform
  const homeDir = dependencies.homeDir ?? homedir()
  const env = dependencies.env ?? process.env
  const binDir = pengCodexCliBinDir(platform, homeDir, env)
  const launcherPath = join(binDir, platform === 'win32' ? 'pengcodex.cmd' : 'pengcodex')
  const launcher = buildPengCodexCliLauncher(platform, executablePath)

  await mkdir(binDir, { recursive: true })
  await writeManagedLauncher(launcherPath, launcher, platform)

  if (platform === 'win32') {
    await writeManagedLauncher(
      join(binDir, 'pengcodex.ps1'),
      buildPengCodexPowerShellLauncher(executablePath),
      platform
    )
    const updateWindowsUserPath = dependencies.updateWindowsUserPath ?? updateWindowsPath
    await updateWindowsUserPath(binDir, true)
    return { binDir, launcherPath, profilePaths: [] }
  }

  const profilePaths = pathContains(env.PATH, binDir, platform)
    ? []
    : await installUnixProfileBlocks(platform, homeDir, env.SHELL, binDir)
  return { binDir, launcherPath, profilePaths }
}

export async function removePengCodexCliFromPath(
  dependencies: PengCodexCliPathDependencies = {}
): Promise<PengCodexCliPathResult> {
  const platform = dependencies.platform ?? process.platform
  const homeDir = dependencies.homeDir ?? homedir()
  const env = dependencies.env ?? process.env
  const binDir = pengCodexCliBinDir(platform, homeDir, env)
  const launcherPath = join(binDir, platform === 'win32' ? 'pengcodex.cmd' : 'pengcodex')
  await removeManagedLauncher(launcherPath)

  if (platform === 'win32') {
    await removeManagedLauncher(join(binDir, 'pengcodex.ps1'))
    const updateWindowsUserPath = dependencies.updateWindowsUserPath ?? updateWindowsPath
    await updateWindowsUserPath(binDir, false)
    return { binDir, launcherPath, profilePaths: [] }
  }

  const profilePaths = unixProfilePaths(platform, homeDir, env.SHELL)
  for (const profilePath of profilePaths) {
    await removeUnixProfileBlock(profilePath, platform)
  }
  return { binDir, launcherPath, profilePaths }
}

export function pengCodexCliExecutablePath(
  platform: NodeJS.Platform,
  executablePath: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (platform === 'linux' && env.APPIMAGE?.trim()) return env.APPIMAGE.trim()
  return executablePath
}

export function pengCodexCliBinDir(
  platform: NodeJS.Platform,
  homeDir: string,
  env: Record<string, string | undefined>
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || join(homeDir, 'AppData', 'Local')
    return join(localAppData, 'PengCodex', 'bin')
  }
  return join(homeDir, '.local', 'bin')
}

export function buildPengCodexCliLauncher(
  platform: NodeJS.Platform,
  executablePath: string
): string {
  if (platform === 'win32') {
    return [
      `@rem ${MANAGED_LAUNCHER_MARKER}`,
      '@echo off',
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0pengcodex.ps1" %*',
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    `# ${MANAGED_LAUNCHER_MARKER}`,
    `exec ${shellQuote(executablePath)} ${PENGCODEX_CLI_FORWARD_ARG} "$@"`,
    ''
  ].join('\n')
}

export function buildPengCodexPowerShellLauncher(executablePath: string): string {
  const command = executablePath.replace(/'/g, "''")
  return [
    `# ${MANAGED_LAUNCHER_MARKER}`,
    "$ErrorActionPreference = 'Stop'",
    `& '${command}' '${PENGCODEX_CLI_FORWARD_ARG}' @args`,
    'if ($null -eq $LASTEXITCODE) { exit 0 }',
    'exit $LASTEXITCODE',
    ''
  ].join('\r\n')
}

export function upsertUnixPathBlock(content: string, binDir: string): string {
  const withoutBlock = removeMarkedBlock(content).trimEnd()
  const quotedBinDir = shellQuote(binDir)
  const block = [
    PROFILE_MARKER_START,
    `_pengcodex_cli_bin=${quotedBinDir}`,
    'case ":$PATH:" in',
    '  *":$_pengcodex_cli_bin:"*) ;;',
    '  *) export PATH="$_pengcodex_cli_bin:$PATH" ;;',
    'esac',
    'unset _pengcodex_cli_bin',
    PROFILE_MARKER_END
  ].join('\n')
  return `${withoutBlock}${withoutBlock ? '\n\n' : ''}${block}\n`
}

export function removeUnixPathBlock(content: string): string {
  const next = removeMarkedBlock(content).trimEnd()
  return next ? `${next}\n` : ''
}

async function writeManagedLauncher(
  launcherPath: string,
  contents: string,
  platform: NodeJS.Platform
): Promise<void> {
  const current = await readOptionalFile(launcherPath)
  if (current !== null && !current.includes(MANAGED_LAUNCHER_MARKER)) {
    throw new Error(`Refusing to replace an unmanaged PengCodex CLI at ${launcherPath}`)
  }
  if (current !== contents) await writeTextFile(launcherPath, contents, platform)
  if (platform !== 'win32') await chmod(launcherPath, 0o755)
}

async function removeManagedLauncher(launcherPath: string): Promise<void> {
  const current = await readOptionalFile(launcherPath)
  if (current === null || !current.includes(MANAGED_LAUNCHER_MARKER)) return
  await rm(launcherPath, { force: true })
}

async function installUnixProfileBlocks(
  platform: NodeJS.Platform,
  homeDir: string,
  shell: string | undefined,
  binDir: string
): Promise<string[]> {
  const profilePaths = unixProfilePaths(platform, homeDir, shell)
  for (const profilePath of profilePaths) {
    const current = await readOptionalFile(profilePath) ?? ''
    const next = upsertUnixPathBlock(current, binDir)
    if (current !== next) await writeTextFile(profilePath, next, platform)
  }
  return profilePaths
}

function unixProfilePaths(
  platform: NodeJS.Platform,
  homeDir: string,
  shell: string | undefined
): string[] {
  const shellName = (shell ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  if (platform === 'darwin' && shellName !== 'bash') return [join(homeDir, '.zprofile')]
  if (platform === 'linux' && shellName === 'bash') {
    return [join(homeDir, '.profile'), join(homeDir, '.bashrc')]
  }
  return [join(homeDir, '.profile')]
}

async function removeUnixProfileBlock(
  profilePath: string,
  platform: NodeJS.Platform
): Promise<void> {
  const current = await readOptionalFile(profilePath)
  if (current === null || !current.includes(PROFILE_MARKER_START)) return
  await writeTextFile(profilePath, removeUnixPathBlock(current), platform)
}

function removeMarkedBlock(content: string): string {
  const start = content.indexOf(PROFILE_MARKER_START)
  if (start < 0) return content
  const end = content.indexOf(PROFILE_MARKER_END, start)
  if (end < 0) return content
  const before = content.slice(0, start).trimEnd()
  const after = content.slice(end + PROFILE_MARKER_END.length).trimStart()
  return `${before}${before && after ? '\n\n' : ''}${after}`
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeTextFile(
  path: string,
  contents: string,
  platform: NodeJS.Platform
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (platform === 'win32') {
    await writeFile(path, contents, 'utf8')
    return
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, 'utf8')
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function pathContains(
  pathValue: string | undefined,
  target: string,
  platform: NodeJS.Platform
): boolean {
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  const expected = caseInsensitive ? target.toLowerCase() : target
  return (pathValue ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .some((entry) => (caseInsensitive ? entry.toLowerCase() : entry) === expected)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function updateWindowsPath(binDir: string, install: boolean): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PENGCODEX_CLI_BIN_TARGET",
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($current -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })",
    "if ($env:PENGCODEX_CLI_PATH_ACTION -eq 'install') {",
    "  if (-not ($parts | Where-Object { [string]::Equals($_, $target, [StringComparison]::OrdinalIgnoreCase) })) { $parts += $target }",
    '} else {',
    "  $parts = @($parts | Where-Object { -not [string]::Equals($_, $target, [StringComparison]::OrdinalIgnoreCase) })",
    '}',
    "[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')",
    "$signature = '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'",
    "$native = Add-Type -MemberDefinition $signature -Name PengCodexEnvironmentBroadcast -Namespace PengCodex -PassThru",
    '$result = [UIntPtr]::Zero',
    "[void]$native::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 0x2, 5000, [ref]$result)"
  ].join('\n')
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    windowsHide: true,
    env: {
      ...process.env,
      PENGCODEX_CLI_BIN_TARGET: binDir,
      PENGCODEX_CLI_PATH_ACTION: install ? 'install' : 'remove'
    }
  })
}
