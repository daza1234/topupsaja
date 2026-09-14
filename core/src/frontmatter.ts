/** Parser frontmatter YAML-sederhana `---\nkey: value\n---\nbody` (dipakai modes & commands). */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  let body = raw
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
    body = raw.slice(m[0].length)
  }
  return { meta, body }
}
