/**
 * Extract user-shaped nodes from Instagram GraphQL JSON payloads.
 * Instagram bundles many shapes under data/extensions; we walk the tree and keep
 * objects that look like User rows (username + pk/id). Endpoint URLs vary;
 * we key off response URLs containing graphql/query in collect.ts, not on doc IDs here.
 */
export type User = { username: string; id?: string; full_name?: string }

const USERNAME_RE = /^[a-zA-Z0-9._]{1,30}$/

export function extractUsersFromPayload(data: unknown): User[] {
  const out: User[] = []
  const seen = new Set<string>()

  function tryPush(o: Record<string, unknown>): void {
    const username = o.username
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return

    const pk = o.pk ?? o.id
    if (pk === undefined || pk === null) return

    let id: string
    if (typeof pk === 'number') id = String(pk)
    else if (typeof pk === 'string' && /^\d+$/.test(pk)) id = pk
    else return

    const fn = o.full_name ?? o.fullName
    const full_name = typeof fn === 'string' ? fn : ''

    const key = id.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ username, id, full_name })
  }

  function walk(node: unknown): void {
    if (node === null || node === undefined) return
    if (typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const x of node) walk(x)
      return
    }
    const o = node as Record<string, unknown>
    tryPush(o)
    for (const k of Object.keys(o)) walk(o[k])
  }

  walk(data)
  return out
}
