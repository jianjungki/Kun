import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_MODEL_PROVIDER_KIND,
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  DEFAULT_MODEL_PROVIDER_ID,
  DEFAULT_OPENAI_COMPAT_BASE_URL,
  type AppSettingsV1,
  type KunRuntimeSettingsV1,
  type ModelProviderKind,
  type ModelProviderProfilePatchV1,
  type ModelProviderProfileV1,
  type ModelProviderSettingsPatchV1,
  type ModelProviderSettingsV1
} from './app-settings-types'
import { normalizeModelEndpointFormat } from '../../kun/src/contracts/model-endpoint-format.js'
import { normalizeModelProviderKind } from '../../kun/src/contracts/model-provider.js'
import { getKunRuntimeSettings } from './app-settings-kun'
import { DEFAULT_COMPOSER_MODEL_IDS } from './default-composer-models'

const DEFAULT_MODEL_PROVIDER_NAME = 'DeepSeek'
const CUSTOM_PROVIDER_BASE_URL = 'https://api.example.com/v1'

const MODEL_PROVIDER_PRESETS: ModelProviderProfileV1[] = [
  {
    id: DEFAULT_MODEL_PROVIDER_ID,
    name: DEFAULT_MODEL_PROVIDER_NAME,
    providerKind: 'openai-compatible',
    apiKey: '',
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    endpointFormat: DEFAULT_MODEL_ENDPOINT_FORMAT,
    models: DEFAULT_COMPOSER_MODEL_IDS.filter((id) => id !== 'auto')
  },
  {
    id: 'openai',
    name: 'OpenAI',
    providerKind: 'openai',
    apiKey: '',
    baseUrl: DEFAULT_OPENAI_COMPAT_BASE_URL,
    endpointFormat: 'responses',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini']
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    providerKind: 'anthropic',
    apiKey: '',
    baseUrl: 'https://api.anthropic.com/v1',
    endpointFormat: 'messages',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest']
  },
  {
    id: 'google',
    name: 'Google Gemini',
    providerKind: 'google',
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    endpointFormat: 'chat_completions',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']
  },
  {
    id: 'mistral',
    name: 'Mistral',
    providerKind: 'mistral',
    apiKey: '',
    baseUrl: 'https://api.mistral.ai/v1',
    endpointFormat: 'chat_completions',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest']
  },
  {
    id: 'xai',
    name: 'xAI',
    providerKind: 'xai',
    apiKey: '',
    baseUrl: 'https://api.x.ai/v1',
    endpointFormat: 'chat_completions',
    models: ['grok-4', 'grok-3', 'grok-3-mini']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    providerKind: 'openai-compatible',
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    endpointFormat: 'chat_completions',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-flash']
  },
  {
    id: 'ollama',
    name: 'Ollama',
    providerKind: 'openai-compatible',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    endpointFormat: 'chat_completions',
    models: ['llama3.1', 'qwen2.5-coder', 'mistral']
  },
  {
    id: 'custom-openai-compatible',
    name: 'Custom OpenAI Compatible',
    providerKind: 'openai-compatible',
    apiKey: '',
    baseUrl: CUSTOM_PROVIDER_BASE_URL,
    endpointFormat: 'chat_completions',
    models: []
  }
]

export function defaultModelProviderSettings(): ModelProviderSettingsV1 {
  const providers = defaultModelProviderProfiles('', DEFAULT_DEEPSEEK_BASE_URL)
  const defaultProvider = providers.find((provider) => provider.id === DEFAULT_MODEL_PROVIDER_ID) ?? providers[0]
  return {
    apiKey: defaultProvider.apiKey,
    baseUrl: defaultProvider.baseUrl,
    providers
  }
}

