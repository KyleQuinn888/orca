// Roadmap service bootstrap: wires into the Electron app lifecycle, handles
// the settings toggle, and constructs the service with real dependencies.

import {
  createRoadmapService,
  type RoadmapService,
  type RoadmapServiceDeps
} from './roadmap-service'
import { loadState, saveState } from './roadmap-store'

let service: RoadmapService | null = null

export function bootstrapRoadmap(deps: {
  getUserDataDir: () => string
  getJournalDb: RoadmapServiceDeps['getJournalDb']
  getWorkspacePath: RoadmapServiceDeps['getWorkspacePath']
  getSessionTitle: RoadmapServiceDeps['getSessionTitle']
  isLocalSession: RoadmapServiceDeps['isLocalSession']
  onJournalCommit: RoadmapServiceDeps['onJournalCommit']
  onTurnCompletion: RoadmapServiceDeps['onTurnCompletion']
  onIdle: RoadmapServiceDeps['onIdle']
  zcodeAvailable: RoadmapServiceDeps['zcodeAvailable']
  featureEnabled?: RoadmapServiceDeps['featureEnabled']
  onQuit: (hook: () => void) => void
}): void {
  const state = loadState(deps.getUserDataDir())

  service = createRoadmapService(deps, state) // deps carry featureEnabled through (L1 gate)

  // Start on bootstrap (settings check happens per-session via optedIn)
  service.start()

  // Backfill on startup (async, non-blocking)
  void service.backfill()

  // Clean shutdown
  deps.onQuit(() => {
    service?.stop()
    saveState(deps.getUserDataDir(), state)
  })
}

export function getRoadmapService(): RoadmapService | null {
  return service
}

export function roadmapOptIn(sessionId: string): void {
  service?.optInSession(sessionId)
}

export function roadmapOptOut(sessionId: string): void {
  service?.optOutSession(sessionId)
}
