// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const boundaryMocks = vi.hoisted(() => ({
  mermaid: vi.fn(() => {
    throw new Error('These fixtures must not render Mermaid diagrams')
  })
}))

vi.mock('./CommentMermaidBlock', () => ({ default: boundaryMocks.mermaid }))

// Why: a literal dollar in source invites template-literal escaping drift.
const DOLLAR = String.fromCharCode(36)

afterEach(() => {
  cleanup()
  boundaryMocks.mermaid.mockClear()
})

describe('CommentMarkdown math', () => {
  it('renders inline and block LaTeX through KaTeX, not as raw dollars', () => {
    const { container } = render(
      <CommentMarkdown content={'Inline $E = mc^2$ and block:\n\n$$\\int_0^1 x\\,dx$$'} />
    )
    const katex = container.querySelectorAll('.katex')
    expect(katex.length).toBeGreaterThanOrEqual(2)
    expect(container.innerHTML).not.toContain('$E = mc^2$')
  })

  it('leaves an unpaired dollar alone', () => {
    // A single dollar never opens math; paired ones do (the editor
    // preview makes the same trade-off: model math outweighs currency).
    const content = ['That costs ', DOLLAR, '5 today.'].join('')
    const { container } = render(<CommentMarkdown content={content} />)
    expect(container.querySelectorAll('.katex').length).toBe(0)
    expect(container.textContent).toContain([DOLLAR, '5'].join(''))
  })
})
