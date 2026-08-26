import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  clipboard: {
    write: vi.fn()
  },
  dialog: {
    showSaveDialog: vi.fn()
  }
}))

import {
  buildWriteClipboardHtmlFragment,
  buildWriteExportFileName,
  buildWriteExportHtmlDocument,
  copyWriteDocumentAsRichText
} from './write-export-service'
import { clipboard } from 'electron'

describe('write-export-service helpers', () => {
  let workspaceRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-export-'))
    vi.mocked(clipboard.write).mockReset()
  })

  it('builds export file names with the requested extension', () => {
    expect(buildWriteExportFileName('/tmp/draft.md', 'html')).toBe('draft.html')
    expect(buildWriteExportFileName('/tmp/draft.md', 'pdf')).toBe('draft.pdf')
    expect(buildWriteExportFileName('/tmp/draft.md', 'doc')).toBe('draft.doc')
    expect(buildWriteExportFileName('/tmp/draft.md', 'docx')).toBe('draft.docx')
  })

  it('renders markdown exports with resolved links and inlined local images', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const imagePath = join(workspaceRoot, 'cover.png')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const html = await buildWriteExportHtmlDocument({
      sourcePath,
      content: '# Heading\n\n![Cover](./cover.png)\n\n[Notes](./notes.md)'
    })

    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain(`href="${pathToFileURL(join(workspaceRoot, 'notes.md')).href}"`)
  })

  it('omits remote, malformed, and out-of-workspace images from export HTML', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const malformedPath = join(workspaceRoot, 'malformed.png')
    const outsidePath = join(tmpdir(), `pengcodex-outside-${Date.now()}.png`)
    await writeFile(malformedPath, Buffer.from('not a png'))
    await writeFile(outsidePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const html = await buildWriteExportHtmlDocument({
      sourcePath,
      workspaceRoot,
      content: [
        '![Remote](https://example.test/image.png)',
        '![Malformed](./malformed.png)',
        `![Outside](${pathToFileURL(outsidePath).href})`
      ].join('\n\n')
    })

    expect(html).not.toContain('<img')
    expect(html).not.toContain('https://example.test/image.png')
    expect(html).toContain('[Image: Remote]')
    expect(html).toContain('[Image: Malformed]')
    expect(html).toContain('[Image: Outside]')
  })

  it('renders clipboard html fragments for markdown content', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const html = await buildWriteClipboardHtmlFragment({
      sourcePath,
      content: '# Heading\n\n**Bold**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[Notes](./notes.md)'
    })

    expect(html).toContain('<article class="markdown-body">')
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain(`href="${pathToFileURL(join(workspaceRoot, 'notes.md')).href}"`)
  })

  it('renders clipboard html fragments for plain text content', async () => {
    const sourcePath = join(workspaceRoot, 'draft.txt')
    const html = await buildWriteClipboardHtmlFragment({
      sourcePath,
      content: 'plain text\nline two'
    })

    expect(html).toContain('<article class="markdown-body">')
    expect(html).toContain('<pre class="plain-text">plain text\nline two</pre>')
  })

  it('writes html and plain text to the clipboard', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const imagePath = join(workspaceRoot, 'cover.png')
    await writeFile(sourcePath, '# Heading\n\n![Cover](./cover.png)')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const result = await copyWriteDocumentAsRichText({
      path: sourcePath,
      workspaceRoot,
      content: '# Heading\n\n![Cover](./cover.png)'
    })

    expect(result.ok).toBe(true)
    expect(clipboard.write).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('<article class="markdown-body">'),
        text: '# Heading\n\n![Cover](./cover.png)'
      })
    )
    expect(clipboard.write).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('src="data:image/png;base64,')
      })
    )
  })
})
