// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type TestWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
}

const harness = vi.hoisted(() => {
  const targets: TestWatchTarget[] = []
  const unwatched: TestWatchTarget[] = []
  const holder: { store: { getState: () => unknown } | null } = { store: null }
  return {
    keyOf: (target: TestWatchTarget): string => `${target.worktreeId}::client`,
    targets,
    unwatched,
    holder,
    readRuntimeFileContent: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(harness.holder.store?.getState()),
    { getState: () => harness.holder.store?.getState() }
  )
}))
vi.mock('./editor-external-watch-targets', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selectEditorExternalWatchTargets: () => ({
    targets: [...harness.targets],
    targetsKey: harness.targets.map(harness.keyOf).join('|'),
    unwatchedTargetKeys: new Set(harness.unwatched.map(harness.keyOf)),
    unwatchedTargetsKey: harness.unwatched.map(harness.keyOf).join('|')
  }),
  getEditorExternalWatchTargetKey: harness.keyOf
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: harness.readRuntimeFileContent
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

import { createTestStore } from '@/store/slices/store-test-helpers'
import { useEditorExternalWatch } from './useEditorExternalWatch'
import { attachRestoredTabConflictScan } from '@/components/editor/editor-restored-tab-conflict-scan'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'
import {
  isAutosaveSuspendedForFile,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT
} from '@/components/editor/editor-autosave'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from './worktree-file-change-event'

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

const active: TestWatchTarget = {
  worktreeId: 'active',
  worktreePath: '/active',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const background: TestWatchTarget = {
  worktreeId: 'background',
  worktreePath: '/background',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const CLEAN = '/background/clean.ts'
const DIRTY = '/background/dirty.ts'

describe('switching back to a workspace that was not watched', () => {
  let store: ReturnType<typeof createTestStore>
  let container: HTMLDivElement
  let root: Root
  let previousApi: unknown
  let detachScan: () => void
  let settleWatch: () => void
  let reloads: string[]
  let fileChangeEvents: number
  const onReload = (event: Event): void => {
    if (event instanceof CustomEvent) {
      reloads.push(event.detail.relativePath)
    }
  }
  const onFileChange = (): void => {
    fileChangeEvents += 1
  }

  const file = (id: string) => store.getState().openFiles.find((f) => f.id === id)!

  async function render(targets: TestWatchTarget[], unwatched: TestWatchTarget[]): Promise<void> {
    harness.targets.splice(0, harness.targets.length, ...targets)
    harness.unwatched.splice(0, harness.unwatched.length, ...unwatched)
    await act(async () => root.render(createElement(WatchProbe)))
  }

  function openTab(filePath: string): void {
    store.getState().openFile({
      filePath,
      relativePath: filePath.slice('/background/'.length),
      worktreeId: 'background',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setLastKnownDiskSignature(filePath, getDiskBaselineSignature('v1'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    store = createTestStore()
    harness.holder.store = store
    openTab(CLEAN)
    openTab(DIRTY)
    store.getState().setEditorDraft(DIRTY, 'unsaved edit')
    store.getState().markFileDirty(DIRTY, true)
    previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: {
        watchWorktree: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              settleWatch = resolve
            })
        ),
        unwatchWorktree: vi.fn().mockResolvedValue(undefined),
        onFsChanged: vi.fn(() => vi.fn()),
        pathExists: vi.fn().mockResolvedValue(true)
      }
    }
    reloads = []
    fileChangeEvents = 0
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onReload)
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, onFileChange)
    detachScan = attachRestoredTabConflictScan(store)
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onReload)
    window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, onFileChange)
    detachScan()
    container.remove()
    vi.useRealTimers()
    ;(window as unknown as { api?: unknown }).api = previousApi
  })

  async function switchBack(): Promise<void> {
    await render([active], [background])
    await render([active, background], [])
    await act(async () => settleWatch())
    await act(async () => vi.advanceTimersByTimeAsync(200))
  }

  it('reloads clean tabs, banners a dirty tab changed on disk, and refreshes git status/Files once', async () => {
    harness.readRuntimeFileContent.mockResolvedValue({ content: 'v2 agent write', isBinary: false })
    await switchBack()

    expect(reloads).toEqual(['clean.ts'])
    expect(file(DIRTY).externalMutation).toBe('changed')
    expect(file(DIRTY).isDirty).toBe(true)
    expect(file(CLEAN).externalMutation).toBeFalsy()
    expect(fileChangeEvents).toBe(1)
  })

  it('leaves a dirty tab alone when disk still matches what it last read', async () => {
    harness.readRuntimeFileContent.mockResolvedValue({ content: 'v1', isBinary: false })
    await switchBack()

    expect(file(DIRTY).externalMutation).toBeFalsy()
    expect(file(DIRTY).pendingDiskBaselineVerification).toBeFalsy()
  })

  it('does not re-read tabs of a workspace that was never dropped', async () => {
    await render([active], [])
    await render([active, background], [])
    await act(async () => settleWatch())
    await act(async () => vi.advanceTimersByTimeAsync(200))

    expect(reloads).toEqual([])
    expect(harness.readRuntimeFileContent).not.toHaveBeenCalled()
    expect(file(DIRTY).pendingDiskBaselineVerification).toBeFalsy()
  })

  it('never holds autosave on a tab edited before the watch is back', async () => {
    // Why: saves are disk-checked by the host, so a stale edit is refused there rather than held here.
    await render([active], [background])
    await render([active, background], [])
    store.getState().setEditorDraft(CLEAN, 'typed before the watch settled')
    store.getState().markFileDirty(CLEAN, true)
    await act(async () => {})

    expect(file(CLEAN).pendingDiskBaselineVerification).toBeFalsy()
    expect(isAutosaveSuspendedForFile(file(CLEAN))).toBe(false)
  })
})
