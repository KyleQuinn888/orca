/**
 * A mirror of nodejs.org/dist (an internal artifact proxy, or a regional mirror) for the pinned
 * Node runtime. It only changes where bytes come from: the SHA-256 pin decides what is accepted.
 */

/** The variables Node tooling already reads for the same mirror; read on this computer only. */
export const NODE_DIST_MIRROR_ENV_KEYS = ['NODEJS_ORG_MIRROR', 'NVM_NODEJS_ORG_MIRROR'] as const

export type NodeDistMirrorValidationResult =
  | { ok: true; value: string; message?: undefined }
  | { ok: false; value: ''; message: string }

const NODE_DIST_MIRROR_MAX_LENGTH = 2048

/** An http(s) base URL with no query or fragment and no trailing slash; empty means none. */
export function normalizeNodeDistMirrorUrl(value: unknown): NodeDistMirrorValidationResult {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) {
    return { ok: true, value: '' }
  }
  if (trimmed.length > NODE_DIST_MIRROR_MAX_LENGTH) {
    return { ok: false, value: '', message: 'Mirror URL is too long.' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, value: '', message: 'Enter a valid mirror URL.' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, value: '', message: 'Use an http or https mirror URL.' }
  }
  // Why: the URL reaches SSH hosts and error text; credentials belong in the proxy setting.
  if (parsed.username || parsed.password) {
    return { ok: false, value: '', message: 'Mirror URL cannot contain a user name or password.' }
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, value: '', message: 'Mirror URL cannot have a query or fragment.' }
  }
  // Why origin + pathname: href keeps an empty `?` or `#`, which would swallow the archive path.
  return { ok: true, value: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/u, '') }
}

/** The first valid mirror among Orca's setting and the conventional environment variables. */
export function resolveNodeDistMirror(
  setting: string | undefined,
  env: Record<string, string | undefined>
): string | null {
  for (const candidate of [setting, ...NODE_DIST_MIRROR_ENV_KEYS.map((key) => env[key])]) {
    const normalized = normalizeNodeDistMirrorUrl(candidate)
    if (normalized.ok && normalized.value) {
      return normalized.value
    }
  }
  return null
}

export function nodeDistMirrorUrl(mirror: string, version: string, file: string): string {
  return `${mirror}/v${version}/${file}`
}
