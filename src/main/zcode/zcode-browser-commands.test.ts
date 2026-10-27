import { describe, expect, it, vi } from 'vitest'

import { ZcodeBrowserBackend } from './zcode-browser-backend'
import {
  fakeSurface,
  sampleEvalResult,
  snappedBackend,
  surfaceCalls
} from './zcode-browser-test-surface'

describe('ZcodeBrowserBackend.execute write commands', () => {
  it('click by ref resolves in-page geometry and mouse-activates', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e1' }
    })
    expect(result.ok).toBe(true)
    expect(calls.evals.some((expression) => expression.includes('scrollIntoViewIfNeeded'))).toBe(
      true
    )
    expect(calls.mouse).toEqual(['click@28,28'])
    expect(calls.clicked).toHaveLength(0)
  })

  it('click by coordinates goes through the mouse path', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', x: 100, y: 200, doubleClick: true }
    })
    expect(result.ok).toBe(true)
    expect(calls.mouse).toEqual(['click@100,200'])
  })

  it('click with an unknown ref answers ref_not_found', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e99' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ref_not_found')
    expect(calls.clicked).toHaveLength(0)
  })

  it('fill sends the ref selector and value', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'fill', ref: 'e2', value: 'orca' }
    })
    expect(result.ok).toBe(true)
    expect(calls.filled).toEqual([{ element: 'body > input:nth-of-type(1)', value: 'orca' }])
  })

  it('type with a ref focuses it first, then types the text', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'type', ref: 'e2', text: 'hello' }
    })
    expect(result.ok).toBe(true)
    expect(calls.focused).toEqual(['body > input:nth-of-type(1)'])
    expect(calls.typed).toEqual(['hello'])
  })

  it('press folds modifiers into one combo string', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'press', key: 'Enter', modifiers: ['ControlOrMeta', 'Shift'] }
    })
    expect(result.ok).toBe(true)
    const expectedPrimary = process.platform === 'darwin' ? 'Meta' : 'Control'
    expect(calls.pressed).toEqual([`${expectedPrimary}+Shift+Enter`])
  })

  it('select scrolls into view before the surface select', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'select', ref: 'e2', values: ['a'] }
    })
    expect(result.ok).toBe(true)
    expect(calls.scrolledIntoView).toEqual(['body > input:nth-of-type(1)'])
    expect(calls.selected).toEqual([{ element: 'body > input:nth-of-type(1)', value: 'a' }])
  })

  it('check forwards the explicit unchecked state', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'check', ref: 'e2', checked: false }
    })
    expect(result.ok).toBe(true)
    expect(calls.checked).toEqual([{ element: 'body > input:nth-of-type(1)', checked: false }])
  })

  it('drag resolves both refs to selectors', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'drag', fromRef: 'e1', toRef: 'e2' }
    })
    expect(result.ok).toBe(true)
    expect(calls.dragged).toEqual([
      { from: 'body > a:nth-of-type(1)', to: 'body > input:nth-of-type(1)' }
    ])
  })

  it('cuaDrag sends every path point as a mouse sequence', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: {
        method: 'cuaDrag',
        path: [
          { x: 0, y: 0 },
          { x: 10, y: 5 },
          { x: 20, y: 10 }
        ]
      }
    })
    expect(result.ok).toBe(true)
    expect(calls.mouse).toEqual(['move@0,0', 'down', 'move@10,5', 'move@20,10', 'up'])
  })

  it('scroll evaluates window.scrollBy with the deltas', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'scroll', x: 0, y: 400 }
    })
    expect(result.ok).toBe(true)
    expect(calls.evals.some((expression) => expression.includes('window.scrollBy(0, 400)'))).toBe(
      true
    )
  })

  it('elementInfo hits the element whose rect contains the point', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const hit = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'elementInfo', x: 20, y: 28 }
    })
    expect(hit.ok).toBe(true)
    expect(hit.element).toMatchObject({ ref: 'e1' })
    const miss = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'elementInfo', x: 900, y: 900 }
    })
    expect(miss.element).toBeUndefined()
  })

  it('evaluate returns the JSON-parsed page value', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'evaluate', expression: '1 + 1' }
    })
    expect(result.ok).toBe(true)
    // The fake surface always answers the sample snapshot JSON.
    expect(result.value).toMatchObject({ url: 'https://example.org/page' })
  })

  it('waitFor(selector) parks on the surface wait', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'waitFor', selector: '#result', timeoutMs: 3000 }
    })
    expect(result.ok).toBe(true)
    expect(calls.waited).toEqual([{ selector: '#result', page: 'page-1' }])
  })

  it('waitFor(textGone) is honestly unsupported', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'waitFor', textGone: 'Loading' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('capability_unsupported')
  })
})

