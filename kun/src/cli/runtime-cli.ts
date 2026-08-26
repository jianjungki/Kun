import { inspectRuntimeStatus, type RuntimeStatusResult } from './runtime-discovery.js'
import { parseServeOptionsSafe, ServeExitCode } from './serve.js'

type WritableLike = {
  write(chunk: string): unknown
}

export type RuntimeCliIo = {
  stdout: WritableLike
  stderr: WritableLike
  env?: Record<string, string | undefined>
  inspectStatus?: typeof inspectRuntimeStatus
}

export const RUNTIME_CLI_USAGE = `pengcodex runtime <command> [options]

Commands:
  status                     Inspect the discovered local runtime

Options:
  --config <path>            JSON config file
  --data-dir <path>          Root directory for PengCodex Core data
  --json                     Emit machine-readable JSON
`

export async function runRuntimeCommand(
  argv: readonly string[],
  io: RuntimeCliIo
): Promise<number> {
  const command = argv[0]
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.stdout.write(RUNTIME_CLI_USAGE)
    return ServeExitCode.ok
  }
  if (command !== 'status') {
    io.stderr.write(`pengcodex runtime: unknown command: ${command}\n`)
    io.stderr.write(RUNTIME_CLI_USAGE)
    return ServeExitCode.usage
  }

  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(RUNTIME_CLI_USAGE)
    return ServeExitCode.ok
  }
  const parsed = parseServeOptionsSafe(args, io.env ?? {})
  if (!parsed.ok) {
    const message = parsed.message === 'serve requires --data-dir <path>'
      ? 'requires --data-dir <path> or a config with serve.dataDir'
      : parsed.message
    io.stderr.write(`pengcodex runtime status: ${message}\n`)
    if (parsed.issues) io.stderr.write(`${JSON.stringify(parsed.issues, null, 2)}\n`)
    return parsed.exitCode
  }

  try {
    const inspectStatus = io.inspectStatus ?? inspectRuntimeStatus
    const result = await inspectStatus(parsed.options.dataDir)
    if (hasFlag(args, 'json')) {
      io.stdout.write(`${JSON.stringify(result)}\n`)
    } else {
      io.stdout.write(`${formatRuntimeStatus(result)}\n`)
    }
    return result.status === 'running' ? ServeExitCode.ok : ServeExitCode.runtime
  } catch (error) {
    io.stderr.write(`pengcodex runtime status: ${errorMessage(error)}\n`)
    return ServeExitCode.runtime
  }
}

function formatRuntimeStatus(result: RuntimeStatusResult): string {
  switch (result.status) {
    case 'running':
      return `PengCodex Core is running (pid ${result.runtime.pid}, ${result.healthUrl})`
    case 'missing':
      return `PengCodex Core is not running (no ${result.discoveryPath})`
    case 'stale':
      return `PengCodex Core discovery is stale${result.reason ? `: ${result.reason}` : ''}`
    case 'unreachable':
      return `PengCodex Core process is present but unreachable${result.reason ? `: ${result.reason}` : ''}`
  }
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((token) => token === `--${name}` || token === `--${name}=true`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
