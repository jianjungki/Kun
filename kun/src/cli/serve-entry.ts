#!/usr/bin/env node
import process from 'node:process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clearRuntimeSecretEnvironment,
  parseServeOptionsSafe,
  SERVE_USAGE,
  ServeExitCode
} from './serve.js'
import {
  PENGCODEX_CLI_USAGE,
  runAgentCommand,
  splitPengCodexCliCommand
} from './agent-cli.js'
import { startKunServe } from '../server/runtime-factory.js'
import {
  publishRuntimeDiscovery,
  removeRuntimeDiscovery
} from './runtime-discovery.js'
import { runRuntimeCommand } from './runtime-cli.js'
import { runExtensionCommand } from './extension-cli.js'
import { resolveServeRuntimeToken } from './runtime-token.js'

export const KUN_READY_PREFIX = 'KUN_READY '

/**
 * Serve-mode command. Kept separate from the dispatcher so GUI startup
 * still has the exact same KUN_READY handshake behavior.
 */
async function serveMain(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(SERVE_USAGE)
    return ServeExitCode.ok
  }
  const parsed = parseServeOptionsSafe(argv, process.env)
  if (!parsed.ok) {
    process.stderr.write(`pengcodex serve: ${parsed.message}\n`)
    if (parsed.issues) {
      process.stderr.write(`${JSON.stringify(parsed.issues, null, 2)}\n`)
    }
    return parsed.exitCode
  }
  const auth = await resolveServeRuntimeToken(parsed.options)
  clearRuntimeSecretEnvironment(process.env)
  const options = {
    ...parsed.options,
    runtimeToken: auth.runtimeToken
  }
  const handle = await startKunServe(options)
  const info = handle.runtime.info()
  let discovery
  try {
    discovery = await publishRuntimeDiscovery({
      dataDir: info.dataDir,
      host: handle.host,
      port: handle.port,
      startedAt: info.startedAt,
      pid: info.pid
    })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  const startupInfo = {
    service: 'kun',
    mode: 'serve',
    host: handle.host,
    port: handle.port,
    configPath: info.configPath,
    dataDir: info.dataDir,
    model: info.model,
    approvalPolicy: info.approvalPolicy,
    sandboxMode: info.sandboxMode,
    insecure: info.insecure,
    ...(auth.tokenPath ? { runtimeTokenPath: auth.tokenPath } : {}),
    startedAt: info.startedAt,
    pid: info.pid,
    message: `PengCodex runtime listening on http://${handle.host}:${handle.port}`
  }
  process.stdout.write(`${KUN_READY_PREFIX}${JSON.stringify(startupInfo)}\n`)
  process.stdout.write(JSON.stringify(startupInfo, null, 2) + '\n')
  await new Promise<void>((resolve) => {
    let closing: Promise<void> | undefined
    const stop = () => {
      if (!closing) {
        closing = (async () => {
          try {
            await handle.close()
          } finally {
            await removeRuntimeDiscovery(info.dataDir, discovery.instanceId)
          }
        })()
      }
      void closing.then(resolve, (error) => {
        process.stderr.write(`pengcodex serve: shutdown failed: ${String(error)}\n`)
        resolve()
      })
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
  return ServeExitCode.ok
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = splitPengCodexCliCommand(argv)
  if (command.command === 'help') {
    if (command.error) {
      process.stderr.write(`pengcodex: ${command.error}\n`)
      process.stderr.write(PENGCODEX_CLI_USAGE)
      return ServeExitCode.usage
    }
    process.stdout.write(PENGCODEX_CLI_USAGE)
    return ServeExitCode.ok
  }
  if (command.command === 'serve') {
    return serveMain(command.args)
  }
  if (command.command === 'runtime') {
    return runRuntimeCommand(command.args, {
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env
    })
  }
  if (command.command === 'extension') {
    return runExtensionCommand(command.args, {
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env
    })
  }
  return runAgentCommand(command.command, command.args, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: () => process.cwd()
  })
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code)
    },
    (error) => {
      process.stderr.write(`pengcodex: ${String(error)}\n`)
      process.exit(ServeExitCode.runtime)
    }
  )
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url))
  }
}
