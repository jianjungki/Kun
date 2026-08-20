import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  defaultKunTokenEconomySettings,
  getModelProviderProfile,
  getStudioSettings,
  isKunRuntimeInsecure,
  resolveKunRuntimeSettings,
  type StudioMediaGenerationSettingsV1,
  type KunRuntimeSettingsV1,
  type AppSettingsV1
} from '../shared/app-settings'
import {
  buildKunServeArgs,
  resolveKunExecutable
} from './resolve-kun-binary'
import {
  KunConfigSchema,
  KunServeConfigSchema,
  ModelConfigSchema,
  ContextCompactionConfigSchema,
  RuntimeTuningConfigSchema,
  StudioRuntimeConfigSchema
} from '../../kun/src/config/kun-config.js'
import { atomicWriteFile } from '../../kun/src/adapters/file/atomic-write.js'
import {
  AttachmentsCapabilityConfig,
  BrowserCapabilityConfig,
  ComputerUseCapabilityConfig,
  ExtensionsCapabilityConfig,
  GraphCapabilityConfig,
  LspCapabilityConfig,
  McpCapabilityConfig,
  MemoryCapabilityConfig,
  SkillsCapabilityConfig,
  SubagentsCapabilityConfig,
  WebCapabilityConfig
} from '../../kun/src/contracts/capabilities.js'
import { normalizeImportedMcpServers } from '../../kun/src/config/mcp-config-import.js'
import {
  buildClawScheduleMcpArgs,
  GUI_SCHEDULE_MCP_SERVER_NAME,
  resolveClawScheduleMcpCommand,
  resolveKunMcpJsonPath,
  type ClawScheduleMcpLaunchConfig
} from './claw-schedule-mcp-config'
import { defaultKunDataDir } from './runtime/kun-adapter'
import { appendManagedLogLine } from './logger'
import { guiSkillRootsForRuntime, normalizeSkillRootPath } from './services/skill-service'

let child: ChildProcess | null = null
let childLogCapture: KunChildLogCapture | null = null
let lastResolvedBinary: string | null = null
const KUN_READY_PREFIX = 'KUN_READY '
const KUN_STARTUP_TIMEOUT_MS = 15_000
const KUN_STOP_GRACE_MS = 5_000
const KUN_STOP_FORCE_MS = 1_000
const STDERR_TAIL_MAX_CHARS = 4_000
const GUI_SCHEDULE_MCP_TIMEOUT_MS = 5_000
const KUN_GUI_MCP_CONFIG_PATH_ENV = 'KUN_GUI_MCP_CONFIG_PATH'
const DEFAULT_KUN_MODEL_PROFILES: Record<string, Record<string, unknown>> = {
  'deepseek-v4-pro': {
    contextWindowTokens: 1_000_000,
    contextCompaction: {
      softThreshold: 980_000,
      hardThreshold: 990_000
    },
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text']
  },
  'deepseek-v4-flash': {
    aliases: ['deepseek-chat', 'deepseek-reasoner'],
    contextWindowTokens: 1_000_000,
    contextCompaction: {
      softThreshold: 980_000,
      hardThreshold: 990_000
    },
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text']
  }
}

