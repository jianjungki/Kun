import type { ReactElement } from 'react'
import type {
  AppSettingsPatch,
  AppSettingsV1,
  ModelProviderKind,
  ModelProviderProfileV1,
  ModelProviderSettingsV1,
  StudioMediaGenerationSettingsV1
} from '@shared/app-settings'
import { SecretInput, SettingsCard, SettingRow, Toggle } from './settings-controls'

type StudioMediaKind = 'image' | 'video'

const IMAGE_PROVIDER_KINDS = new Set<ModelProviderKind>(['openai', 'openai-compatible', 'google', 'xai'])
const VIDEO_PROVIDER_KINDS = new Set<ModelProviderKind>(['google', 'xai'])

export function StudioSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    form,
    provider,
    update,
    showApiKey,
    setShowApiKey,
    selectControlClass
  } = ctx as {
    t: (key: string, opts?: Record<string, unknown>) => string
    form: AppSettingsV1
    provider: ModelProviderSettingsV1
    update: (partial: AppSettingsPatch) => void
    showApiKey: boolean
    setShowApiKey: (value: boolean) => void
    selectControlClass: string
  }
  const studio = form.studio
  const providers = provider.providers

  const updateStudio = (patch: AppSettingsPatch['studio']): void => {
    update({ studio: patch })
  }

  const updateMedia = (
    kind: StudioMediaKind,
    patch: Partial<StudioMediaGenerationSettingsV1>
  ): void => {
    updateStudio({
      [kind]: {
        ...studio[kind],
        ...patch
      }
    })
  }

  const updateMediaProvider = (kind: StudioMediaKind, providerId: string): void => {
    const selected = providers.find((item) => item.id === providerId)
    updateMedia(kind, {
      providerId,
      providerKind: selected?.providerKind ?? studio[kind].providerKind
    })
  }

  return (
    <>
      <SettingsCard title={t('studio')}>
        <SettingRow
          title={t('studioEnabled')}
          description={t('studioEnabledDesc')}
          control={
            <Toggle
              checked={studio.enabled}
              onChange={(enabled) => updateStudio({ enabled })}
            />
          }
        />
      </SettingsCard>

      <div className="mt-6">
        <StudioMediaSettingsCard
          kind="image"
          enabled={studio.enabled}
          media={studio.image}
          providers={providers}
          t={t}
          showApiKey={showApiKey}
          setShowApiKey={setShowApiKey}
          selectControlClass={selectControlClass}
          onChange={(patch) => updateMedia('image', patch)}
          onProviderChange={(providerId) => updateMediaProvider('image', providerId)}
        />
      </div>

      <div className="mt-6">
        <StudioMediaSettingsCard
          kind="video"
          enabled={studio.enabled}
          media={studio.video}
          providers={providers}
          t={t}
          showApiKey={showApiKey}
          setShowApiKey={setShowApiKey}
          selectControlClass={selectControlClass}
          onChange={(patch) => updateMedia('video', patch)}
          onProviderChange={(providerId) => updateMediaProvider('video', providerId)}
        />
      </div>
    </>
  )
}

function StudioMediaSettingsCard({
  kind,
  enabled,
  media,
  providers,
  t,
  showApiKey,
  setShowApiKey,
  selectControlClass,
  onChange,
  onProviderChange
}: {
  kind: StudioMediaKind
  enabled: boolean
  media: StudioMediaGenerationSettingsV1
  providers: ModelProviderProfileV1[]
  t: (key: string, opts?: Record<string, unknown>) => string
  showApiKey: boolean
  setShowApiKey: (value: boolean) => void
  selectControlClass: string
  onChange: (patch: Partial<StudioMediaGenerationSettingsV1>) => void
  onProviderChange: (providerId: string) => void
}): ReactElement {
  const selectedProvider = providers.find((item) => item.id === media.providerId) ?? providers[0]
  const providerKind = selectedProvider?.providerKind ?? media.providerKind
  const supported = kind === 'image'
    ? IMAGE_PROVIDER_KINDS.has(providerKind)
    : VIDEO_PROVIDER_KINDS.has(providerKind)
  const cardTitle = kind === 'image' ? t('studioImageTitle') : t('studioVideoTitle')
  const disabled = !enabled

  return (
    <SettingsCard title={cardTitle}>
      <SettingRow
        title={kind === 'image' ? t('studioImageEnabled') : t('studioVideoEnabled')}
        description={kind === 'image' ? t('studioImageEnabledDesc') : t('studioVideoEnabledDesc')}
        control={
          <Toggle
            checked={enabled && media.enabled}
            disabled={disabled}
            onChange={(value) => onChange({ enabled: value })}
          />
        }
      />
      <SettingRow
        title={t('studioProvider')}
        description={supported ? t('studioProviderReady') : t('studioProviderUnsupported')}
        control={
          <select
            className={selectControlClass}
            value={media.providerId}
            disabled={disabled}
            onChange={(event) => onProviderChange(event.target.value)}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        }
      />
      <SettingRow
        title={t('studioModel')}
        description={kind === 'image' ? t('studioImageModelDesc') : t('studioVideoModelDesc')}
        control={
          <input
            className={selectControlClass}
            value={media.model}
            disabled={disabled}
            onChange={(event) => onChange({ model: event.target.value })}
            placeholder={kind === 'image' ? 'gpt-image-1' : 'veo-3.1-fast-generate-preview'}
          />
        }
      />
      <SettingRow
        title={t('studioApiKey')}
        description={t('studioApiKeyDesc')}
        control={
          <SecretInput
            value={media.apiKey}
            visible={showApiKey}
            onToggleVisibility={() => setShowApiKey(!showApiKey)}
            onChange={(value) => onChange({ apiKey: value })}
            placeholder={t('studioApiKeyPlaceholder')}
            showLabel={t('showSecret')}
            hideLabel={t('hideSecret')}
          />
        }
      />
      <SettingRow
        title={t('studioBaseUrl')}
        description={t('studioBaseUrlDesc')}
        control={
          <input
            className={selectControlClass}
            value={media.baseUrl}
            disabled={disabled}
            onChange={(event) => onChange({ baseUrl: event.target.value })}
            placeholder={selectedProvider?.baseUrl || 'https://api.example.com/v1'}
          />
        }
      />
    </SettingsCard>
  )
}
