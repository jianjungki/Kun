import { readBrowserStorageItemWithLegacy, writeBrowserStorageItem } from './browser-storage'

export const PREFERRED_EDITOR_STORAGE_KEY = 'pengcodex.editor.preferredId'
const LEGACY_PREFERRED_EDITOR_STORAGE_KEY = 'deepseekgui.editor.preferredId'

export function readPreferredEditorId(): string | undefined {
  const value = readBrowserStorageItemWithLegacy(
    PREFERRED_EDITOR_STORAGE_KEY,
    [LEGACY_PREFERRED_EDITOR_STORAGE_KEY]
  )?.trim()
  return value || undefined
}

export function writePreferredEditorId(editorId: string): void {
  writeBrowserStorageItem(PREFERRED_EDITOR_STORAGE_KEY, editorId)
}
