import { existsSync, readFileSync } from 'node:fs'
import {
  McpServerConfig,
  type McpServerConfig as McpServerConfigValue
} from '../contracts/capabilities.js'

export function readImportedMcpServersFile(
  path: string | undefined
): Record<string, McpServerConfigValue> {
  const trimmed = path?.trim()
  if (!trimmed || !existsSync(trimmed)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(trimmed, 'utf8')) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read imported MCP config at ${trimmed}: ${message}`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Imported MCP config at ${trimmed} must contain a JSON object`)
  }
  return normalizeImportedMcpServers(parsed)
}

export function normalizeImportedMcpServers(
  input: unknown
): Record<string, McpServerConfigValue> {
  const config = objectValue(input)
  const directServers = objectValue(config.servers)
  const rawServers = Object.keys(directServers).length > 0
    ? directServers
    : objectValue(objectValue(config.capabilities).mcp).servers
  const normalized: Record<string, McpServerConfigValue> = {}
  for (const [serverId, server] of Object.entries(objectValue(rawServers))) {
    const value = normalizeImportedMcpServer(server)
    if (value) normalized[serverId] = value
  }
  return normalized
}

function normalizeImportedMcpServer(server: unknown): McpServerConfigValue | null {
  const raw = objectValue(server)
  const command = scalarStringValue(raw.command)
  const url = scalarStringValue(raw.url)
  const args = stringArrayValue(raw.args)
  const headers = stringRecordValue(raw.headers)
  const env = stringRecordValue(raw.env)
  const transport = normalizeMcpTransport(raw.transport, command, url)
  if (!transport) return null

  const trustedWorkspaceRoots = stringArrayValue(raw.trustedWorkspaceRoots)
  const trustScope = raw.trustScope === 'user' || raw.trustScope === 'workspace'
    ? raw.trustScope
    : trustedWorkspaceRoots.length > 0
      ? 'workspace'
      : 'user'
  if (trustScope === 'workspace' && trustedWorkspaceRoots.length === 0) return null

  const timeoutMs = positiveIntegerValue(raw.timeoutMs)
  const parsed = McpServerConfig.safeParse({
    enabled: raw.enabled === false || raw.disabled === true ? false : true,
    transport,
    ...(command ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(url ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    trustScope,
    ...(trustedWorkspaceRoots.length > 0 ? { trustedWorkspaceRoots } : {}),
    ...(timeoutMs ? { timeoutMs } : {})
  })
  return parsed.success ? parsed.data : null
}

function normalizeMcpTransport(
  value: unknown,
  command: string | undefined,
  url: string | undefined
): 'stdio' | 'streamable-http' | 'sse' | null {
  if (value === 'stdio' || value === 'streamable-http' || value === 'sse') return value
  if (command) return 'stdio'
  if (url) return 'streamable-http'
  return null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function scalarStringValue(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined
}

function stringRecordValue(value: unknown): Record<string, string> {
  const record = objectValue(value)
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    const normalized = scalarStringValue(item)
    if (normalized !== undefined) next[key] = normalized
  }
  return next
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
