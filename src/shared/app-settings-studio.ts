import {
  DEFAULT_MODEL_PROVIDER_ID,
  DEFAULT_MODEL_PROVIDER_KIND,
  type AppSettingsV1,
  type ModelProviderKind,
  type StudioMediaGenerationSettingsPatchV1,
  type StudioMediaGenerationSettingsV1,
  type StudioSettingsPatchV1,
  type StudioSettingsV1
} from './app-settings-types'
import { normalizeModelProviderKind } from '../../kun/src/contracts/model-provider.js'

export const DEFAULT_STUDIO_IMAGE_MODEL = 'gpt-image-1'
export const DEFAULT_STUDIO_VIDEO_MODEL = 'veo-3.1-fast-generate-preview'

export function defaultStudioMediaGenerationSettings(
  kind: 'image' | 'video'
): StudioMediaGenerationSettingsV1 {
  return {
    enabled: false,
    providerId: kind === 'image' ? 'openai' : 'google',
    providerKind: kind === 'image' ? 'openai' : 'google',
    apiKey: '',
    baseUrl: '',
    model: kind === 'image' ? DEFAULT_STUDIO_IMAGE_MODEL : DEFAULT_STUDIO_VIDEO_MODEL
  }
}

export function defaultStudioSettings(): StudioSettingsV1 {
  return {
    enabled: false,
    image: defaultStudioMediaGenerationSettings('image'),
    video: defaultStudioMediaGenerationSettings('video')
  }
}

export function normalizeStudioSettings(
  input: StudioSettingsPatchV1 | undefined
): StudioSettingsV1 {
  return mergeStudioSettings(defaultStudioSettings(), input)
}

export function mergeStudioSettings(
  current: StudioSettingsV1,
  patch: StudioSettingsPatchV1 | undefined
): StudioSettingsV1 {
  return {
    enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
    image: mergeStudioMediaGenerationSettings(current.image, patch?.image, 'image'),
    video: mergeStudioMediaGenerationSettings(current.video, patch?.video, 'video')
  }
}

export function getStudioSettings(settings: AppSettingsV1): StudioSettingsV1 {
  const raw = (settings as { studio?: Partial<StudioSettingsV1> }).studio
  return mergeStudioSettings(defaultStudioSettings(), raw)
}

function mergeStudioMediaGenerationSettings(
  current: StudioMediaGenerationSettingsV1,
  patch: StudioMediaGenerationSettingsPatchV1 | undefined,
  kind: 'image' | 'video'
): StudioMediaGenerationSettingsV1 {
  const fallback = defaultStudioMediaGenerationSettings(kind)
  const providerKind = normalizeStudioProviderKind(patch?.providerKind ?? current.providerKind)
  const providerId = normalizeProviderId(
    typeof patch?.providerId === 'string' ? patch.providerId : current.providerId,
    fallback.providerId
  )
  return {
    enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
    providerId,
    providerKind,
    apiKey: typeof patch?.apiKey === 'string' ? patch.apiKey : current.apiKey,
    baseUrl: typeof patch?.baseUrl === 'string' ? patch.baseUrl.trim() : current.baseUrl,
    model: normalizeModelId(patch?.model ?? current.model, fallback.model)
  }
}

function normalizeStudioProviderKind(value: unknown): ModelProviderKind {
  return normalizeModelProviderKind(value ?? DEFAULT_MODEL_PROVIDER_KIND)
}

function normalizeProviderId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback || DEFAULT_MODEL_PROVIDER_ID
  const trimmed = value.trim()
  return trimmed || fallback || DEFAULT_MODEL_PROVIDER_ID
}

function normalizeModelId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}
