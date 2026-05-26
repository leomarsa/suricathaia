export function normalizeCpf(cpf: string): string {
  return cpf.replace(/\D/g, '')
}

export function formatCpf(cpf: string): string {
  const d = normalizeCpf(cpf).slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0,3)}.${d.slice(3)}`
  if (d.length <= 9) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6)}`
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9,11)}`
}

export function validateCpf(cpf: string): boolean {
  const n = normalizeCpf(cpf)
  if (n.length !== 11 || new Set(n).size === 1) return false
  for (const k of [9, 10]) {
    const sum = Array.from({ length: k }, (_, i) => parseInt(n[i]) * (k + 1 - i)).reduce((a, b) => a + b, 0)
    const d = (sum * 10 % 11) % 10
    if (d !== parseInt(n[k])) return false
  }
  return true
}
