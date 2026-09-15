// Vendoring @topupsaja/core ke dalam dist/ sebelum publish.
// Scope npm `topupsaja` belum bisa dipublish (org belum ada), jadi paket
// topupsaja-cli harus self-contained seperti dulu (0.8.0): salin core/dist
// ke dist/core lalu tulis ulang specifier import '@topupsaja/core/…' → relatif.
// Jalankan SETELAH build core & cli (dipakai sebagai prepack).
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(cliDir, 'dist')
const coreDist = join(cliDir, '..', 'core', 'dist')
const vendored = join(distDir, 'core')

if (!statSync(coreDist, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('vendor-core: core/dist tidak ada — build core dulu (npm run build di core/)')
  process.exit(1)
}
if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('vendor-core: cli/dist tidak ada — build cli dulu')
  process.exit(1)
}

cpSync(coreDist, vendored, { recursive: true })

const RE = /(['"])@topupsaja\/core\/([^'"]+)\1/g
let rewritten = 0
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (p === vendored) continue
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.js')) {
      const src = readFileSync(p, 'utf8')
      const out = src.replace(RE, (_m, q, sub) => {
        const rel = relative(dirname(p), join(vendored, sub)).split(sep).join('/')
        return `${q}${rel.startsWith('.') ? rel : './' + rel}${q}`
      })
      if (out !== src) {
        writeFileSync(p, out)
        rewritten++
      }
    }
  }
}
walk(distDir)
console.log(`vendor-core: core → dist/core, ${rewritten} file import di-rewrite`)
