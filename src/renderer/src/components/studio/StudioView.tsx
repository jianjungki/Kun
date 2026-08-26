import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Download, ExternalLink, Film, ImageIcon, Loader2, Settings, WandSparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppSettingsV1 } from '@shared/app-settings'
import {
  KUN_STUDIO_IMAGE_PATH,
  KUN_STUDIO_VIDEO_PATH
} from '@shared/kun-endpoints'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { SETTINGS_CHANGED_EVENT } from '../../lib/keyboard-shortcut-settings'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'

type StudioMode = 'image' | 'video'

type StudioGeneratedMedia = {
  mediaType: string
  base64: string
  dataUrl: string
  byteSize: number
}

type StudioGenerationResponse = {
  kind: StudioMode
  providerKind: string
  model: string
  files: StudioGeneratedMedia[]
  warnings?: unknown[]
}

const IMAGE_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const
const IMAGE_ASPECTS = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16'] as const
const VIDEO_ASPECTS = ['auto', '16:9', '9:16', '1:1'] as const
const VIDEO_RESOLUTIONS = ['auto', '1280x720', '1920x1080'] as const

export function StudioView({
  leftSidebarCollapsed,
  onToggleLeftSidebar,
  onOpenSettings
}: {
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
  onOpenSettings: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [settings, setSettings] = useState<AppSettingsV1 | null>(null)
  const [mode, setMode] = useState<StudioMode>('image')
  const [prompt, setPrompt] = useState('')
  const [imageCount, setImageCount] = useState(1)
  const [imageSize, setImageSize] = useState<(typeof IMAGE_SIZES)[number]>('1024x1024')
  const [imageAspect, setImageAspect] = useState<(typeof IMAGE_ASPECTS)[number]>('auto')
  const [videoCount, setVideoCount] = useState(1)
  const [videoAspect, setVideoAspect] = useState<(typeof VIDEO_ASPECTS)[number]>('16:9')
  const [videoResolution, setVideoResolution] = useState<(typeof VIDEO_RESOLUTIONS)[number]>('1280x720')
  const [videoDuration, setVideoDuration] = useState(6)
  const [videoFps, setVideoFps] = useState(24)
  const [videoAudio, setVideoAudio] = useState(false)
  const [seed, setSeed] = useState('')
  const [result, setResult] = useState<StudioGenerationResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const apply = (next: AppSettingsV1): void => {
      if (!cancelled) setSettings(next)
    }
    void rendererRuntimeClient.getSettings().then(apply).catch(() => undefined)
    const onSettingsChanged = (event: Event): void => {
      apply((event as CustomEvent<AppSettingsV1>).detail)
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => {
      cancelled = true
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    }
  }, [])

  const mediaSettings = settings?.studio[mode]
  const provider = useMemo(() => {
    if (!settings || !mediaSettings) return null
    return settings.provider.providers.find((item) => item.id === mediaSettings.providerId) ?? null
  }, [mediaSettings, settings])
  const studioEnabled = settings?.studio.enabled === true
  const capabilityEnabled = studioEnabled && mediaSettings?.enabled === true
  const promptReady = prompt.trim().length > 0
  const canGenerate = capabilityEnabled && promptReady && !busy

  const generate = async (): Promise<void> => {
    if (!mediaSettings || !canGenerate) return
    setBusy(true)
    setError(null)
    try {
      const seedValue = seed.trim() ? Number(seed.trim()) : undefined
      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        model: mediaSettings.model
      }
      if (Number.isInteger(seedValue)) body.seed = seedValue
      if (mode === 'image') {
        body.n = imageCount
        if (imageSize !== 'auto') body.size = imageSize
        if (imageAspect !== 'auto') body.aspectRatio = imageAspect
      } else {
        body.n = videoCount
        if (videoAspect !== 'auto') body.aspectRatio = videoAspect
        if (videoResolution !== 'auto') body.resolution = videoResolution
        body.duration = videoDuration
        body.fps = videoFps
        body.generateAudio = videoAudio
      }
      const response = await rendererRuntimeClient.runtimeRequest(
        mode === 'image' ? KUN_STUDIO_IMAGE_PATH : KUN_STUDIO_VIDEO_PATH,
        'POST',
        JSON.stringify(body)
      )
      if (!response.ok) {
        throw new Error(errorMessageFromBody(response.body) || `${response.status}`)
      }
      setResult(parseStudioResponse(response.body))
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : String(generationError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ds-drag flex h-full min-h-0 flex-col bg-ds-main">
      <header className="ds-no-drag flex min-h-[58px] shrink-0 items-center justify-between border-b border-ds-border px-4 sm:px-6">
        <div className={`flex min-w-0 items-center gap-3 ${leftSidebarCollapsed ? 'ds-window-controls-safe-inset' : ''}`}>
          {leftSidebarCollapsed ? (
            <SidebarTitlebarToggleButton
              onClick={onToggleLeftSidebar}
              title={t('sidebarExpand')}
              ariaLabel={t('sidebarExpand')}
            />
          ) : null}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ds-subtle text-accent">
            <WandSparkles className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold text-ds-ink">{t('studio')}</h1>
            <div className="truncate text-[12px] text-ds-faint">
              {[provider?.name || mediaSettings?.providerId, mediaSettings?.model].filter(Boolean).join(' / ') || t('loading')}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          title={t('openSettings')}
          aria-label={t('openSettings')}
        >
          <Settings className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </header>

      <div className="ds-no-drag grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col overflow-y-auto rounded-lg border border-ds-border bg-ds-card/95 p-4 shadow-sm">
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg border border-ds-border bg-ds-main/70 p-1">
            <ModeButton
              active={mode === 'image'}
              icon={<ImageIcon className="h-4 w-4" strokeWidth={1.8} />}
              label={t('studioImage')}
              onClick={() => setMode('image')}
            />
            <ModeButton
              active={mode === 'video'}
              icon={<Film className="h-4 w-4" strokeWidth={1.8} />}
              label={t('studioVideo')}
              onClick={() => setMode('video')}
            />
          </div>

          <label className="flex min-w-0 flex-col gap-2 text-[12px] font-medium text-ds-muted">
            {t('studioPrompt')}
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={mode === 'image' ? t('studioImagePromptPlaceholder') : t('studioVideoPromptPlaceholder')}
              className="min-h-[190px] resize-y rounded-lg border border-ds-border bg-ds-main/70 px-3 py-3 text-[14px] leading-6 text-ds-ink outline-none transition focus:border-accent/40 focus:ring-1 focus:ring-accent/25"
            />
          </label>

          <div className="mt-4 grid gap-3">
            {mode === 'image' ? (
              <>
                <SelectField label={t('studioSize')} value={imageSize} options={IMAGE_SIZES} onChange={setImageSize} />
                <SelectField label={t('studioAspect')} value={imageAspect} options={IMAGE_ASPECTS} onChange={setImageAspect} />
                <NumberField label={t('studioCount')} value={imageCount} min={1} max={4} onChange={setImageCount} />
              </>
            ) : (
              <>
                <SelectField label={t('studioAspect')} value={videoAspect} options={VIDEO_ASPECTS} onChange={setVideoAspect} />
                <SelectField label={t('studioResolution')} value={videoResolution} options={VIDEO_RESOLUTIONS} onChange={setVideoResolution} />
                <NumberField label={t('studioDuration')} value={videoDuration} min={1} max={60} onChange={setVideoDuration} />
                <NumberField label={t('studioFps')} value={videoFps} min={1} max={60} onChange={setVideoFps} />
                <label className="flex items-center justify-between gap-3 rounded-lg border border-ds-border bg-ds-main/45 px-3 py-2 text-[13px] text-ds-muted">
                  <span>{t('studioAudio')}</span>
                  <input
                    type="checkbox"
                    checked={videoAudio}
                    onChange={(event) => setVideoAudio(event.target.checked)}
                    className="h-4 w-4 accent-[var(--ds-accent)]"
                  />
                </label>
              </>
            )}
            <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-ds-muted">
              {t('studioSeed')}
              <input
                value={seed}
                onChange={(event) => setSeed(event.target.value.replace(/[^\d-]/g, ''))}
                placeholder={t('studioSeedPlaceholder')}
                className="rounded-lg border border-ds-border bg-ds-main/70 px-3 py-2 text-[14px] text-ds-ink outline-none transition focus:border-accent/40 focus:ring-1 focus:ring-accent/25"
              />
            </label>
          </div>

          {!studioEnabled ? (
            <StudioNotice message={t('studioDisabledNotice')} />
          ) : mediaSettings && !mediaSettings.enabled ? (
            <StudioNotice message={mode === 'image' ? t('studioImageDisabledNotice') : t('studioVideoDisabledNotice')} />
          ) : null}
          {error ? <StudioNotice tone="error" message={error} /> : null}

          <button
            type="button"
            disabled={!canGenerate}
            onClick={() => void generate()}
            className="mt-4 inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-semibold text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <WandSparkles className="h-4 w-4" strokeWidth={1.9} />}
            {busy ? t('studioGenerating') : mode === 'image' ? t('studioGenerateImage') : t('studioGenerateVideo')}
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto rounded-lg border border-ds-border bg-ds-card/80 p-4 shadow-sm">
          {result?.files.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {result.files.map((file, index) => (
                <MediaPreview
                  key={`${file.mediaType}-${file.byteSize}-${index}`}
                  mode={result.kind}
                  file={file}
                  index={index}
                  t={t}
                />
              ))}
            </div>
          ) : (
            <div className="flex h-full min-h-[360px] items-center justify-center rounded-lg border border-dashed border-ds-border bg-ds-main/35 text-center">
              <div className="max-w-xs px-6">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-ds-subtle text-ds-muted">
                  {mode === 'image' ? (
                    <ImageIcon className="h-5 w-5" strokeWidth={1.8} />
                  ) : (
                    <Film className="h-5 w-5" strokeWidth={1.8} />
                  )}
                </div>
                <div className="mt-3 text-[14px] font-semibold text-ds-ink">{t('studioEmptyTitle')}</div>
                <div className="mt-1 text-[13px] leading-6 text-ds-muted">{t('studioEmptySub')}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function ModeButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean
  icon: ReactElement
  label: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex min-h-[34px] items-center justify-center gap-2 rounded-md px-3 text-[13px] font-medium transition ${
        active ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-ds-muted">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="rounded-lg border border-ds-border bg-ds-main/70 px-3 py-2 text-[14px] text-ds-ink outline-none transition focus:border-accent/40 focus:ring-1 focus:ring-accent/25"
      >
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-ds-muted">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(clampNumber(Number(event.target.value), min, max))}
        className="rounded-lg border border-ds-border bg-ds-main/70 px-3 py-2 text-[14px] text-ds-ink outline-none transition focus:border-accent/40 focus:ring-1 focus:ring-accent/25"
      />
    </label>
  )
}

function StudioNotice({
  message,
  tone = 'info'
}: {
  message: string
  tone?: 'info' | 'error'
}): ReactElement {
  return (
    <div className={`mt-4 rounded-lg border px-3 py-2 text-[12.5px] leading-5 ${
      tone === 'error'
        ? 'border-red-300/70 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
        : 'border-ds-border-muted bg-ds-main/55 text-ds-muted'
    }`}>
      {message}
    </div>
  )
}

function MediaPreview({
  mode,
  file,
  index,
  t
}: {
  mode: StudioMode
  file: StudioGeneratedMedia
  index: number
  t: (key: string, opts?: Record<string, unknown>) => string
}): ReactElement {
  const fileName = `pengcodex-${mode}-${index + 1}.${extensionFromMediaType(file.mediaType)}`
  return (
    <article className="overflow-hidden rounded-lg border border-ds-border bg-ds-main/45">
      <div className="aspect-square bg-ds-subtle">
        {mode === 'image' ? (
          <img src={file.dataUrl} alt={fileName} className="h-full w-full object-contain" />
        ) : (
          <video src={file.dataUrl} controls className="h-full w-full object-contain" />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-ds-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-medium text-ds-ink">{fileName}</div>
          <div className="text-[11.5px] text-ds-faint">{formatBytes(file.byteSize)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => openMedia(file.dataUrl)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            title={t('studioOpenMedia')}
            aria-label={t('studioOpenMedia')}
          >
            <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => downloadMedia(file.dataUrl, fileName)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            title={t('studioDownloadMedia')}
            aria-label={t('studioDownloadMedia')}
          >
            <Download className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </article>
  )
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function parseStudioResponse(body: string): StudioGenerationResponse {
  const parsed = JSON.parse(body) as StudioGenerationResponse
  if (!Array.isArray(parsed.files)) {
    throw new Error('Invalid Studio response')
  }
  return parsed
}

function errorMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown }
    return typeof parsed.message === 'string' ? parsed.message : ''
  } catch {
    return body.trim()
  }
}

function extensionFromMediaType(mediaType: string): string {
  if (mediaType.includes('jpeg')) return 'jpg'
  if (mediaType.includes('png')) return 'png'
  if (mediaType.includes('webp')) return 'webp'
  if (mediaType.includes('quicktime')) return 'mov'
  if (mediaType.includes('webm')) return 'webm'
  if (mediaType.includes('mp4')) return 'mp4'
  return mediaType.startsWith('video/') ? 'mp4' : 'png'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function downloadMedia(dataUrl: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = fileName
  anchor.click()
}

function openMedia(dataUrl: string): void {
  window.open(dataUrl, '_blank', 'noopener,noreferrer')
}
