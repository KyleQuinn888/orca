import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PtyBindingFastLaneVerdict } from './pty-binding-fast-lane'
import type { StoreRuntimeState } from './store-runtime-state'

// Writer-owned failure publication needs a rollback callback; a matching binding restores nothing.
const MATCHING_BINDING_ROLLBACK = (): void => {}

/** True when memory already holds the binding and only the debounced save is outstanding. */
export function isDurabilityOnlyMatch(verdict: PtyBindingFastLaneVerdict): boolean {
  return verdict.misses.length === 1 && verdict.misses[0] === 'not_durable'
}

/** Marks the selected session domain so the writer captures it; no binding mutation runs. */
export function durabilityOnlyBindingResult(
  runtime: Pick<StoreRuntimeState, 'dirtyProfileStateDomains'>,
  hostId: string
): { value: true; rollback: () => void } {
  runtime.dirtyProfileStateDomains?.add(
    hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
  )
  return { value: true, rollback: MATCHING_BINDING_ROLLBACK }
}