type KunLogStream = 'stdout' | 'stderr' | 'lifecycle'
type KunChildLogCapture = {
  captureStdout: (chunk: Buffer | string) => void
  captureStderr: (chunk: Buffer | string) => void
  logLifecycle: (message: string) => void
  close: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appendTail(current: string, nextChunk: string, maxChars = STDERR_TAIL_MAX_CHARS): string {
  const combined = `${current}${nextChunk}`
  return combined.length > maxChars ? combined.slice(-maxChars) : combined
}

function formatKunLogLine(
  stream: KunLogStream,
  pid: number | undefined,
  message: string
): string {
  const stamp = new Date().toISOString()
  const pidLabel = typeof pid === 'number' ? `kun pid=${pid}` : 'kun'
  return `[${stamp}] [${stream.toUpperCase()}] [${pidLabel}] ${message}\n`
}

function normalizeCapturedChunk(chunk: Buffer | string): string {
  return String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function createKunChildLogCapture(pid: number | undefined): KunChildLogCapture {
  let stdoutRemainder = ''
  let stderrRemainder = ''
  let closed = false
  let pending = Promise.resolve()

  const writeLine = (stream: KunLogStream, message: string): void => {
    pending = pending
      .then(() => appendManagedLogLine('kun', formatKunLogLine(stream, pid, message)))
      .catch(() => undefined)
  }

  const captureChunk = (
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string
  ): void => {
    if (closed) return
    const text = normalizeCapturedChunk(chunk)
    const buffered = `${stream === 'stdout' ? stdoutRemainder : stderrRemainder}${text}`
    const parts = buffered.split('\n')
    const remainder = parts.pop() ?? ''
    if (stream === 'stdout') {
      stdoutRemainder = remainder
    } else {
      stderrRemainder = remainder
    }
    for (const part of parts) {
      writeLine(stream, part)
    }
  }

  return {
    captureStdout(chunk) {
      captureChunk('stdout', chunk)
    },
    captureStderr(chunk) {
      captureChunk('stderr', chunk)
    },
    logLifecycle(message) {
      if (closed) return
      writeLine('lifecycle', message)
    },
    async close() {
      if (closed) {
        await pending
        return
      }
      closed = true
      if (stdoutRemainder) {
        writeLine('stdout', stdoutRemainder)
        stdoutRemainder = ''
      }
      if (stderrRemainder) {
        writeLine('stderr', stderrRemainder)
        stderrRemainder = ''
      }
      await pending
    }
  }
}

function appRoot(): string {
  return app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
}

export function resolveKunDataDir(runtime: { dataDir: string }): string {
  const trimmed = runtime.dataDir?.trim()
  if (trimmed) return expandHomePath(trimmed)
  return defaultKunDataDir()
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2).replace(/\\/g, '/'))
  }
  return path
}

export function isKunChildRunning(): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null
}

