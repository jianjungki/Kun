import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Check, ChevronLeft, ChevronRight, FolderOpen, Loader2, PackagePlus, Plus, RefreshCw } from 'lucide-react'
import type { AppSettingsPatch, AppSettingsV1 } from '@shared/app-settings'
import type { SkillListItem } from '@shared/ds-gui-api'
import { RECOMMENDED_SKILLS, buildSkillContent, type RecommendedSkillDefinition } from '../lib/skill-registry'
import type { SkillRootId } from '../lib/skill-root-preference'
import {
  InlineNoticeView,
  SettingsCard,
  SettingRow,
  Toggle,
  type InlineNotice
} from './settings-controls'

type SkillRootOption = {
  id: SkillRootId
  label: string
  path: string
  available: boolean
}

type SkillRegistryCtx = {
  t: (key: string, options?: Record<string, unknown>) => string
  tCommon: (key: string, options?: Record<string, unknown>) => string
  form: AppSettingsV1
  kun: AppSettingsV1['agents']['kun']
  update: (partial: AppSettingsPatch) => void
  updateKun: (patch: Partial<AppSettingsV1['agents']['kun']>) => void
  selectedSkillRoot?: SkillRootOption
  skillRootOptions: SkillRootOption[]
  skillRootId: SkillRootId
  setSkillRootId: (id: SkillRootId) => void
  skillNotice: InlineNotice | null
  openSkillRoot: () => Promise<void>
  selectControlClass: string
  splitSettingsList: (value: string) => string[]
  listSettingsText: (values: string[]) => string
}

type SkillListState = {
  loading: boolean
  error: string
  skills: SkillListItem[]
}

type SkillSource = {
  id: string
  label: string
  title: string
}

type RegistrySkillItem = {
  id: string
  name: string
  description: string
  installed: boolean
  active: boolean
  recommended: boolean
  recommendedSkill?: RecommendedSkillDefinition
  root?: string
  sourceId: string
  sourceLabel: string
  sourceTitle: string
  legacy?: boolean
}

type SourceTab = {
  id: string
  label: string
  count: number
  title?: string
}

const PAGE_SIZE = 8

const EMPTY_LIST_STATE: SkillListState = {
  loading: false,
  error: '',
  skills: []
}

function uniqueSkillIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) return normalized
  return `${normalized.startsWith('/') ? '/' : ''}${parts.slice(0, -1).join('/')}`
}

function compactSourcePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 2) return parts.join('/') || path
  const tail = parts.slice(-2)
  return tail.join('/')
}

function sourceForSkill(skill: SkillListItem, t: SkillRegistryCtx['t']): SkillSource {
  const sourceRoot = parentDir(skill.root)
  const scope = skill.scope === 'project' ? t('skillRegistrySourceProject') : t('skillRegistrySourceGlobal')
  return {
    id: `source:${sourceRoot}`,
    label: `${scope}: ${compactSourcePath(sourceRoot)}`,
    title: sourceRoot
  }
}

function itemMatchesTab(item: RegistrySkillItem, tabId: string): boolean {
  if (tabId === 'all') return true
  if (tabId === 'active') return item.active
  if (tabId === 'recommended') return item.recommended
  return item.sourceId === tabId
}