describe('ZcodeBrowserBackend.execute viewport hygiene', () => {
  it('scrolls the element into view before a daemon dblclick', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e1', doubleClick: true }
    })
    expect(result.ok).toBe(true)
    expect(calls.scrolledIntoView).toEqual(['body > a:nth-of-type(1)'])
    expect(calls.clicked).toEqual(['dbl:body > a:nth-of-type(1)'])
  })

  it('answers listUserTabs with an honest empty array', async () => {
    const calls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'listUserTabs' }
    })
    expect(result).toMatchObject({ ok: true, userTabs: [] })
  })
})

describe('ZcodeBrowserBackend.execute click geometry path', () => {
  it('answers ref_not_found when the geometry probe misses', async () => {
    const calls = surfaceCalls()
    const surface = fakeSurface(calls, {
      browserEval: vi.fn(async (params: { expression: string }) => {
        calls.evals.push(params.expression)
        return params.expression.includes('querySelectorAll')
          ? { result: sampleEvalResult(), origin: 'https://example.org' }
          : { result: 'null', origin: 'https://example.org' }
      }) as never
    })
    const backend = new ZcodeBrowserBackend(() => surface)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'navigate', url: 'https://example.org' }
    })
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'click', ref: 'e1' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ref_not_found')
  })
})

describe('ZcodeBrowserBackend.execute playwright action subset', () => {
  it('waitForLoadState polls readyState to complete', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: {
        method: 'playwright',
        action: { name: 'waitForLoadState', state: 'domcontentloaded' }
      }
    })
    expect(result.ok).toBe(true)
    expect(calls.evals.some((expression) => expression.includes('document.readyState'))).toBe(true)
  })

  it('waitForLoadState refuses networkidle like the CLI reference', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'playwright', action: { name: 'waitForLoadState', state: 'networkidle' } }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('capability_unsupported')
  })

  it('waitForURL resolves when location.href matches', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: {
        method: 'playwright',
        action: { name: 'waitForURL', url: 'https://example.org/page' }
      }
    })
    expect(result.ok).toBe(true)
  })

  it('domSnapshot returns an aria-style text rendering', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'playwright', action: { name: 'domSnapshot' } }
    })
    expect(result.ok).toBe(true)
    expect(typeof result.value).toBe('string')
    expect(result.value).toContain('link "More"')
  })

  it('playwright evaluate returns the parsed page value', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: {
        method: 'playwright',
        action: { name: 'evaluate', expression: 'document.title' }
      }
    })
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ url: 'https://example.org/page' })
  })

  it('playwrightWaitForTimeout sleeps and answers ok', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'playwrightWaitForTimeout', timeoutMs: 5 }
    })
    expect(result.ok).toBe(true)
  })

  it('unknown playwright actions stay honestly unsupported', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'playwright', action: { name: 'downloadPath', downloadId: 'd1' } }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('capability_unsupported')
  })
})

