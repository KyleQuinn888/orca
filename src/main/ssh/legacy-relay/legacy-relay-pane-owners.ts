/**
 * Which relay speaks for each relay id of one SSH target. The registry keeps one per target across
 * its bridges, so a reconnect remembers the owners.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Relay ids repeat across relays (each numbers its own pty-1, pty-2…), so once a relay is known to
 * run a pane, no other relay's process under that id is ever served for it.
 */
export class LegacyRelayPaneOwners {
  /** `null`: two relays claimed the id before either was known to own it, so neither ever does. */
  private readonly owners = new Map<string, string | null>()
  /** Exits reported for an id no relay owns yet, by relay; the listing that adopts one reads them. */
  private readonly unownedExits = new Map<string, number>()

  owner(relayPtyId: string): string | null | undefined {
    return this.owners.get(relayPtyId)
  }

  speaksFor(relayPtyId: string, endpoint: string): boolean {
    return this.owners.get(relayPtyId) === endpoint
  }

  claim(relayPtyId: string, endpoint: string | null): void {
    this.owners.set(relayPtyId, endpoint)
  }

  forget(relayPtyId: string): void {
    this.owners.delete(relayPtyId)
  }

  /** An exit report from a relay that does not own the id; kept only while nobody does. */
  noteExit(relayPtyId: string, endpoint: string, code: number): void {
    if (!this.owners.has(relayPtyId)) {
      this.unownedExits.set(`${endpoint}\n${relayPtyId}`, code)
    }
  }

  exitBeforeAdoption(relayPtyId: string, endpoint: string): number | undefined {
    return this.unownedExits.get(`${endpoint}\n${relayPtyId}`)
  }

  /** After each listing: an exit it did not use came from a relay it did not adopt. */
  clearExits(): void {
    this.unownedExits.clear()
  }
}
