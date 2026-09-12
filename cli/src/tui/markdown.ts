import pc from 'picocolors'

// ── Naif syntax highlight (~100 baris, tanpa dep) ──
const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'import', 'from', 'export', 'default', 'class', 'extends', 'new', 'await', 'async',
  'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'interface', 'type',
  'implements', 'public', 'private', 'protected', 'static', 'readonly', 'enum', 'switch',
  'case', 'break', 'continue', 'in', 'of', 'as', 'is', 'not', 'and', 'or', 'def',
  'elif', 'lambda', 'pass', 'None', 'True', 'False', 'self', 'package', 'func',
  'struct', 'match', 'null', 'undefined', 'true', 'false', 'void', 'yield',
])

function highlightCode(line: string): string {
  // Komentar satu baris penuh → redup seluruhnya.
  const trimmed = line.trimStart()
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('--') ||
    trimmed.startsWith('/*')
  ) {
    return pc.dim(line)
  }
  // Tokenize: string, angka, keyword, sisanya apa adanya.
  let out = ''
  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)
    const str = rest.match(/^(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
    if (str) {
      out += pc.green(str[1])
      i += str[1].length
      continue
    }
    const word = rest.match(/^[A-Za-z_$][\w$]*/)
    if (word) {
      out += KEYWORDS.has(word[1]) ? pc.yellow(word[1]) : word[1]
      i += word[1].length
      continue
    }
    const num = rest.match(/^\d[\d_.]*/)
    if (num) {
      out += pc.magenta(num[1])
      i += num[1].length
      continue
    }
    out += line[i]
    i += 1
  }
  return out
}

/** Inline: **bold**, `code` (dipakai di luar fenced block). */
function inline(text: string): string {
  let out = ''
  let rest = text
  // Proses berurutan: bold lalu inline code per segmen.
  while (rest.length > 0) {
    const bold = rest.match(/\*\*(.+?)\*\*/)
    const code = rest.match(/`([^`]+)`/)
    const bIdx = bold?.index ?? Infinity
    const cIdx = code?.index ?? Infinity
    if (bIdx === Infinity && cIdx === Infinity) {
      out += rest
      break
    }
    if (bIdx < cIdx) {
      out += rest.slice(0, bIdx) + pc.bold(bold![1])
      rest = rest.slice(bIdx + bold![1].length + 4)
    } else {
      out += rest.slice(0, cIdx) + pc.cyan(code![1])
      rest = rest.slice(cIdx + code![1].length + 2)
    }
  }
  return out
}

/** Renderer markdown ringan untuk TUI via picocolors (ANSI). */
export function renderMarkdownPlain(text: string): string {
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  for (const line of text.split('\n')) {
    const fence = line.match(/^```\s*(\S*)/)
    if (fence) {
      if (!inCode) {
        inCode = true
        codeLang = fence[1] ?? ''
        out.push(pc.dim('┌' + (codeLang ? ` ${codeLang} ` : '') + '─'.repeat(3)))
      } else {
        inCode = false
        out.push(pc.dim('└' + '─'.repeat(3)))
      }
      continue
    }
    if (inCode) {
      out.push(pc.dim('│ ') + highlightCode(line))
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      out.push(pc.bold(heading[2]))
      continue
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/)
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2])}`)
      continue
    }
    out.push(inline(line))
  }
  return out.join('\n')
}
