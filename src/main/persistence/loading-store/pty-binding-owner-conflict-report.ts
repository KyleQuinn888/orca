import { findTerminalBindingConflict } from '../../../shared/workspace-layout/terminal-owner-invariants'
import type { PtyBindingSpan } from './pty-binding-span'

/** Report-only: the binding is written even when it breaks an invariant, or the check throws. */
export function reportOwnerConflict(
  span: PtyBindingSpan,
  ...args: Parameters<typeof findTerminalBindingConflict>
): void {
  try {
    const conflict = findTerminalBindingConflict(...args)
    if (conflict) {
      span.setOwnerConflict(conflict.reason)
    }
  } catch {
    span.setOwnerConflict('check_threw')
  }
}
