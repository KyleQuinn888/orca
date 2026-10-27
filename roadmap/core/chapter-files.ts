// Shared chapter-card filename rules and markdown table escaping. The three
// directory scanners (index refresh, pits rebuild, term scan) each carried a
// drifted copy of this filter — the drift is the root cause of superseded
// cards leaking into index refresh and "index"-slugged chapters being dropped.

/**
 * True only for chapter card files `NNN-slug.md`: excludes lifecycle drafts
 * (.new.md / .legacy.md / .superseded.md) and the session index card
 * (000-index.md / legacy 00-index.md), while ADMITTING chapters whose slug
 * legitimately contains "index" (003-index-migration.md is a chapter).
 */
export function isChapterCardFile(name: string): boolean {
  if (!/^\d+-.*\.md$/.test(name)) {
    return false
  }
  if (name.endsWith('.superseded.md') || name.endsWith('.legacy.md') || name.endsWith('.new.md')) {
    return false
  }
  if (/^0{2,}-index\.md$/.test(name) || name === '000-index.md') {
    return false
  }
  return true
}

/** Markdown table cell escaper: pipes escaped, newlines flattened, length capped. */
export function escapeCell(text: string, maxLen = 120): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, maxLen)
}
