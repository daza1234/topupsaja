import { execFile } from 'node:child_process'
import { streamChat } from '../api.js'
import type { AgentRuntime } from './runtime.js'

const MAX_DIFF_CHARS = 40_000

function execFileP(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message)))
      else resolve(String(stdout))
    })
  })
}

/** Repo git? (git rev-parse --is-inside-work-tree) */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await execFileP('git', ['rev-parse', '--is-inside-work-tree'], cwd)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

export type CollectDiffResult =
  | { ok: true; diff: string }
  | { ok: false; error: string }

/**
 * Kumpulkan diff untuk /commit: git diff HEAD (fallback git diff bila
 * belum ada commit) + git status --porcelain (untracked tercatat). Cap 40k char.
 */
export async function collectDiff(cwd: string): Promise<CollectDiffResult> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: 'Bukan repo git — /commit butuh folder dengan git init.' }
  }
  let diff = ''
  try {
    diff = await execFileP('git', ['diff', 'HEAD'], cwd)
  } catch {
    try {
      diff = await execFileP('git', ['diff'], cwd) // repo tanpa commit (unborn HEAD)
    } catch (e) {
      return { ok: false, error: `git diff gagal: ${(e as Error).message.slice(0, 200)}` }
    }
  }
  let status = ''
  try {
    status = await execFileP('git', ['status', '--porcelain'], cwd)
  } catch {
    /* status gagal — lanjut tanpa */
  }
  let combined = ''
  if (status.trim()) combined += `## git status --porcelain\n${status}\n`
  if (diff.trim()) combined += `## git diff HEAD\n${diff}`
  if (!combined.trim()) return { ok: true, diff: '' }
  if (combined.length > MAX_DIFF_CHARS) {
    combined = combined.slice(0, MAX_DIFF_CHARS) + '\n... (diff dipotong 40k char)'
  }
  return { ok: true, diff: combined }
}

/** Murni & testable: ekstrak pesan commit dari keluaran model (strip fence, subject + body ≤10 baris). */
export function extractCommitMessage(text: string): string {
  let t = text.trim()
  const fence = t.match(/```[^\r\n]*\r?\n([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  t = t.replace(/^(pesan commit|commit message|commit)\s*:\s*/i, '')
  const lines = t
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => l.trim() !== '' || (i > 0 && i < arr.length - 1))
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.slice(0, 11).join('\n').trim() // subject + body ≤10 baris
}

/** Turn non-tool via streamChat: model buat pesan commit conventional dari diff. */
export async function generateCommitMessage(rt: AgentRuntime, diff: string): Promise<string> {
  const prompt = `Buat pesan commit git (conventional commit) dari perubahan berikut.

ATURAN:
- Baris pertama: type(scope): deskripsi singkat (maks 72 char), gunakan type seperti feat/fix/chore/docs/refactor/test.
- Setelah baris kosong, body maksimal 10 baris: what & why penting saja.
- Bahasa mengikuti isi perubahan/diff; bila campur, gunakan Bahasa Indonesia.
- Jawab HANYA pesan commit — tanpa penjelasan lain, tanpa code fence.

<diff>
${diff}
</diff>`
  const r = await streamChat(
    { model: rt.session.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 },
    {}
  )
  if (r.creditsUsed !== undefined) rt.session.creditsUsed += r.creditsUsed
  const msg = extractCommitMessage(r.content)
  if (!msg) throw new Error('Model tidak menghasilkan pesan commit.')
  return msg
}

/** git add -A lalu git commit -m <msg>. Return keluaran singkat untuk ditampilkan. */
export async function performCommit(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
  try {
    await execFileP('git', ['add', '-A'], cwd)
    const out = await execFileP('git', ['commit', '-m', message], cwd)
    return { ok: true, output: out.trim().slice(0, 300) || 'committed' }
  } catch (e) {
    return { ok: false, output: ((e as Error).message || 'commit gagal').trim().slice(0, 300) }
  }
}
