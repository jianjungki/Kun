import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'

export const RUNTIME_DISCOVERY_VERSION = 1
export const RUNTIME_DISCOVERY_FILENAME = 'runtime.json'

const RuntimeDiscoveryRecordSchema = z.object({
  version: z.literal(RUNTIME_DISCOVERY_VERSION),
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65_535),
  startedAt: z.string().min(1),
  dataDir: z.string().min(1)
})

export type RuntimeDiscoveryRecord = z.infer<typeof RuntimeDiscoveryRecordSchema>

export type RuntimeStatusResult =
  | {
      status: 'running'
      discoveryPath: string
      runtime: RuntimeDiscoveryRecord
      healthUrl: string
    }
  | {
      status: 'missing'
      discoveryPath: string
    }
  | {
      status: 'stale'
      discoveryPath: string
      runtime?: RuntimeDiscoveryRecord
      reason: string
    }
  | {
      status: 'unreachable'
      discoveryPath: string
      runtime: RuntimeDiscoveryRecord
      healthUrl: string
      reason: string
    }

export type RuntimeStatusDependencies = {
  isProcessAlive?: (pid: number) => boolean
  fetch?: typeof fetch
  healthTimeoutMs?: number
}

type ReadRuntimeDiscoveryResult =
  | { status: 'found'; record: RuntimeDiscoveryRecord }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }

export function runtimeDiscoveryPath(dataDir: string): string {
  return join(resolve(dataDir), RUNTIME_DISCOVERY_FILENAME)
}

export async function publishRuntimeDiscovery(input: {
  dataDir: string
  host: string
  port: number
  startedAt: string
  pid?: number
  instanceId?: string
}): Promise<RuntimeDiscoveryRecord> {
  const record = RuntimeDiscoveryRecordSchema.parse({
    version: RUNTIME_DISCOVERY_VERSION,
    instanceId: input.instanceId ?? randomUUID(),
    pid: input.pid ?? process.pid,
    host: input.host,
    port: input.port,
    startedAt: input.startedAt,
    dataDir: resolve(input.dataDir)
  })
  await atomicWriteFile(
    runtimeDiscoveryPath(record.dataDir),
    `${JSON.stringify(record, null, 2)}\n`
  )
  return record
}

export async function removeRuntimeDiscovery(
  dataDir: string,
  instanceId: string
): Promise<boolean> {
  const current = await readRuntimeDiscovery(dataDir)
  if (current.status !== 'found' || current.record.instanceId !== instanceId) return false
  await rm(runtimeDiscoveryPath(dataDir), { force: true })
  return true
}

export async function inspectRuntimeStatus(
  dataDir: string,
  dependencies: RuntimeStatusDependencies = {}
): Promise<RuntimeStatusResult> {
  const discoveryPath = runtimeDiscoveryPath(dataDir)
  const current = await readRuntimeDiscovery(dataDir)
  if (current.status === 'missing') {
    return { status: 'missing', discoveryPath }
  }
  if (current.status === 'invalid') {
    return {
      status: 'stale',
      discoveryPath,
      reason: current.reason
    }
  }

  const runtime = current.record
  const isProcessAlive = dependencies.isProcessAlive ?? processIsAlive
  if (!isProcessAlive(runtime.pid)) {
    return {
      status: 'stale',
      discoveryPath,
      runtime,
      reason: `process ${runtime.pid} is not running`
    }
  }

  const healthUrl = runtimeHealthUrl(runtime)
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.healthTimeoutMs ?? 1_500
  )
  try {
    const fetchHealth = dependencies.fetch ?? fetch
    const response = await fetchHealth(healthUrl, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal
    })
    const body = await response.json() as unknown
    if (!response.ok || !isKunHealthResponse(body)) {
      return {
        status: 'unreachable',
        discoveryPath,
        runtime,
        healthUrl,
        reason: response.ok
          ? 'health endpoint returned an unexpected response'
          : `health endpoint returned HTTP ${response.status}`
      }
    }
    return {
      status: 'running',
      discoveryPath,
      runtime,
      healthUrl
    }
  } catch (error) {
    return {
      status: 'unreachable',
      discoveryPath,
      runtime,
      healthUrl,
      reason: errorMessage(error)
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readRuntimeDiscovery(dataDir: string): Promise<ReadRuntimeDiscoveryResult> {
  try {
    const text = await readFile(runtimeDiscoveryPath(dataDir), 'utf8')
    const parsed = RuntimeDiscoveryRecordSchema.safeParse(JSON.parse(text) as unknown)
    return parsed.success
      ? { status: 'found', record: parsed.data }
      : { status: 'invalid', reason: 'runtime discovery record is invalid' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    if (error instanceof SyntaxError) {
      return { status: 'invalid', reason: 'runtime discovery record is not valid JSON' }
    }
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function runtimeHealthUrl(runtime: RuntimeDiscoveryRecord): string {
  const host = connectableHost(runtime.host)
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${urlHost}:${runtime.port}/health`
}

function connectableHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {
    return '127.0.0.1'
  }
  return host.trim()
}

function isKunHealthResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return body.status === 'ok' && body.service === 'kun' && body.mode === 'serve'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
