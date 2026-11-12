import { format } from './format.js'

// workaround: the upstream formatter throws on a row with a single empty cell
export function render(rows: string[][]): string {
  if (rows.length === 0) return ''
  return rows.map((row) => format(row)).join('\n')
}
