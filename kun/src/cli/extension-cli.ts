import {
  installManagedExtension,
  listManagedExtensions,
  removeManagedExtension,
  validateExtension
} from '../extensions/extension-runtime.js'
import { parseServeOptionsSafe, ServeExitCode } from './serve.js'

type WritableLike = { write(chunk: string): unknown }

export type ExtensionCliIo = {
  stdout: WritableLike
  stderr: WritableLike
  env?: Record<string, string | undefined>
}

export const EXTENSION_CLI_USAGE = `pengcodex extension <command> [options]

Commands:
  list                       List managed extensions
  validate <path>            Validate a manifest or extension directory
  install <path>             Install an extension into the managed data directory
  remove <id>                Remove a managed extension

Options:
  --config <path>            JSON config used to resolve the data directory
  --data-dir <path>          PengCodex Core data directory
  --force                    Replace an existing extension during install
  --json                     Emit stable machine-readable output
`

export async function runExtensionCommand(argv: readonly string[], io: ExtensionCliIo): Promise<number> {
  const json = hasFlag(argv, 'json')
  const values = positionals(argv)
  const command = values[0]
  if (!command || command === 'help') {
    io.stdout.write(EXTENSION_CLI_USAGE)
    return ServeExitCode.ok
  }
  if (!['list', 'validate', 'install', 'remove'].includes(command)) {
    return writeError(io, json, ServeExitCode.usage, `unknown extension command: ${command}`)
  }
  try {
    if (command === 'validate') {
      const source = values[1]
      if (!source) return writeError(io, json, ServeExitCode.usage, 'validate requires <path>')
      const extension = await validateExtension(source)
      writeResult(io, json, {
        valid: true,
        id: extension.manifest.id,
        name: extension.manifest.name,
        version: extension.manifest.version,
        manifestPath: extension.manifestPath,
        tools: extension.manifest.tools.map((tool) => tool.name)
      })
      return ServeExitCode.ok
    }

    const parsed = parseServeOptionsSafe(argv, io.env ?? {})
    if (!parsed.ok) return writeError(io, json, parsed.exitCode, parsed.message, parsed.issues)
    const dataDir = parsed.options.dataDir
    if (command === 'list') {
      const extensions = await listManagedExtensions(dataDir)
      writeResult(io, json, {
        extensions: extensions.map((extension) => ({
          id: extension.manifest.id,
          name: extension.manifest.name,
          version: extension.manifest.version,
          manifestPath: extension.manifestPath,
          tools: extension.manifest.tools.map((tool) => tool.name)
        }))
      })
      return ServeExitCode.ok
    }
    if (command === 'install') {
      const source = values[1]
      if (!source) return writeError(io, json, ServeExitCode.usage, 'install requires <path>')
      const extension = await installManagedExtension({ source, dataDir, force: hasFlag(argv, 'force') })
      writeResult(io, json, {
        installed: true,
        id: extension.manifest.id,
        version: extension.manifest.version,
        manifestPath: extension.manifestPath
      })
      return ServeExitCode.ok
    }
    const id = values[1]
    if (!id) return writeError(io, json, ServeExitCode.usage, 'remove requires <id>')
    const removed = await removeManagedExtension(dataDir, id)
    writeResult(io, json, { removed, id })
    return ServeExitCode.ok
  } catch (error) {
    return writeError(io, json, ServeExitCode.runtime, errorMessage(error))
  }
}

function writeResult(io: ExtensionCliIo, json: boolean, value: Record<string, unknown>): void {
  if (json) {
    io.stdout.write(`${JSON.stringify({ ok: true, ...value })}\n`)
    return
  }
  if (Array.isArray(value.extensions)) {
    const entries = value.extensions as Array<{ id: string; version: string; tools: string[] }>
    io.stdout.write(entries.length > 0
      ? `${entries.map((entry) => `${entry.id}@${entry.version}\t${entry.tools.length} tool(s)`).join('\n')}\n`
      : 'No managed extensions installed.\n')
    return
  }
  io.stdout.write(`${Object.entries(value).map(([key, item]) => `${key}: ${formatValue(item)}`).join('\n')}\n`)
}

function writeError(
  io: ExtensionCliIo,
  json: boolean,
  exitCode: number,
  message: string,
  details?: unknown
): number {
  if (json) io.stdout.write(`${JSON.stringify({ ok: false, error: { message, ...(details ? { details } : {}) } })}\n`)
  else io.stderr.write(`pengcodex extension: ${message}\n`)
  return exitCode
}

function positionals(argv: readonly string[]): string[] {
  const valueFlags = new Set(['config', 'config-file', 'data-dir', 'dataDir'])
  const output: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token.startsWith('--')) {
      const name = token.slice(2).split('=')[0]!
      if (!token.includes('=') && valueFlags.has(name)) index += 1
      continue
    }
    output.push(token)
  }
  return output
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((token) => token === `--${name}` || token === `--${name}=true`)
}

function formatValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
