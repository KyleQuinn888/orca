// Card file I/O: idempotent writes by {sessionId, chapter.index} with the
// lifecycle rules (handEdited protection, supersede stale slugs, quarantine
// unparseable). Split from card.ts for the max-lines ratchet.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { chapterFileName, parseCard, serializeCard, type RoadmapCard } from './card'
import { CardParseError } from './card-parse'

export type WriteResult =
  | { outcome: 'written'; path: string }
  | { outcome: 'hand-edited-kept'; path: string; draftPath: string }
  | { outcome: 'legacy-quarantined'; path: string; legacyPath: string }

/**
 * Idempotent atomic write by {sessionId, chapter.index}: stale same-index
 * files with a different slug are removed (filename is derived, not identity),
 * handEdited cards keep the original (.new.md draft), unparseable cards
 * quarantine to .legacy.md instead of aborting the pipeline.
 */
export function writeCard(directory: string, card: RoadmapCard): WriteResult {
  mkdirSync(directory, { recursive: true })
  const f = card.frontmatter
  const isIndex = f.kind === 'session-index'
  const wanted = isIndex
    ? '000-index.md'
    : chapterFileName(f.chapter?.index ?? 0, f.chapter?.slug ?? 'untitled')
  const path = join(directory, wanted)
  let quarantined: string | null = null
  for (const name of readdirSync(directory)) {
    if (name === wanted || (!name.endsWith('.md') && !name.endsWith('.new.md'))) {
      continue
    }
    if (
      isIndex ? name === '00-index.md' || name.endsWith('-index.md') : sameIndexFile(name, wanted)
    ) {
      const existingPath = join(directory, name)
      if (name.endsWith('.legacy.md') || name.endsWith('.superseded.md')) {
        continue
      }
      let existingText: string
      try {
        existingText = readFileSync(existingPath, 'utf8')
      } catch {
        continue
      }
      try {
        const existing = parseCard(existingText)
        if (!isIndex && existing.frontmatter.handEdited) {
          const draftPath = `${path.slice(0, -3)}.new.md`
          atomicWrite(draftPath, serializeCard(card))
          return { outcome: 'hand-edited-kept', path: existingPath, draftPath }
        }
        if (existing.frontmatter.kind !== 'session-index') {
          renameSync(existingPath, `${existingPath.slice(0, -3)}.superseded.md`)
        }
      } catch (error) {
        if (error instanceof CardParseError) {
          renameSync(existingPath, `${existingPath.slice(0, -3)}.legacy.md`)
          quarantined = `${name}.legacy.md`
          console.warn(
            `[roadmap] quarantined unparseable card to ${name}.legacy.md: ${error.message}`
          )
        } else {
          throw error
        }
      }
    }
  }
  if (existsSync(path)) {
    const existing = parseCard(readFileSync(path, 'utf8'))
    if (!isIndex && existing.frontmatter.handEdited) {
      const draftPath = `${path.slice(0, -3)}.new.md`
      atomicWrite(draftPath, serializeCard(card))
      return { outcome: 'hand-edited-kept', path, draftPath }
    }
  }
  atomicWrite(path, serializeCard(card))
  if (quarantined !== null) {
    return { outcome: 'legacy-quarantined', path, legacyPath: quarantined }
  }
  return { outcome: 'written', path }
}

function sameIndexFile(name: string, wanted: string): boolean {
  // Compare numerically: v1 files used 2-digit padding, v1.1 uses 3.
  const wantedMatch = /^(\d+)-.*\.md$/.exec(wanted)
  const nameMatch = /^(\d+)-.*\.md$/.exec(name)
  return (
    wantedMatch !== null && nameMatch !== null && Number(wantedMatch[1]) === Number(nameMatch[1])
  )
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}