export function SkillRegistrySettingsSection({ ctx }: { ctx: SkillRegistryCtx }): ReactElement {
  const {
    t,
    tCommon,
    form,
    kun,
    update,
    updateKun,
    selectedSkillRoot,
    skillRootOptions,
    skillRootId,
    setSkillRootId,
    skillNotice,
    openSkillRoot,
    selectControlClass,
    splitSettingsList,
    listSettingsText
  } = ctx
  const registry = kun.skillRegistry ?? { activationMode: 'all' as const, activeSkillIds: [] }
  const activationMode = registry.activationMode === 'selected' ? 'selected' : 'all'
  const activeSkillIds = useMemo(
    () => new Set(uniqueSkillIds(registry.activeSkillIds ?? [])),
    [registry.activeSkillIds]
  )
  const [listState, setListState] = useState<SkillListState>(EMPTY_LIST_STATE)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<InlineNotice | null>(null)
  const [sourceDraft, setSourceDraft] = useState('')
  const [activeTabId, setActiveTabId] = useState('all')
  const [page, setPage] = useState(1)

  const discoveredSkillIds = useMemo(
    () => uniqueSkillIds(listState.skills.map((skill) => skill.id)),
    [listState.skills]
  )
  const recommendedById = useMemo(
    () => new Map(RECOMMENDED_SKILLS.map((skill) => [skill.id, skill])),
    []
  )

  const refreshSkills = useCallback(async (): Promise<void> => {
    if (typeof window.dsGui?.listSkills !== 'function') {
      setListState({
        loading: false,
        error: t('skillRegistryScanUnavailable'),
        skills: []
      })
      return
    }
    setListState((current) => ({ ...current, loading: true, error: '' }))
    try {
      const result = await window.dsGui.listSkills(form.workspaceRoot || undefined)
      if (!result.ok) {
        setListState({ loading: false, error: result.message, skills: [] })
        return
      }
      setListState({
        loading: false,
        error: result.validationErrors[0]?.message ?? '',
        skills: result.skills
      })
    } catch (error) {
      setListState({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        skills: []
      })
    }
  }, [form.workspaceRoot, t])

  useEffect(() => {
    void refreshSkills()
  }, [refreshSkills])

  const registryItems = useMemo<RegistrySkillItem[]>(() => {
    const items = new Map<string, RegistrySkillItem>()
    for (const skill of RECOMMENDED_SKILLS) {
      items.set(skill.id, {
        id: skill.id,
        name: tCommon(skill.titleKey),
        description: tCommon(skill.descriptionKey),
        installed: false,
        active: false,
        recommended: true,
        recommendedSkill: skill,
        sourceId: 'recommended',
        sourceLabel: t('skillRegistrySourceRecommended'),
        sourceTitle: t('skillRegistrySourceRecommended')
      })
    }
    for (const skill of listState.skills) {
      const recommendedSkill = recommendedById.get(skill.id)
      const source = sourceForSkill(skill, t)
      items.set(skill.id, {
        id: skill.id,
        name: skill.name || (recommendedSkill ? tCommon(recommendedSkill.titleKey) : skill.id),
        description: skill.description || (recommendedSkill ? tCommon(recommendedSkill.descriptionKey) : skill.root),
        installed: true,
        active: activationMode === 'all' || activeSkillIds.has(skill.id),
        recommended: Boolean(recommendedSkill),
        ...(recommendedSkill ? { recommendedSkill } : {}),
        root: skill.root,
        sourceId: source.id,
        sourceLabel: source.label,
        sourceTitle: source.title,
        legacy: skill.legacy
      })
    }
    const recommendedOrder = new Map(RECOMMENDED_SKILLS.map((skill, index) => [skill.id, index]))
    return [...items.values()].sort((left, right) => {
      if (left.installed !== right.installed) return left.installed ? -1 : 1
      const leftOrder = recommendedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = recommendedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return left.name.localeCompare(right.name)
    })
  }, [activationMode, activeSkillIds, listState.skills, recommendedById, t, tCommon])

  const sourceTabs = useMemo<SourceTab[]>(() => {
    const tabs: SourceTab[] = [
      { id: 'all', label: t('skillRegistrySourceAll'), count: registryItems.length },
      { id: 'active', label: t('skillRegistrySourceActive'), count: registryItems.filter((item) => item.active).length },
      { id: 'recommended', label: t('skillRegistrySourceRecommended'), count: registryItems.filter((item) => item.recommended).length }
    ]
    const sourceCounts = new Map<string, SourceTab>()
    for (const item of registryItems) {
      if (!item.installed || item.sourceId === 'recommended') continue
      const existing = sourceCounts.get(item.sourceId)
      sourceCounts.set(item.sourceId, {
        id: item.sourceId,
        label: item.sourceLabel,
        title: item.sourceTitle,
        count: (existing?.count ?? 0) + 1
      })
    }
    return [...tabs, ...sourceCounts.values()]
  }, [registryItems, t])

  useEffect(() => {
    if (!sourceTabs.some((tab) => tab.id === activeTabId)) setActiveTabId('all')
  }, [activeTabId, sourceTabs])

  const filteredItems = useMemo(
    () => registryItems.filter((item) => itemMatchesTab(item, activeTabId)),
    [activeTabId, registryItems]
  )
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE))
  const pageItems = filteredItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  useEffect(() => {
    setPage(1)
  }, [activeTabId, filteredItems.length])

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  const updateRegistry = (activationMode: 'all' | 'selected', ids: string[]): void => {
    updateKun({
      skillRegistry: {
        activationMode,
        activeSkillIds: activationMode === 'selected' ? uniqueSkillIds(ids) : []
      }
    })
  }

  const setUseAllSkills = (useAll: boolean): void => {
    updateRegistry(useAll ? 'all' : 'selected', useAll ? [] : discoveredSkillIds)
  }

  const setSkillActive = (skillId: string, active: boolean): void => {
    if (activationMode === 'all') {
      const next = active
        ? discoveredSkillIds
        : discoveredSkillIds.filter((id) => id !== skillId)
      updateRegistry('selected', next)
      return
    }
    const current = [...activeSkillIds]
    const next = active
      ? [...current, skillId]
      : current.filter((id) => id !== skillId)
    updateRegistry('selected', next)
  }

  const addSource = (): void => {
    const nextSource = sourceDraft.trim()
    if (!nextSource) return
    const nextSources = uniqueStrings([...(form.claw.skills.extraDirs ?? []), nextSource])
    update({
      claw: {
        skills: {
          extraDirs: nextSources
        }
      }
    })
    setSourceDraft('')
    setNotice({ tone: 'info', message: t('skillRegistrySourceAdded') })
  }

  const installRecommendedSkill = async (skill: RecommendedSkillDefinition): Promise<void> => {
    if (!selectedSkillRoot?.path || !selectedSkillRoot.available) {
      setNotice({ tone: 'error', message: t('skillsRootUnavailable') })
      return
    }
    if (typeof window.dsGui?.saveSkillFile !== 'function') {
      setNotice({ tone: 'error', message: t('skillRegistryInstallUnavailable') })
      return
    }
    setInstallingId(skill.id)
    setNotice(null)
    try {
      const title = tCommon(skill.titleKey)
      const description = tCommon(skill.descriptionKey)
      const content = buildSkillContent(skill.id, title, description, skill.instructions)
      const result = await window.dsGui.saveSkillFile(selectedSkillRoot.path, skill.id, content)
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message })
        return
      }
      if (activationMode === 'selected' && !activeSkillIds.has(skill.id)) {
        updateRegistry('selected', [...activeSkillIds, skill.id])
      }
      await refreshSkills()
      setNotice({ tone: 'success', message: t('skillRegistryInstalledNotice', { path: result.path }) })
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setInstallingId(null)
    }
  }

  const enabledCount = activationMode === 'all'
    ? listState.skills.length
    : listState.skills.filter((skill) => activeSkillIds.has(skill.id)).length

  return (
    <div className="space-y-6">
      <SettingsCard title={t('skillRegistrySources')}>
        <SettingRow
          title={t('skillsLocation')}
          description={t('skillsLocationDesc')}
          control={
            <select
              className={selectControlClass}
              value={selectedSkillRoot?.id ?? skillRootId}
              onChange={(event) => setSkillRootId(event.target.value as SkillRootId)}
            >
              {skillRootOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>
                  {option.available ? option.label : `${option.label} ${tCommon('pluginSkillRootNeedsWorkspace')}`}
                </option>
              ))}
            </select>
          }
        />
        <SettingRow
          title={t('skillsPath')}
          description={t('skillsPathDesc')}
          control={
            <div className="space-y-2">
              <code className="block break-all rounded-xl border border-ds-border bg-ds-card px-3 py-2 font-mono text-[12px] text-ds-ink shadow-sm">
                {selectedSkillRoot?.path || t('skillsRootUnavailable')}
              </code>
              <button
                type="button"
                onClick={() => void openSkillRoot()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
              >
                <FolderOpen className="h-4 w-4" />
                {t('skillsOpenRoot')}
              </button>
            </div>
          }
        />
        <SettingRow
          title={t('skillsScanDirs')}
          description={t('skillsScanDirsDesc')}
          wideControl
          control={
            <div className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={sourceDraft}
                  onChange={(event) => setSourceDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addSource()
                    }
                  }}
                  placeholder={t('skillRegistrySourcePlaceholder')}
                  className="min-w-0 flex-1 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
                <button
                  type="button"
                  onClick={addSource}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                >
                  <Plus className="h-4 w-4" />
                  {t('skillRegistryAddSource')}
                </button>
              </div>
              <textarea
                value={listSettingsText(form.claw.skills.extraDirs)}
                onChange={(event) =>
                  update({
                    claw: {
                      skills: {
                        extraDirs: splitSettingsList(event.target.value)
                      }
                    }
                  })
                }
                spellCheck={false}
                placeholder={selectedSkillRoot?.path || '~/.agents/skills'}
                className="min-h-24 w-full rounded-2xl border border-ds-border bg-ds-card px-4 py-3 font-mono text-[13px] leading-6 text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard title={t('skillRegistry')}>
        <SettingRow
          title={t('skillRegistryUseAll')}
          description={t('skillRegistryUseAllDesc')}
          control={
            <div className="flex items-center justify-between gap-3 rounded-xl border border-ds-border bg-ds-card px-3 py-2 shadow-sm">
              <span className="text-[13px] font-medium text-ds-muted">
                {activationMode === 'all' ? t('skillRegistryAllActive') : t('skillRegistrySelectedActive', { count: enabledCount })}
              </span>
              <Toggle checked={activationMode === 'all'} onChange={setUseAllSkills} />
            </div>
          }
        />
        <SettingRow
          title={t('skillRegistryList')}
          description={t('skillRegistryListDesc')}
          wideControl
          control={
            <div className="space-y-4">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {sourceTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      title={tab.title}
                      onClick={() => setActiveTabId(tab.id)}
                      className={`max-w-full truncate rounded-full border px-3 py-1.5 text-[12px] font-medium transition ${
                        activeTabId === tab.id
                          ? 'border-ds-skill/30 bg-ds-skill-soft text-ds-skill'
                          : 'border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                      }`}
                    >
                      {tab.label} <span className="text-[11px] opacity-70">{tab.count}</span>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12px] text-ds-faint">
                    {t('skillRegistryPageStatus', { page, pages: pageCount })}
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshSkills()}
                    disabled={listState.loading}
                    className="inline-flex items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:opacity-60"
                  >
                    {listState.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    {t('skillRegistryRefresh')}
                  </button>
                </div>
              </div>

              {listState.error ? <InlineNoticeView notice={{ tone: 'error', message: listState.error }} /> : null}
              {notice ? <InlineNoticeView notice={notice} /> : null}
              {skillNotice ? <InlineNoticeView notice={skillNotice} /> : null}

              {pageItems.length === 0 && !listState.loading ? (
                <div className="rounded-xl border border-ds-border-muted bg-ds-main/35 px-4 py-4 text-[13px] text-ds-muted">
                  {t('skillRegistryNoPageItems')}
                </div>
              ) : null}

              <div className="space-y-3">
                {pageItems.map((item) => {
                  const busy = installingId === item.id
                  return (
                    <div
                      key={item.id}
                      className="flex min-w-0 flex-col gap-3 rounded-xl border border-ds-border-muted bg-ds-main/35 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[14px] font-semibold text-ds-ink">{item.name}</span>
                          <code className="rounded-md bg-ds-subtle px-1.5 py-0.5 text-[11px] text-ds-muted">{item.id}</code>
                          {item.recommended ? (
                            <span className="rounded-full bg-ds-skill-soft px-2 py-0.5 text-[11px] font-medium text-ds-skill">
                              {t('skillRegistryRecommendedBadge')}
                            </span>
                          ) : null}
                          {item.installed ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-200">
                              <Check className="h-3 w-3" />
                              {t('skillRegistryInstalledBadge')}
                            </span>
                          ) : null}
                          {item.legacy ? (
                            <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] font-medium text-ds-faint">
                              {t('skillRegistryLegacyBadge')}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[12.5px] leading-5 text-ds-muted">{item.description}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ds-faint">
                          <span className="rounded-md bg-ds-card px-2 py-1">{item.sourceLabel}</span>
                          {item.root ? (
                            <code className="break-all rounded-md bg-ds-card px-2 py-1 font-mono">{item.root}</code>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end">
                        {item.installed ? (
                          <>
                            <span className={`text-[12px] font-medium ${item.active ? 'text-emerald-700 dark:text-emerald-200' : 'text-ds-faint'}`}>
                              {item.active ? t('skillRegistryActive') : t('skillRegistryInactive')}
                            </span>
                            <Toggle checked={item.active} onChange={(value) => setSkillActive(item.id, value)} />
                          </>
                        ) : item.recommendedSkill ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void installRecommendedSkill(item.recommendedSkill!)}
                            className="inline-flex items-center justify-center gap-2 rounded-xl bg-ds-userbubble px-3 py-2 text-[13px] font-medium text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
                            {t('skillRegistryInstall')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-ds-border-muted pt-3">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t('skillRegistryPrevPage')}
                </button>
                <span className="text-[12px] text-ds-faint">
                  {t('skillRegistryPageStatus', { page, pages: pageCount })}
                </span>
                <button
                  type="button"
                  disabled={page >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('skillRegistryNextPage')}
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          }
        />
      </SettingsCard>
    </div>
  )
}
