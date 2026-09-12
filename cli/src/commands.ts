import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CustomCommand {
  /** Nama slash termasuk '/', mis. '/review'. */
  name: string
  description: string
  body: string
}

/** Parse frontmatter YAML-minimal: baris `key: value` → meta map (nilai di-trim, kutip dibuang) + body. */
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

/**
 * Discovery custom slash commands:
 *   <cwd>/.tsa/commands/*.md  (project, menang saat nama bentrok)
 *   ~/.topupsaja/commands/*.md (global)
 * Nama slash = nama file tanpa .md.
 */
export function discoverCommands(cwd: string): CustomCommand[] {
  const dirs = [
    path.join(cwd, '.tsa', 'commands'),
    path.join(os.homedir(), '.topupsaja', 'commands'),
  ]
  const map = new Map<string, CustomCommand>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const name = '/' + f.slice(0, -3)
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8')
        const { meta, body } = parseFrontmatter(raw)
        if (!map.has(name)) map.set(name, { name, description: meta.description ?? '', body })
      } catch {
        /* file korup — skip */
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Render body command: $ARGUMENTS diganti argumen user. */
export function renderCommand(cmd: CustomCommand, args: string): string {
  return cmd.body.replaceAll('$ARGUMENTS', args).trim()
}

/** Baris /help untuk custom commands (kosong bila tidak ada). */
export function customHelpLines(cmds: CustomCommand[]): string {
  if (cmds.length === 0) return ''
  return (
    '\nPerintah kustom:\n' +
    cmds.map((c) => `  ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')
  )
}