describe('ZcodeBrowserBackend.execute playwright evaluate kinds', () => {
  it('wraps function-kind expressions with their arg', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: {
        method: 'playwright',
        action: {
          name: 'evaluate',
          expression: '(x) => x + 1',
          expressionKind: 'function',
          arg: 41
        }
      }
    })
    expect(result.ok).toBe(true)
    expect(calls.evals).toContain('((x) => x + 1)(41)')
  })

  it('passes string-kind expressions through untouched', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: {
        method: 'playwright',
        action: { name: 'evaluate', expression: 'document.title', expressionKind: 'string' }
      }
    })
    expect(calls.evals).toContain('document.title')
  })
})

describe('ZcodeBrowserBackend.execute dialogs', () => {
  it('getDialog maps the daemon status to the contract shape', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'getDialog' }
    })
    expect(result.ok).toBe(true)
    expect(result.dialog).toEqual({ type: 'confirm', message: 'Proceed with deletion?' })
  })

  it('getDialog answers null when no dialog is open', async () => {
    const calls = surfaceCalls()
    const surface = fakeSurface(calls, {
      browserDialogStatus: vi.fn(async () => ({ hasDialog: false })) as never
    })
    const backend = new ZcodeBrowserBackend(() => surface)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'newTab' }
    })
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'getDialog' }
    })
    expect(result.dialog).toBeNull()
  })

  it('handleDialog accept forwards the prompt text', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'handleDialog', accept: true, promptText: 'yes' }
    })
    expect(result.ok).toBe(true)
    expect(calls.dialogs).toEqual(['accept:yes'])
  })

  it('handleDialog dismiss forwards without text', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'handleDialog', accept: false }
    })
    expect(calls.dialogs).toEqual(['dismiss'])
  })
})

describe('ZcodeBrowserBackend.execute workspace binding', () => {
  it('newTab binds the page to the wire workspace path', async () => {
    const calls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      workspacePath: 'C:/work/chat-space',
      command: { method: 'newTab' }
    })
    expect(result.ok).toBe(true)
    expect(calls.created).toEqual([{ url: 'about:blank' }])
  })

  it('navigate without a tab binds through the workspace too', async () => {
    const calls = surfaceCalls()
    const backend = new ZcodeBrowserBackend(() => fakeSurface(calls))
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      workspacePath: 'C:/work/chat-space',
      command: { method: 'navigate', url: 'https://example.org' }
    })
    expect(calls.created).toEqual([{ url: 'https://example.org' }])
  })

  it('falls back to an unbound tab when the workspace create fails', async () => {
    const calls = surfaceCalls()
    let createCalls = 0
    const surface = fakeSurface(calls, {
      browserTabCreate: (async (params: { url?: string; worktree?: string }) => {
        createCalls += 1
        calls.created.push({ url: params.url ?? 'about:blank' })
        if (params.worktree !== undefined) {
          throw Object.assign(new Error('Browser profile was not found'), {
            code: 'invalid_argument'
          })
        }
        return { browserPageId: `page-${createCalls}` }
      }) as never
    })
    const backend = new ZcodeBrowserBackend(() => surface)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      workspacePath: 'C:/nowhere',
      command: { method: 'newTab' }
    })
    expect(result.ok).toBe(true)
    expect(calls.created).toHaveLength(2)
  })
})

describe('ZcodeBrowserBackend.execute multi-select', () => {
  it('one value goes through the surface select', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'select', ref: 'e2', values: ['a'] }
    })
    expect(calls.selected).toEqual([{ element: 'body > input:nth-of-type(1)', value: 'a' }])
  })

  it('several values mark options in-page with change events', async () => {
    const calls = surfaceCalls()
    const backend = await snappedBackend(calls)
    const result = await backend.execute({
      sessionId: 'sess_1',
      browserId: backend.browserId,
      command: { method: 'select', ref: 'e2', values: ['a', 'b'] }
    })
    expect(result.ok).toBe(true)
    expect(calls.selected).toHaveLength(0)
    const multi = calls.evals.find((expression) => expression.includes('el.options'))
    expect(multi).toContain('["a","b"]')
    expect(multi).toContain("new Event('change'")
  })
})
