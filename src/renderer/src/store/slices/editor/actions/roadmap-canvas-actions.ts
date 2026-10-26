// Roadmap project-canvas tab — virtual editor tab modeled 1:1 on check-details
// (spec r2-ui.md v1.2 §0/§2; one canvas tab per worktree, id is synthetic).

import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '../types/open-file'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'

export function buildRoadmapCanvasTabId(worktreeId: string): string {
  return `${worktreeId}::roadmap-canvas`
}

export function roadmapCanvasTabLabel(): string {
  return translate('auto.components.roadmap.canvasTabLabel', '项目画布')
}

export function createRoadmapCanvasActions(set: EditorSet, get: EditorGet): Pick<EditorSlice, 'openRoadmapCanvas'> {
  return {
    openRoadmapCanvas: (worktreeId) => {
      const id = buildRoadmapCanvasTabId(worktreeId)
      const label = roadmapCanvasTabLabel()
      set((s) => {
        if (s.openFiles.some((f) => f.id === id)) {
          return {
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
          }
        }
        const newFile: OpenFile = {
          id,
          filePath: id,
          relativePath: label,
          worktreeId,
          language: 'plaintext',
          isDirty: false,
          mode: 'roadmap-canvas'
        }
        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, label, 'roadmap-canvas')
    }
  }
}
