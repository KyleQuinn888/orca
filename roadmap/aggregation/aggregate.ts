// 002/003 aggregation entry — spec layer-002-003 v7.3
// Step 0 lazy promotion -> Step 1 fold -> Step 1.5 LLM proposal -> Step 2 identity
// match -> Step 3 naming -> Step 4 validate -> Step 5 write (marks -> 002 -> INDEX).
// Hosts the manual verb flags and marks tooling.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { MarksStore, loadMarks, restoreFromBak, ulid } from './marks-store'
import { AggregateLock } from './aggregate-lock'
import { loadChapters, type Signal } from './chapters'
import { fold } from './fold'
import { evaluatePromotions } from './promote'
import { proposeForGroup, zcodeSpawnLLM } from './propose'
import { parseExisting, renderMilestone, renderIndex, llmName, type NamedGroup } from './render'
import { verbAddCut, verbSuppress, verbReview } from './verbs'
import { ensureAgentsMd } from './agents-md'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sessionDir = args.find((a) => !a.startsWith('--'))
  if (!sessionDir || !existsSync(sessionDir)) {
    console.error(
      'usage: bun roadmap/aggregation/aggregate.ts <sessionDir> [--now <ISO>] [--mark-add N] [--mark-suppress-signal type:seq] [--mark-suppress-mark id] [--review <pg-or-mk>:<approve|reject>] [--marks-validate] [--marks-restore] [--dry]'
    )
    process.exit(1)
  }
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i !== -1 ? args[i + 1] : undefined
  }
  const nowOverride = flag('now') ? new Date(flag('now')!) : undefined

  const sessionId = basename(sessionDir)
  const workspace = dirname(dirname(dirname(sessionDir)))
  const roadmap002Dir = join(workspace, '.roadmap', '002')

  if (args.includes('--marks-restore')) {
    const r = restoreFromBak(roadmap002Dir)
    console.log(r.message)
    process.exit(r.restored ? 0 : 1)
  }

  const lock = AggregateLock.acquire(roadmap002Dir)
  try {
    const loaded = loadMarks(roadmap002Dir)
    if (!loaded.ok) {
      console.error(`marks file problem: ${loaded.error}`)
      console.error(
        loaded.recoverable
          ? 'recover with: --marks-restore (restores boundaries.json.bak)'
          : 'fix the file manually, then re-run'
      )
      process.exit(1)
    }
    const chapters = loadChapters(sessionDir)
    if (chapters.length === 0) {
      console.error('no live chapters found')
      process.exit(1)
    }
    const store = new MarksStore(roadmap002Dir, lock, loaded.events)
    let events = store.all

    if (args.includes('--marks-validate')) {
      console.log(`marks OK: ${events.length} events`)
    }

    // manual verbs (validate-then-append)
    const markAdd = flag('mark-add')
    if (markAdd !== undefined) {
      console.log(verbAddCut(store, [...events], sessionId, chapters, Number(markAdd), ''))
      events = store.all
    }
    const supSignal = flag('mark-suppress-signal')
    if (supSignal) {
      const [type, seq] = supSignal.split(':')
      console.log(
        verbSuppress(store, [...events], sessionId, chapters, {
          signalType: type ?? '',
          signalSeq: Number(seq)
        })
      )
      events = store.all
    }
    const supMark = flag('mark-suppress-mark')
    if (supMark) {
      console.log(verbSuppress(store, [...events], sessionId, chapters, { markId: supMark }))
      events = store.all
    }
    const review = flag('review')
    if (review) {
      const [target, decision] = review.split(':') as [string, 'approve' | 'reject']
      console.log(verbReview(store, [...events], sessionId, target, decision, ''))
      events = store.all
    }
    if (args.includes('--dry')) {
      console.log('dry run: verbs applied, aggregation skipped')
      return
    }

    // TUI source carries no journal signals — journal source is R1's domain
    const signals: Signal[] = []

    // Step 0: lazy promotion (first evaluation past 72h freezes outcome as events)
    const now = nowOverride ?? new Date()
    const promotion = evaluatePromotions(sessionId, [...events], signals, chapters, now)
    if (promotion.events.length > 0) {
      store.append(promotion.events)
    }
    for (const d of promotion.decisions) {
      console.log(`  ${d}`)
    }
    events = store.all

    // Step 1: deterministic fold over the full event stream
    const folded = fold(sessionId, [...events], signals, chapters)
    console.log(
      `fold: ${folded.groups.length} group(s) [${folded.groups.map((g) => `Ch.${g.chapters[0]!.index}-${g.chapters.at(-1)!.index}`).join(', ')}]`
    )

    // Step 1.5: LLM subdivision proposals for >8 groups (this run's grouping unaffected)
    for (const group of folded.groups) {
      const outcome = await proposeForGroup(sessionId, group, folded, [...events], zcodeSpawnLLM())
      if (outcome.kind === 'events') {
        store.append(outcome.events)
        events = store.all
        const pending = outcome.events.filter((e) => e.op === 'add-cut')
        if (pending.length > 0) {
          console.log(
            `  proposal: ${pending.length} cut(s) pending review [${pending[0]!.proposalGroupId}]`
          )
        } else {
          console.log(`  proposal attempt recorded: ${outcome.events[0]?.outcome}`)
        }
      }
    }

    // Step 2: identity match (triple separation, unchanged)
    const existing = parseExisting(roadmap002Dir)
    const needLLM: number[] = []
    const results: NamedGroup[] = folded.groups.map((group, i) => {
      const match = existing.find((e) => e.boundaryKey === group.boundaryKey)
      if (match && match.chapterSetHash === group.chapterSetHash) {
        console.log(`  group ${i + 1}: full match (skip LLM)`)
        return {
          ...group,
          id: match.id,
          title: match.title,
          summary: match.summary,
          outcome: match.outcome,
          contentGeneratedAt: match.contentGeneratedAt
        }
      }
      if (match) {
        console.log(`  group ${i + 1}: boundaryKey match, hash changed (re-LLM, reuse ${match.id})`)
      } else {
        console.log(`  group ${i + 1}: new (LLM)`)
      }
      needLLM.push(i)
      return {
        ...group,
        id: match?.id ?? `m-${ulid()}`,
        title: match?.title ?? '',
        summary: '',
        outcome: '',
        contentGeneratedAt: ''
      }
    })

    // Step 3: LLM naming for groups needing it
    if (needLLM.length > 0) {
      const named = await llmName(
        needLLM.map((i) => {
          const g = folded.groups[i]!
          const n = g.chapters.length
          return {
            group: g,
            spanHint: n > 10 ? ` (${n} 章 — 层次化总结: 每 3-5 章一层小结论 + 总述)` : ''
          }
        }),
        sessionId
      )
      const generatedAt = new Date().toISOString()
      needLLM.forEach((gi, j) => {
        results[gi]!.title = named[j]!.title
        results[gi]!.summary = named[j]!.summary
        results[gi]!.outcome = named[j]!.outcome
        results[gi]!.contentGeneratedAt = generatedAt
      })
    } else {
      console.log('all groups matched, no LLM naming needed')
    }

    // Step 4: validation (coverage + non-first group starts at its boundary chapter)
    const covered = new Set(results.flatMap((r) => r.chapters.map((c) => c.index)))
    for (const ch of chapters) {
      if (!covered.has(ch.index)) {
        throw new Error(`chapter Ch.${ch.index} not covered by any group`)
      }
    }
    for (let i = 1; i < results.length; i++) {
      if (results[i]!.chapters[0]!.index !== results[i]!.startChapter) {
        throw new Error(
          `group ${i}: chapters[0]=Ch.${results[i]!.chapters[0]!.index} != boundary chapter Ch.${results[i]!.startChapter}`
        )
      }
    }

    // Step 5: write (marks already persisted; now 002 files then INDEX)
    mkdirSync(roadmap002Dir, { recursive: true })
    for (const ms of results) {
      const content = renderMilestone(ms, sessionId, chapters)
      const filePath = join(roadmap002Dir, `${ms.id}.md`)
      if (existsSync(filePath)) {
        const stripVolatile = (s: string): string => s.replace(/^fileUpdatedAt: '.*'$/m, '')
        if (stripVolatile(readFileSync(filePath, 'utf8')) === stripVolatile(content)) {
          console.log(`  unchanged: ${ms.id}.md (skip write)`)
          continue
        }
      }
      const tmp = `${filePath}.tmp`
      writeFileSync(tmp, content, 'utf8')
      renameSync(tmp, filePath)
      console.log(`  written: ${ms.id}.md "${ms.title}"`)
    }

    // supersede this session's old milestones that no longer match any group
    const currentKeys = new Set(folded.groups.map((g) => g.boundaryKey))
    for (const e of existing) {
      if (!e.file || e.session !== sessionId) {
        continue
      }
      if (currentKeys.has(e.boundaryKey) || e.boundaryKey === '' || e.quality === 'superseded') {
        continue
      }
      const filePath = join(roadmap002Dir, e.file)
      const updated = readFileSync(filePath, 'utf8')
        .replace(/^quality: .+$/m, 'quality: superseded')
        .replace(/^fileUpdatedAt: '.*'$/m, `fileUpdatedAt: '${new Date().toISOString()}'`)
      const tmp = `${filePath}.tmp`
      writeFileSync(tmp, updated, 'utf8')
      renameSync(tmp, filePath)
      console.log(`  superseded: ${e.file} "${e.title}"`)
    }

    // INDEX (zero-LLM view, skip-if-unchanged)
    const indexPath = join(workspace, '.roadmap', 'INDEX.md')
    const indexContent = renderIndex(results, sessionId, chapters)
    let indexWritten = false
    if (existsSync(indexPath)) {
      const stripGen = (s: string): string => s.replace(/^generatedAt: '.*'$/m, '')
      if (stripGen(readFileSync(indexPath, 'utf8')) === stripGen(indexContent)) {
        console.log('INDEX.md unchanged (skip write)')
      } else {
        indexWritten = true
      }
    } else {
      indexWritten = true
    }
    if (indexWritten) {
      const indexTmp = `${indexPath}.tmp`
      writeFileSync(indexTmp, indexContent, 'utf8')
      renameSync(indexTmp, indexPath)
      console.log(`INDEX.md rebuilt (${results.length} milestones, ${chapters.length} chapters)`)
    }

    // agent entry point last (spec agent-retrieval §4: after INDEX; runs every
    // aggregation, including no-op ones — its own skip-unchanged is cheap)
    const agents = ensureAgentsMd(workspace)
    console.log(`  ${agents.message}`)

    console.log('\n=== DONE ===')
  } finally {
    lock.release()
  }
}

void main()
