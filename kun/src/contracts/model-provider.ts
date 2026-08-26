export const MODEL_PROVIDER_KINDS = [
  'openai-compatible',
  'openai',
  'anthropic',
  'google',
  'mistral',
  'xai'
] as const

export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number]

export const DEFAULT_MODEL_PROVIDER_KIND: ModelProviderKind = 'openai-compatible'

export function normalizeModelProviderKind(value: unknown): ModelProviderKind {
  if (typeof value !== 'string') return DEFAULT_MODEL_PROVIDER_KIND
  const normalized = value.trim().toLowerCase().replace(/_/g, '-')
  switch (normalized) {
    case 'openai-compatible':
    case 'openai-compat':
    case 'compatible':
      return 'openai-compatible'
    case 'openai':
    case 'anthropic':
    case 'google':
    case 'mistral':
    case 'xai':
      return normalized
    default:
      return DEFAULT_MODEL_PROVIDER_KIND
  }
}