export async function startKunChild(settings: AppSettingsV1): Promise<void> {
  const runtime = resolveKunRuntimeSettings(settings)
  if (isKunChildRunning()) return
  if (!runtime.autoStart) return
  if (childLogCapture) {
    await childLogCapture.close()
    childLogCapture = null
  }
  const root = appRoot()
  const resolution = resolveKunExecutable(root, runtime.binaryPath)
  if (resolution.command === process.execPath && !existsSync(resolution.args[0])) {
    throw new Error(
      `PengCodex Core build is missing at ${resolution.args[0]}. Run \`npm run build:kun\` before starting the GUI.`
    )
  }
  const dataDir = resolveKunDataDir(runtime)
  if (!runtime.insecure && !runtime.runtimeToken.trim()) {
    throw new Error(
      'PengCodex Core authentication requires a runtime token. Reload settings to generate one or explicitly enable insecure mode for local development.'
    )
  }
  const mcpLaunch = {
    appPath: app.getAppPath(),
    execPath: process.execPath,
    isPackaged: app.isPackaged
  }
  await syncGuiManagedKunConfig(dataDir, runtime, {
    settings,
    scheduleMcp: {
      settings,
      launch: {
        ...mcpLaunch
      }
    }
  })
  lastResolvedBinary = resolution.command === process.execPath
    ? resolution.args.join(' ')
    : resolution.command
  const args = buildKunServeArgs({
    resolution,
    host: '127.0.0.1',
    port: runtime.port,
    dataDir,
    baseUrl: runtime.baseUrl,
    providerKind: runtime.providerKind,
    endpointFormat: runtime.endpointFormat,
    model: runtime.model,
    approvalPolicy: runtime.approvalPolicy,
    sandboxMode: runtime.sandboxMode,
    tokenEconomyMode: runtime.tokenEconomyMode,
    insecure: isKunRuntimeInsecure(runtime)
  })
  child = spawn(resolution.command, args, {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      KUN_RUNTIME_TOKEN: runtime.runtimeToken,
      KUN_API_KEY: runtime.apiKey || process.env.KUN_API_KEY || process.env.DEEPSEEK_API_KEY || '',
      DEEPSEEK_API_KEY: runtime.apiKey || process.env.DEEPSEEK_API_KEY || '',
      KUN_WEB_API_KEY: runtime.webSearch.apiKey.trim(),
      KUN_WEB_FETCH_API_KEY: runtime.webSearch.fetchApiKey.trim(),
      KUN_STUDIO_IMAGE_API_KEY: studioApiKeyForSettings(settings, 'image'),
      KUN_STUDIO_VIDEO_API_KEY: studioApiKeyForSettings(settings, 'video'),
      [KUN_GUI_MCP_CONFIG_PATH_ENV]: resolveKunMcpJsonPath()
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })
  const startedChild = child
  const startedLogCapture = createKunChildLogCapture(startedChild.pid)
  childLogCapture = startedLogCapture
  startedLogCapture.logLifecycle(`spawned on port ${runtime.port} using data dir ${dataDir}`)
  startedChild.stdout?.on('data', startedLogCapture.captureStdout)
  startedChild.stderr?.on('data', startedLogCapture.captureStderr)
  child.on('exit', (code, signal) => {
    startedLogCapture.logLifecycle(
      signal
        ? `exited with signal ${signal}`
        : `exited with code ${code ?? 'unknown'}`
    )
    void startedLogCapture.close()
    if (child === startedChild) child = null
  })
  child.on('error', (error) => {
    startedLogCapture.logLifecycle(
      `process error: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  try {
    await waitForKunStartup(startedChild)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    startedLogCapture.logLifecycle(`startup failed before ready: ${message}`)
    if (child === startedChild) {
      await stopKunChildAndWait()
    }
    throw error
  }
  startedLogCapture.logLifecycle(`ready marker received on port ${runtime.port}`)
}

export async function syncGuiManagedKunConfig(
  dataDir: string,
  runtime: Pick<
    KunRuntimeSettingsV1,
    | 'mcpSearch'
    | 'webSearch'
    | 'skillRegistry'
    | 'tokenEconomy'
    | 'storage'
    | 'contextCompaction'
    | 'runtimeTuning'
  >,
  options?: {
    settings?: AppSettingsV1
    scheduleMcp?: {
      settings: AppSettingsV1
      launch: ClawScheduleMcpLaunchConfig
    }
    mcpConfigPath?: string
  }
): Promise<void> {
  const configPath = join(dataDir, 'config.json')
  const existing = sanitizeKunConfigSections(await readJsonObjectIfExists(configPath))
  const importedMcpServers = await readGuiManagedMcpServers(
    options?.mcpConfigPath ?? resolveKunMcpJsonPath()
  )
  const hasImportedEnabledMcpServer = Object.values(importedMcpServers).some(
    (server) => objectValue(server).enabled !== false
  )

  const serve = objectValue(existing?.serve)
  const existingTokenEconomy = objectValue(serve.tokenEconomy)
  const existingContextCompaction = objectValue(existing?.contextCompaction)
  const existingModels = objectValue(existing?.models)
  const existingRuntimeTuning = objectValue(existing?.runtime)
  const existingStudio = objectValue(existing?.studio)
  const capabilities = objectValue(existing?.capabilities)
  const mcp = objectValue(capabilities.mcp)
  const search = objectValue(mcp.search)
  const attachments = objectValue(capabilities.attachments)
  const web = objectValue(capabilities.web)
  const skills = objectValue(capabilities.skills)
  const storage = storageConfigForRuntime(runtime.storage)
  const mcpSearch = runtime.mcpSearch
  const webSearch = runtime.webSearch
  const existingWebProvider = scalarStringValue(web.provider)
  const webBase = { ...web }
  delete (webBase as { apiKey?: unknown }).apiKey
  delete (webBase as { baseUrl?: unknown }).baseUrl
  delete (webBase as { fetchApiKey?: unknown }).fetchApiKey
  delete (webBase as { fetchReaderBaseUrl?: unknown }).fetchReaderBaseUrl
  const existingMcpServers = objectValue(mcp.servers)
  const guiManagedMcpServerIds = new Set([
    ...Object.keys(importedMcpServers),
    GUI_SCHEDULE_MCP_SERVER_NAME
  ])
  const persistentMcpServers = Object.fromEntries(
    Object.entries(existingMcpServers).filter(([serverId]) => !guiManagedMcpServerIds.has(serverId))
  )
  const webSearchEnabled = webSearch.searchEnabled || webSearch.provider !== 'fetch'
  const webSearchUsesDefaultSettings = webSearch.provider === 'fetch' &&
    webSearch.enabled === true &&
    webSearch.fetchEnabled === true &&
    !webSearchEnabled &&
    webSearch.fetchProvider === 'direct' &&
    webSearch.fetchFallbackEnabled === false &&
    !webSearch.fetchApiKey.trim() &&
    !webSearch.fetchReaderBaseUrl.trim() &&
    !webSearch.apiKey.trim() &&
    !webSearch.baseUrl.trim() &&
    webSearch.allowDomains.length === 0 &&
    webSearch.denyDomains.length === 0
  const webSearchUsesDefaultProvider = webSearch.provider === 'fetch' &&
    !webSearchEnabled &&
    !webSearch.apiKey.trim() &&
    !webSearch.baseUrl.trim()
  const skillCapability = await skillCapabilityConfigForRuntime(
    skills,
    options?.scheduleMcp?.settings,
    runtime.skillRegistry
  )
  const settingsForStudio = options?.settings ?? options?.scheduleMcp?.settings
  const next = {
    serve: {
      ...serve,
      storage,
      tokenEconomy: tokenEconomyConfigForRuntime(runtime.tokenEconomy, existingTokenEconomy)
    },
    models: modelConfigForRuntime(existingModels),
    contextCompaction: contextCompactionConfigForRuntime(runtime.contextCompaction, existingContextCompaction),
    runtime: runtimeTuningConfigForRuntime(runtime.runtimeTuning, existingRuntimeTuning),
    studio: studioConfigForSettings(settingsForStudio, existingStudio),
    capabilities: {
      ...capabilities,
      attachments: {
        ...attachments,
        enabled: attachments.enabled === false ? false : true
      },
      web: {
        ...webBase,
        enabled: webSearch.enabled === false ? false : webSearchUsesDefaultSettings && web.enabled === false ? false : true,
        fetchEnabled: webSearch.fetchEnabled === false ? false : webSearchUsesDefaultSettings && web.fetchEnabled === false ? false : true,
        searchEnabled: webSearchEnabled || web.searchEnabled === true,
        provider: webSearchUsesDefaultProvider && existingWebProvider ? existingWebProvider : webSearch.provider,
        fetchProvider: webSearch.fetchProvider,
        fetchFallbackEnabled: webSearch.fetchFallbackEnabled,
        ...(webSearch.fetchReaderBaseUrl.trim() ? { fetchReaderBaseUrl: webSearch.fetchReaderBaseUrl } : {}),
        ...(webSearch.baseUrl.trim() ? { baseUrl: webSearch.baseUrl } : {}),
        allowDomains: webSearch.allowDomains,
        denyDomains: webSearch.denyDomains
      },
      skills: skillCapability,
      mcp: {
        ...mcp,
        ...(options?.scheduleMcp || mcpSearch.enabled || hasImportedEnabledMcpServer
          ? { enabled: mcp.enabled === false ? false : true }
          : {}),
        servers: {
          ...persistentMcpServers
        },
        search: {
          ...search,
          enabled: mcpSearch.enabled,
          mode: mcpSearch.mode,
          autoThresholdToolCount: mcpSearch.autoThresholdToolCount,
          topKDefault: mcpSearch.topKDefault,
          topKMax: mcpSearch.topKMax,
          minScore: mcpSearch.minScore
        }
      }
    }
  }
  const parsedNext = KunConfigSchema.safeParse(next)
  if (!parsedNext.success) {
    throw new Error(
      `Refusing to write invalid GUI-managed PengCodex Core config at ${configPath}: ${JSON.stringify(parsedNext.error.issues, null, 2)}`
    )
  }
  const nextText = `${JSON.stringify(next, null, 2)}\n`
  if (existing && nextText === `${JSON.stringify(existing, null, 2)}\n`) {
    await chmod(configPath, 0o600).catch(() => undefined)
    return
  }
  await mkdir(dirname(configPath), { recursive: true })
  // The GUI passes managed credentials to the child through its process
  // environment. The persisted Core config contains only non-secret state.
  await atomicWriteFile(configPath, nextText, { mode: 0o600 })
}

function buildGuiScheduleKunMcpServer(
  settings: AppSettingsV1,
  launch: ClawScheduleMcpLaunchConfig
): Record<string, unknown> {
  return {
    enabled: true,
    transport: 'stdio',
    command: resolveClawScheduleMcpCommand(launch),
    args: buildClawScheduleMcpArgs(settings, launch),
    env: {
      ELECTRON_RUN_AS_NODE: '1'
    },
    trustScope: 'user',
    timeoutMs: GUI_SCHEDULE_MCP_TIMEOUT_MS
  }
}

async function skillCapabilityConfigForRuntime(
  existing: Record<string, unknown>,
  settings?: AppSettingsV1,
  skillRegistry?: Pick<KunRuntimeSettingsV1, 'skillRegistry'>['skillRegistry']
): Promise<Record<string, unknown>> {
  const roots = uniqueStrings([
    ...stringArrayValue(existing.roots).map(normalizeSkillRootPath),
    ...(await guiSkillRootsForRuntime(settings)).map((root) => root.path)
  ])
  const enabledSkillIds = skillRegistry?.activationMode === 'selected'
    ? uniqueStrings(skillRegistry.activeSkillIds.map((id) => id.trim()).filter(Boolean))
    : []
  return {
    ...existing,
    enabled: existing.enabled === false ? false : roots.length > 0 || existing.enabled === true,
    roots,
    enabledSkillIds,
    legacySkillMd: existing.legacySkillMd === false ? false : true
  }
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

async function readGuiManagedMcpServers(path: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonObjectIfExists(path)
  return parsed ? normalizeImportedMcpServers(parsed) : {}
}

function scalarStringValue(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined
}

function modelConfigForRuntime(existing: Record<string, unknown>): Record<string, unknown> {
  const existingProfiles = objectValue(existing.profiles)
  const profiles: Record<string, unknown> = { ...DEFAULT_KUN_MODEL_PROFILES }
  for (const [modelId, profile] of Object.entries(existingProfiles)) {
    const defaultProfile = objectValue(DEFAULT_KUN_MODEL_PROFILES[modelId])
    const existingProfile = objectValue(profile)
    profiles[modelId] = {
      ...defaultProfile,
      ...existingProfile,
      contextCompaction: {
        ...objectValue(defaultProfile.contextCompaction),
        ...objectValue(existingProfile.contextCompaction)
      }
    }
  }
  return {
    ...existing,
    profiles
  }
}

function tokenEconomyConfigForRuntime(
  tokenEconomy: Pick<KunRuntimeSettingsV1, 'tokenEconomy'>['tokenEconomy'] | undefined,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const defaults = defaultKunTokenEconomySettings()
  const normalized = {
    ...defaults,
    ...(tokenEconomy ?? {}),
    historyHygiene: {
      ...defaults.historyHygiene,
      ...(tokenEconomy?.historyHygiene ?? {})
    }
  }
  const existingHistoryHygiene = objectValue(existing.historyHygiene)
  return {
    ...existing,
    enabled: normalized.enabled,
    compressToolDescriptions: normalized.compressToolDescriptions,
    compressToolResults: normalized.compressToolResults,
    conciseResponses: normalized.conciseResponses,
    historyHygiene: {
      ...existingHistoryHygiene,
      maxToolResultLines: normalized.historyHygiene.maxToolResultLines,
      maxToolResultBytes: normalized.historyHygiene.maxToolResultBytes,
      maxToolResultTokens: normalized.historyHygiene.maxToolResultTokens,
      maxToolArgumentStringBytes: normalized.historyHygiene.maxToolArgumentStringBytes,
      maxToolArgumentStringTokens: normalized.historyHygiene.maxToolArgumentStringTokens,
      maxArrayItems: normalized.historyHygiene.maxArrayItems
    }
  }
}

function storageConfigForRuntime(
  storage: Pick<KunRuntimeSettingsV1, 'storage'>['storage']
): Record<string, unknown> {
  const sqlitePath = storage.sqlitePath.trim()
  return {
    backend: storage.backend,
    ...(sqlitePath ? { sqlitePath } : {})
  }
}

function contextCompactionConfigForRuntime(
  contextCompaction: Pick<KunRuntimeSettingsV1, 'contextCompaction'>['contextCompaction'],
  existing: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...existing,
    defaultSoftThreshold: contextCompaction.defaultSoftThreshold,
    defaultHardThreshold: contextCompaction.defaultHardThreshold,
    summaryMode: contextCompaction.summaryMode,
    summaryTimeoutMs: contextCompaction.summaryTimeoutMs,
    summaryMaxTokens: contextCompaction.summaryMaxTokens,
    summaryInputMaxBytes: contextCompaction.summaryInputMaxBytes
  }
}

function runtimeTuningConfigForRuntime(
  runtimeTuning: Pick<KunRuntimeSettingsV1, 'runtimeTuning'>['runtimeTuning'],
  existing: Record<string, unknown>
): Record<string, unknown> {
  const existingToolStorm = objectValue(existing.toolStorm)
  const existingToolArgumentRepair = objectValue(existing.toolArgumentRepair)
  return {
    ...existing,
    toolStorm: {
      ...existingToolStorm,
      enabled: runtimeTuning.toolStorm.enabled,
      windowSize: runtimeTuning.toolStorm.windowSize,
      threshold: runtimeTuning.toolStorm.threshold
    },
    toolArgumentRepair: {
      ...existingToolArgumentRepair,
      maxStringBytes: runtimeTuning.toolArgumentRepair.maxStringBytes
    }
  }
}

function studioConfigForSettings(
  settings: AppSettingsV1 | undefined,
  existing: Record<string, unknown>
): Record<string, unknown> {
  if (!settings) return existing
  const studio = getStudioSettings(settings)
  return {
    ...existing,
    enabled: studio.enabled,
    image: studioMediaConfigForSettings(settings, studio.image, objectValue(existing.image)),
    video: studioMediaConfigForSettings(settings, studio.video, objectValue(existing.video))
  }
}

function studioMediaConfigForSettings(
  settings: AppSettingsV1,
  media: StudioMediaGenerationSettingsV1,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const provider = getModelProviderProfile(settings, media.providerId)
  const baseUrl = media.baseUrl.trim() || provider.baseUrl.trim()
  const persistent = { ...existing }
  delete (persistent as { apiKey?: unknown }).apiKey
  return {
    ...persistent,
    enabled: media.enabled,
    providerId: media.providerId,
    providerKind: provider.providerKind,
    baseUrl,
    model: media.model
  }
}

function studioApiKeyForSettings(
  settings: AppSettingsV1,
  kind: 'image' | 'video'
): string {
  const media = getStudioSettings(settings)[kind]
  const provider = getModelProviderProfile(settings, media.providerId)
  return media.apiKey.trim() || provider.apiKey.trim()
}

async function readJsonObjectIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Expected a JSON object in ${path}`)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}: ${error.message}`)
    throw error
  }
}

type SafeParseSchema = {
  safeParse: (value: unknown) =>
    | { success: true; data: unknown }
    | {
        success: false
        error: {
          issues: Array<{ code?: string; path?: PropertyKey[]; keys?: string[] }>
        }
      }
}

function parseKunConfigSection(
  schema: SafeParseSchema,
  value: unknown,
  section: string
): Record<string, unknown> {
  const source = objectValue(value)
  const parsed = schema.safeParse(source)
  if (!parsed.success && parsed.error.issues.every((issue) => issue.code === 'unrecognized_keys')) {
    const withoutUnknownKeys = removeUnrecognizedKeys(source, parsed.error.issues)
    const retried = schema.safeParse(withoutUnknownKeys)
    if (retried.success) return objectValue(retried.data)
  }
  if (!parsed.success) throw new Error(`Invalid existing PengCodex Core config section: ${section}`)
  return objectValue(parsed.data)
}

function removeUnrecognizedKeys(
  value: Record<string, unknown>,
  issues: Array<{ path?: PropertyKey[]; keys?: string[] }>
): Record<string, unknown> {
  const cloned = structuredClone(value)
  for (const issue of issues) {
    let target: unknown = cloned
    for (const segment of issue.path ?? []) {
      if (!target || typeof target !== 'object') break
      target = (target as Record<PropertyKey, unknown>)[segment]
    }
    if (!target || typeof target !== 'object' || Array.isArray(target)) continue
    for (const key of issue.keys ?? []) delete (target as Record<string, unknown>)[key]
  }
  return cloned
}

function sanitizeKunCapabilitiesConfig(value: unknown): Record<string, unknown> {
  const raw = objectValue(value)
  const next: Record<string, unknown> = {}
  if ('mcp' in raw) next.mcp = parseKunConfigSection(McpCapabilityConfig, raw.mcp, 'capabilities.mcp')
  if ('web' in raw) next.web = parseKunConfigSection(WebCapabilityConfig, raw.web, 'capabilities.web')
  if ('skills' in raw) next.skills = parseKunConfigSection(SkillsCapabilityConfig, raw.skills, 'capabilities.skills')
  if ('subagents' in raw) {
    next.subagents = parseKunConfigSection(SubagentsCapabilityConfig, raw.subagents, 'capabilities.subagents')
  }
  if ('attachments' in raw) {
    next.attachments = parseKunConfigSection(AttachmentsCapabilityConfig, raw.attachments, 'capabilities.attachments')
  }
  if ('memory' in raw) next.memory = parseKunConfigSection(MemoryCapabilityConfig, raw.memory, 'capabilities.memory')
  if ('lsp' in raw) next.lsp = parseKunConfigSection(LspCapabilityConfig, raw.lsp, 'capabilities.lsp')
  if ('browser' in raw) next.browser = parseKunConfigSection(BrowserCapabilityConfig, raw.browser, 'capabilities.browser')
  if ('computerUse' in raw) {
    next.computerUse = parseKunConfigSection(ComputerUseCapabilityConfig, raw.computerUse, 'capabilities.computerUse')
  }
  if ('graph' in raw) next.graph = parseKunConfigSection(GraphCapabilityConfig, raw.graph, 'capabilities.graph')
  if ('extensions' in raw) {
    next.extensions = parseKunConfigSection(ExtensionsCapabilityConfig, raw.extensions, 'capabilities.extensions')
  }
  return next
}

function sanitizeKunConfigSections(
  existing: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!existing) return null
  return {
    serve: parseKunConfigSection(KunServeConfigSchema, existing.serve, 'serve'),
    models: parseKunConfigSection(ModelConfigSchema, existing.models, 'models'),
    contextCompaction: parseKunConfigSection(
      ContextCompactionConfigSchema,
      existing.contextCompaction,
      'contextCompaction'
    ),
    runtime: parseKunConfigSection(RuntimeTuningConfigSchema, existing.runtime, 'runtime'),
    studio: parseKunConfigSection(StudioRuntimeConfigSchema, existing.studio, 'studio'),
    capabilities: sanitizeKunCapabilitiesConfig(existing.capabilities)
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export async function stopKunChildAndWait(): Promise<void> {
  if (!child) {
    if (childLogCapture) {
      const capture = childLogCapture
      childLogCapture = null
      await capture.close()
    }
    return
  }
  const stoppingChild = child
  const pid = child.pid
  const capture = childLogCapture
  if (stoppingChild.exitCode === null && stoppingChild.signalCode === null) {
    try {
      stoppingChild.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const exited = await waitForChildExit(stoppingChild, KUN_STOP_GRACE_MS)
  if (!exited) {
    try {
      if (pid) process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await waitForChildExit(stoppingChild, KUN_STOP_FORCE_MS)
  }
  if (child === stoppingChild) child = null
  if (capture) {
    childLogCapture = null
    await capture.close()
  }
}

function waitForChildExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => settle(false), timeoutMs)
    const settle = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('exit', onExit)
      process.removeListener('error', onError)
      resolve(exited)
    }
    const onExit = (): void => settle(true)
    const onError = (): void => settle(true)
    process.once('exit', onExit)
    process.once('error', onError)
  })
}

export async function reclaimKunPort(
  port: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (port <= 0) return { ok: true }
  const available = await canBindTcpPort(port, '127.0.0.1')
  return available
    ? { ok: true }
    : { ok: false, message: `port ${port} is in use` }
}

function canBindTcpPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const server = createServer()
    const settle = (available: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners('error')
      resolve(available)
    }
    server.unref()
    server.once('error', () => settle(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => settle(true))
    })
  })
}

async function waitForKunStartup(startedChild: ChildProcess): Promise<void> {
  if (startedChild.exitCode !== null) {
    throw new Error(describeKunExit(startedChild.exitCode, null))
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let stdoutBuffer = ''
    let stderrTail = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(describeKunStartupTimeout(stderrTail)))
    }, KUN_STARTUP_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      startedChild.removeListener('exit', onExit)
      startedChild.removeListener('error', onError)
      startedChild.stdout?.removeListener('data', onStdout)
      startedChild.stderr?.removeListener('data', onStderr)
    }
    const tryParseReady = (): boolean => {
      const markerIndex = stdoutBuffer.indexOf(KUN_READY_PREFIX)
      if (markerIndex < 0) return false
      const afterPrefix = stdoutBuffer.slice(markerIndex + KUN_READY_PREFIX.length)
      const newlineIndex = afterPrefix.indexOf('\n')
      if (newlineIndex < 0) return false
      const jsonLine = afterPrefix.slice(0, newlineIndex).trim()
      if (!jsonLine) return false
      try {
        const parsed = JSON.parse(jsonLine) as { service?: string; mode?: string; port?: number }
        return parsed.service === 'kun' && parsed.mode === 'serve' && typeof parsed.port === 'number'
      } catch {
        return false
      }
    }
    const settleReady = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuffer = appendTail(stdoutBuffer, String(chunk), STDERR_TAIL_MAX_CHARS * 2)
      if (tryParseReady()) settleReady()
    }
    const onStderr = (chunk: Buffer | string): void => {
      stderrTail = appendTail(stderrTail, String(chunk))
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(describeKunExit(code, signal, stderrTail)))
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    startedChild.stdout?.on('data', onStdout)
    startedChild.stderr?.on('data', onStderr)
    startedChild.once('exit', onExit)
    startedChild.once('error', onError)
  })
}

function describeKunExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail = ''
): string {
  const suffix = stderrTail.trim() ? `\n${stderrTail.trim()}` : ''
  if (signal) return `PengCodex Core exited during startup with signal ${signal}${suffix}`
  if (typeof code === 'number') return `PengCodex Core exited during startup with code ${code}${suffix}`
  return `PengCodex Core exited during startup${suffix}`
}

function describeKunStartupTimeout(stderrTail: string): string {
  const suffix = stderrTail.trim() ? `\n${stderrTail.trim()}` : ''
  return `PengCodex Core did not report ready within ${KUN_STARTUP_TIMEOUT_MS}ms${suffix}`
}
