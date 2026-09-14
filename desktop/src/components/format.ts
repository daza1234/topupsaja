export function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(n);
}

export function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}