export function normalizeModelProviderSettings(
  input: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsV1 {
  const defaults = defaultModelProviderSettings()
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : defaults.apiKey
  const baseUrl =
    typeof input?.baseUrl === 'string' && input.baseUrl.trim()
      ? normalizeModelBaseUrl(input.baseUrl, DEFAULT_DEEPSEEK_BASE_URL)
      : defaults.baseUrl
  const rawProviders = Array.isArray(input?.providers) ? input.providers : []
  const providersById = new Map<string, ModelProviderProfileV1>()
  const defaultProviders = defaultModelProviderProfiles(apiKey, baseUrl)
  for (const provider of defaultProviders) {
    providersById.set(provider.id, provider)
  }
  for (const rawProvider of rawProviders) {
    const provider = normalizeModelProviderProfile(rawProvider)
    if (!provider) continue
    providersById.set(provider.id, provider.id === DEFAULT_MODEL_PROVIDER_ID
      ? {
          ...(defaultProviders.find((item) => item.id === DEFAULT_MODEL_PROVIDER_ID) ?? provider),
          ...provider,
          apiKey,
          baseUrl
        }
      : provider)
  }
  const providers = [...providersById.values()]
  return {
    apiKey,
    baseUrl,
    providers
  }
}

export function mergeModelProviderSettings(
  current: ModelProviderSettingsV1,
  patch: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsV1 {
  return normalizeModelProviderSettings({
    ...current,
    ...(patch ?? {})
  })
}

export function getModelProviderSettings(settings: AppSettingsV1): ModelProviderSettingsV1 {
  return normalizeModelProviderSettings((settings as { provider?: ModelProviderSettingsPatchV1 }).provider)
}

export function modelProviderSettingsPatch(
  provider: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsPatchV1 {
  return provider ? { ...provider } : {}
}

export function resolveModelProviderApiKey(settings: AppSettingsV1): string {
  return getDefaultModelProviderProfile(settings).apiKey.trim()
}

export function resolveModelProviderBaseUrl(settings: AppSettingsV1): string {
  const provider = getDefaultModelProviderProfile(settings)
  return normalizeModelBaseUrl(provider.baseUrl, defaultBaseUrlForProviderKind(provider.providerKind))
}

export function getDefaultModelProviderProfile(settings: AppSettingsV1): ModelProviderProfileV1 {
  return getModelProviderProfile(settings, DEFAULT_MODEL_PROVIDER_ID)
}

export function getModelProviderProfile(
  settings: AppSettingsV1,
  providerId: string | undefined
): ModelProviderProfileV1 {
  const provider = getModelProviderSettings(settings)
  const id = normalizeModelProviderId(providerId || DEFAULT_MODEL_PROVIDER_ID)
  return provider.providers.find((profile) => profile.id === id) ?? provider.providers[0] ?? defaultModelProviderProfile(provider.apiKey, provider.baseUrl)
}

export function listModelProviderModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  for (const provider of getModelProviderSettings(settings).providers) {
    for (const model of provider.models) {
      const trimmed = model.trim()
      if (trimmed) ids.add(trimmed)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function resolveKunRuntimeSettings(settings: AppSettingsV1): KunRuntimeSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const provider = getModelProviderProfile(settings, runtime.providerId)
  const runtimeApiKey = runtime.apiKey?.trim() ?? ''
  const runtimeBaseUrl = runtime.baseUrl?.trim() ?? ''
  const providerBaseUrl = provider.baseUrl.trim() || defaultBaseUrlForProviderKind(provider.providerKind)

  return {
    ...runtime,
    apiKey: runtimeApiKey || provider.apiKey.trim(),
    providerKind: provider.providerKind,
    baseUrl: runtimeBaseUrl
      ? normalizeModelBaseUrl(runtimeBaseUrl, providerBaseUrl)
      : normalizeModelBaseUrl(providerBaseUrl, defaultBaseUrlForProviderKind(provider.providerKind)),
    endpointFormat: provider.endpointFormat
  }
}

function defaultModelProviderProfile(apiKey: string, baseUrl: string): ModelProviderProfileV1 {
  return {
    id: DEFAULT_MODEL_PROVIDER_ID,
    name: DEFAULT_MODEL_PROVIDER_NAME,
    providerKind: DEFAULT_MODEL_PROVIDER_KIND,
    apiKey: apiKey.trim(),
    baseUrl: normalizeModelBaseUrl(baseUrl, DEFAULT_DEEPSEEK_BASE_URL),
    endpointFormat: DEFAULT_MODEL_ENDPOINT_FORMAT,
    models: DEFAULT_COMPOSER_MODEL_IDS.filter((id) => id !== 'auto')
  }
}

function defaultModelProviderProfiles(apiKey: string, baseUrl: string): ModelProviderProfileV1[] {
  const defaultProvider = defaultModelProviderProfile(apiKey, baseUrl)
  return MODEL_PROVIDER_PRESETS.map((preset) =>
    preset.id === DEFAULT_MODEL_PROVIDER_ID
      ? defaultProvider
      : { ...preset, models: [...preset.models] }
  )
}

function normalizeModelProviderProfile(
  input: ModelProviderProfilePatchV1 | undefined
): ModelProviderProfileV1 | null {
  const id = normalizeModelProviderId(input?.id)
  if (!id) return null
  const preset = MODEL_PROVIDER_PRESETS.find((provider) => provider.id === id)
  const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : id
  const providerKind = normalizeModelProviderKind(input?.providerKind ?? preset?.providerKind)
  const baseUrl =
    typeof input?.baseUrl === 'string' && input.baseUrl.trim()
      ? normalizeModelBaseUrl(input.baseUrl, preset?.baseUrl ?? defaultBaseUrlForProviderKind(providerKind))
      : preset?.baseUrl ?? defaultBaseUrlForProviderKind(providerKind)
  const models = normalizeProviderModels(input?.models)
  return {
    id,
    name,
    providerKind,
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey.trim() : '',
    baseUrl,
    endpointFormat: normalizeModelEndpointFormat(input?.endpointFormat),
    models: models.length > 0 ? models : preset?.models ?? []
  }
}

function normalizeProviderModels(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  const ids = new Set<string>()
  for (const model of models) {
    if (typeof model !== 'string') continue
    const trimmed = model.trim()
    if (trimmed) ids.add(trimmed)
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function normalizeModelProviderId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    : ''
}

function defaultBaseUrlForProviderKind(providerKind: ModelProviderKind): string {
  switch (providerKind) {
    case 'openai':
    case 'openai-compatible':
      return DEFAULT_OPENAI_COMPAT_BASE_URL
    case 'anthropic':
      return 'https://api.anthropic.com/v1'
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'mistral':
      return 'https://api.mistral.ai/v1'
    case 'xai':
      return 'https://api.x.ai/v1'
  }
}

function normalizeModelBaseUrl(value: string | null | undefined, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || fallback
}
