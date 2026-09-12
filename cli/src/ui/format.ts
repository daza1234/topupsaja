export function fmtNum(n: number): string {
  return n.toLocaleString('id-ID')
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
