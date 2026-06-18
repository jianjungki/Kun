import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StreamdownContext } from 'streamdown'
import type { StreamdownContextType } from 'streamdown'
import { shouldRunCodeHighlight, StreamdownCode } from './StreamdownCode'
import * as codeHighlighting from '../../lib/code-highlighting'

const streamdownContext = {
  controls: true,
  isAnimating: false,
  lineNumbers: true,
  linkSafety: { enabled: true },
  mode: 'streaming',
  shikiTheme: ['github-light', 'github-dark']
} satisfies StreamdownContextType

describe('StreamdownCode plain text fences', () => {
  it('renders text fenced blocks without code block chrome', () => {
    const html = renderToStaticMarkup(
      createElement(
        StreamdownCode,
        { className: 'language-text', 'data-block': true },
        'refactor(chat): simplify composer\n\n- Keep only Stop\n'
      )
    )

    expect(html).toContain('ds-plain-text-block')
    expect(html).toContain('refactor(chat): simplify composer')
    expect(html).toContain('- Keep only Stop')
    expect(html).not.toContain('ds-code-block-header')
    expect(html).not.toContain('Download code')
    expect(html).not.toContain('Copy code')
  })

  it('hides empty plain text fenced blocks', () => {
    const html = renderToStaticMarkup(
      createElement(
        StreamdownCode,
        { className: 'language-text', 'data-block': true },
        '\n'
      )
    )

    expect(html).toBe('')
  })

  it('does not start syntax highlighting while markdown is streaming', () => {
    const highlightSpy = vi.spyOn(codeHighlighting, 'highlightCodeHtml')
    const html = renderToStaticMarkup(
      createElement(
        StreamdownContext.Provider,
        { value: streamdownContext },
        createElement(
          StreamdownCode,
          { className: 'language-ts', 'data-block': true },
          'const answer: number = 42\n'
        )
      )
    )

    expect(html).toContain('ds-code-block')
    expect(html).toContain('const answer')
    expect(highlightSpy).not.toHaveBeenCalled()
  })

  it('defers expensive highlighting until streaming markdown becomes static', () => {
    expect(shouldRunCodeHighlight('streaming')).toBe(false)
    expect(shouldRunCodeHighlight('static')).toBe(true)
  })
})
