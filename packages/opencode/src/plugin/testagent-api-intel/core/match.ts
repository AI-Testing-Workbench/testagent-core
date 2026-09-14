// testagent_change - endpoint reference parsing and matching.

export type ParsedRef = {
  method?: string
  name?: string
  path?: string
}

export type Candidate = {
  name: string
  method: string
  path: string
  apiId?: number
  status?: string
}

export function parseEndpointRef(raw: string): ParsedRef | null {
  const s = raw.trim()
  if (!s) return null
  const tokens = s.split(/\s+/)
  if (tokens.length === 1) return { name: tokens[0] }
  if (tokens.length >= 3) {
    const method = tokens[0].toUpperCase()
    const path = tokens.slice(1).join(" ")
    return { method, path }
  }
  // 2 tokens: "METHOD path" (path starts with '/') or "METHOD name"
  const first = tokens[0]
  const second = tokens[1]
  if (/^[A-Z]+$/.test(first)) {
    if (second.startsWith("/")) return { method: first.toUpperCase(), path: second }
    return { method: first.toUpperCase(), name: second }
  }
  return { name: first, path: second }
}

export function normalizePath(p: string): string {
  return p
    .replace(/\{(\w+)\}/g, ":$1")
    .replace(/\/+$/, "")
    .toLowerCase()
}

export function matchRef(ref: ParsedRef, candidates: Candidate[]): Candidate[] {
  const out: Candidate[] = []
  for (const c of candidates) {
    if (ref.method && c.method.toUpperCase() !== ref.method) continue
    if (ref.path) {
      if (normalizePath(c.path) === normalizePath(ref.path)) out.push(c)
      continue
    }
    if (ref.name) {
      if (c.name === ref.name) out.push(c)
      continue
    }
  }
  return out
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

export function suggestCandidates(
  ref: string,
  candidates: Candidate[],
  limit = 3,
): Candidate[] {
  return candidates
    .map((c) => ({ c, d: levenshtein(ref, `${c.method} ${c.name}`) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.c)
}