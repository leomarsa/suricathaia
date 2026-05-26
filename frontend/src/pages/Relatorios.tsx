import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getEmitente, getCustomReport, getCameras,
  type Emitente, type CustomReport, type Camera, type HeatmapCell,
} from '../api'
import { useAuth } from '../hooks/useAuth'
import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import {
  ResponsiveContainer, AreaChart, Area, Line,
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

// ── Palette (print-safe) ──────────────────────────────────────────────────────

const P = {
  navy:   '#1a3a5c',
  blue:   '#2563eb',
  slate:  '#64748b',
  light:  '#e2e8f0',
  green:  '#16a34a',
  amber:  '#d97706',
  red:    '#dc2626',
  ink:    '#0f172a',
  muted:  '#94a3b8',
  paper:  '#ffffff',
  bg:     '#f8fafc',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtD   = (s: string) => { try { return format(parseISO(s), 'dd/MM', { locale: ptBR }) } catch { return s } }
const fmtDF  = (s: string) => { try { return format(parseISO(s), 'dd/MM/yyyy', { locale: ptBR }) } catch { return s } }
const fmtN   = (n: unknown) => (n == null || n === '' ? '—' : Number(n).toLocaleString('pt-BR'))
const fmtPct = (n: unknown) => (n == null ? '—' : `${Number(n).toFixed(1)}%`)
const good   = (ok: boolean) => ok ? P.green : P.amber

const TABS = [
  { value: 'lpr',     label: 'Leitura LPR',  icon: 'M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z' },
  { value: 'pessoas', label: 'Pessoas',       icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z' },
  { value: 'epi',     label: 'EPI / PPE',     icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  { value: 'geral',   label: 'Consolidado',   icon: 'M18 20V10 M12 20V4 M6 20v-6' },
]

const PRESETS = [
  { label: 'Hoje',      days: 0  },
  { label: '7 dias',    days: 6  },
  { label: '15 dias',   days: 14 },
  { label: '30 dias',   days: 29 },
  { label: 'Mês atual', days: -1 },
]

function presetRange(days: number): [string, string] {
  const today = new Date()
  const fmt = (d: Date) => format(d, 'yyyy-MM-dd')
  if (days === -1) {
    return [fmt(new Date(today.getFullYear(), today.getMonth(), 1)), fmt(today)]
  }
  return [fmt(new Date(Date.now() - days * 864e5)), fmt(today)]
}

// ── Print styles ──────────────────────────────────────────────────────────────

const PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 14mm 16mm 18mm; }
  body > * { display: none !important; }
  #relatorio-doc { display: block !important; }
  #relatorio-doc {
    position: static !important;
    width: 100% !important;
    background: #fff !important;
    box-shadow: none !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
  }
  .no-print { display: none !important; }
  .doc-section { break-inside: avoid; page-break-inside: avoid; }
  .doc-chart  { break-inside: avoid; }
  .doc-table  { break-inside: auto; }
  .doc-table tr { break-inside: avoid; }
}
`

// ── Icon ──────────────────────────────────────────────────────────────────────

function Ic({ d, size = 14, color }: { d: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color || 'currentColor'} strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  )
}

// ── Metric strip ──────────────────────────────────────────────────────────────

interface Metric { label: string; value: string; sub?: string; accent?: string; icon?: string }

function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${metrics.length}, 1fr)`,
      border: `1px solid ${P.light}`,
      borderRadius: 8,
      overflow: 'hidden',
      marginBottom: 28,
      background: P.paper,
    }}>
      {metrics.map((m, i) => (
        <div key={i} style={{
          padding: '18px 20px',
          borderRight: i < metrics.length - 1 ? `1px solid ${P.light}` : undefined,
          background: i === 0 ? P.bg : P.paper,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: P.muted, marginBottom: 8 }}>
            {m.label}
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: m.accent || P.ink, lineHeight: 1, letterSpacing: '-0.02em' }}>
            {m.value}
          </div>
          {m.sub && (
            <div style={{ fontSize: 11, color: P.muted, marginTop: 5 }}>{m.sub}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 14, paddingBottom: 10,
      borderBottom: `2px solid ${P.ink}`,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: P.ink }}>
        {title}
      </span>
      {right && <span style={{ fontSize: 11, color: P.muted }}>{right}</span>}
    </div>
  )
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────

function ChartTip({ active, payload, label }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: P.paper, border: `1px solid ${P.light}`,
      borderRadius: 6, padding: '8px 12px', fontSize: 12,
      boxShadow: '0 4px 16px rgba(0,0,0,.12)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 5, color: P.slate, fontSize: 10, letterSpacing: '.05em', textTransform: 'uppercase' }}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 7, color: P.ink, marginBottom: 2 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
          <span style={{ color: P.slate }}>{p.name}:</span>
          <strong>{typeof p.value === 'number' ? p.value.toLocaleString('pt-BR') : p.value}</strong>
        </div>
      ))}
    </div>
  )
}

// ── Data table ────────────────────────────────────────────────────────────────

type Col = {
  key: string; label: string; align?: 'right' | 'center'
  render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode
}

function DataTable({ cols, rows }: { cols: Col[]; rows: Record<string, unknown>[] }) {
  if (!rows.length) return (
    <div style={{ color: P.muted, fontSize: 13, padding: '16px 0', textAlign: 'center' }}>
      Sem dados no período.
    </div>
  )
  return (
    <div className="doc-table" style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: P.ink }}>
            {cols.map(c => (
              <th key={c.key} style={{
                padding: '8px 12px', textAlign: c.align || 'left',
                fontSize: 9, fontWeight: 700, letterSpacing: '.08em',
                textTransform: 'uppercase', color: '#fff', whiteSpace: 'nowrap',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? P.paper : P.bg }}>
              {cols.map(c => (
                <td key={c.key} style={{
                  padding: '8px 12px', textAlign: c.align || 'left',
                  borderBottom: `1px solid ${P.light}`, fontSize: 12, color: P.ink,
                }}>
                  {c.render ? c.render(row[c.key], row) : String(row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Document Header ───────────────────────────────────────────────────────────

function DocHeader({ emitente, titulo, periodo }: { emitente: Emitente; titulo: string; periodo: string }) {
  return (
    <div style={{ marginBottom: 32 }}>
      {/* Top band */}
      <div style={{
        background: P.navy,
        borderRadius: 8,
        padding: '20px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 0,
      }}>
        {/* Left: company */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {emitente.logo_url && (
            <img src={emitente.logo_url} alt="logo"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              style={{ maxHeight: 40, maxWidth: 110, objectFit: 'contain', filter: 'brightness(0) invert(1)' }}
            />
          )}
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
              {emitente.nome_empresa || 'SuricathaIA'}
            </div>
            {emitente.cnpj && (
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,.55)', marginTop: 3 }}>
                CNPJ {emitente.cnpj}
                {emitente.cidade_uf && ` · ${emitente.cidade_uf}`}
              </div>
            )}
          </div>
        </div>

        {/* Right: report badge */}
        <div style={{ textAlign: 'right' }}>
          <div style={{
            display: 'inline-block',
            border: '1px solid rgba(255,255,255,.3)',
            borderRadius: 4, padding: '2px 10px', marginBottom: 6,
            fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
            textTransform: 'uppercase', color: 'rgba(255,255,255,.7)',
          }}>
            RELATÓRIO ANALÍTICO
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>{titulo}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,.6)', marginTop: 4 }}>{periodo}</div>
        </div>
      </div>

      {/* Sub-rule */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 4px', borderBottom: `1px solid ${P.light}`, marginBottom: 24,
      }}>
        <span style={{ fontSize: 10, color: P.muted }}>
          Sistema de Monitoramento Inteligente — SuricathaIA
        </span>
        <span style={{ fontSize: 10, color: P.muted }}>
          Emitido em {format(new Date(), "dd/MM/yyyy 'às' HH:mm")}
        </span>
      </div>
    </div>
  )
}

// ── Document Footer ───────────────────────────────────────────────────────────

function DocFooter({ emitente }: { emitente: Emitente }) {
  return (
    <div style={{
      marginTop: 40, paddingTop: 14,
      borderTop: `2px solid ${P.ink}`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 9, color: P.muted, letterSpacing: '.03em',
    }}>
      <span style={{ fontWeight: 600, color: P.slate }}>SuricathaIA · Desenvolvido por Vission — vission.com.br · (65) 4042-0466</span>
      <span>
        {emitente.nome_empresa && `${emitente.nome_empresa} · `}
        Documento gerado em {format(new Date(), "dd/MM/yyyy 'às' HH:mm")}
      </span>
    </div>
  )
}

// ── Separator ─────────────────────────────────────────────────────────────────

function Sep() {
  return <div style={{ height: 1, background: P.light, margin: '28px 0' }} />
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DOW_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

function heatColor(v: number, max: number): string {
  if (!v || !max) return '#f1f5f9'
  const t = Math.min(1, Math.sqrt(v / max))
  const from = [226, 232, 240]   // #e2e8f0
  const to   = [26,  58,  92]    // #1a3a5c
  const r = Math.round(from[0] + t * (to[0] - from[0]))
  const g = Math.round(from[1] + t * (to[1] - from[1]))
  const b = Math.round(from[2] + t * (to[2] - from[2]))
  return `rgb(${r},${g},${b})`
}

function textOnHeat(v: number, max: number): string {
  if (!v || !max) return P.muted
  return Math.sqrt(v / max) > 0.55 ? '#fff' : P.ink
}

interface HeatmapProps {
  data: HeatmapCell[]
  metricLabel: string
  accentLabel?: string
  accentColor?: string
}

function HeatmapChart({ data, metricLabel, accentLabel, accentColor = P.red }: HeatmapProps) {
  if (!data.length) return null

  // Build lookup: dia -> hora -> cell
  const lookup = new Map<string, Map<number, HeatmapCell>>()
  for (const c of data) {
    if (!lookup.has(c.dia)) lookup.set(c.dia, new Map())
    lookup.get(c.dia)!.set(c.hora, c)
  }

  const dias = [...lookup.keys()].sort()
  const maxVal = Math.max(...data.map(d => d.total), 1)

  // Hour totals (column sums)
  const hourTotals = HOURS.map(h => data.filter(d => d.hora === h).reduce((s, d) => s + d.total, 0))
  const maxHourTotal = Math.max(...hourTotals, 1)

  // Peak hour
  const peakHour = hourTotals.indexOf(Math.max(...hourTotals))
  // Peak day
  const dayTotals = dias.map(d => ({ dia: d, total: data.filter(c => c.dia === d).reduce((s, c) => s + c.total, 0) }))
  const peakDay   = dayTotals.reduce((best, d) => d.total > best.total ? d : best, dayTotals[0])
  // Quiet hour
  const nonZeroHours = hourTotals.filter(v => v > 0)
  const quietHour = nonZeroHours.length
    ? hourTotals.indexOf(Math.min(...nonZeroHours))
    : -1

  // Day-of-week aggregation
  const dowTotals = Array(7).fill(0) as number[]
  for (const d of data) {
    const dow = new Date(d.dia + 'T12:00:00').getDay()
    dowTotals[dow] += d.total
  }
  const maxDow = Math.max(...dowTotals, 1)

  const LABEL_W = 62
  const CELL_H  = Math.max(16, Math.min(28, Math.floor(340 / Math.max(dias.length, 1))))

  return (
    <div className="doc-section doc-chart" style={{ marginBottom: 28 }}>
      <SectionHead title="Mapa Temporal — Análise de Pico Horário" />

      {/* Insight badges */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        {[
          { label: 'Hora pico', value: `${String(peakHour).padStart(2,'0')}h – ${String(peakHour+1).padStart(2,'0')}h`, color: P.navy },
          { label: `${metricLabel} no pico`, value: fmtN(hourTotals[peakHour]), color: P.navy },
          quietHour >= 0 && { label: 'Menor movimento', value: `${String(quietHour).padStart(2,'0')}h`, color: P.muted },
          peakDay  && { label: 'Dia mais ativo', value: fmtDF(peakDay.dia), color: P.navy },
        ].filter(Boolean).map((b, i) => (
          <div key={i} style={{
            border: `1px solid ${P.light}`, borderRadius: 6,
            padding: '7px 14px', background: P.bg,
          }}>
            <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: P.muted, marginBottom: 3 }}>
              {(b as {label:string}).label}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: (b as {color:string}).color }}>
              {(b as {value:string}).value}
            </div>
          </div>
        ))}
      </div>

      {/* Grid */}
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 560 }}>

          {/* Hour axis labels */}
          <div style={{ display: 'flex', marginBottom: 3 }}>
            <div style={{ width: LABEL_W, flexShrink: 0 }} />
            {HOURS.map(h => (
              <div key={h} style={{
                flex: 1, textAlign: 'center',
                fontSize: 8, color: h === peakHour ? P.navy : P.muted,
                fontWeight: h === peakHour ? 700 : 400,
                letterSpacing: '-.02em',
              }}>
                {h % 3 === 0 ? `${String(h).padStart(2,'0')}h` : ''}
              </div>
            ))}
          </div>

          {/* Heatmap rows */}
          {dias.map(dia => {
            const row = lookup.get(dia)!
            const dayTotal = dayTotals.find(d => d.dia === dia)?.total ?? 0
            return (
              <div key={dia} style={{ display: 'flex', marginBottom: 2, alignItems: 'center' }}>
                {/* Day label */}
                <div style={{ width: LABEL_W, flexShrink: 0, paddingRight: 8, textAlign: 'right' }}>
                  <span style={{ fontSize: 9, color: dia === peakDay?.dia ? P.navy : P.slate, fontWeight: dia === peakDay?.dia ? 700 : 400, fontFamily: 'monospace' }}>
                    {fmtD(dia)}
                  </span>
                  <span style={{ fontSize: 8, color: P.muted, marginLeft: 3 }}>
                    {DOW_PT[new Date(dia + 'T12:00:00').getDay()]}
                  </span>
                </div>

                {/* Hour cells */}
                {HOURS.map(h => {
                  const cell = row.get(h)
                  const v = cell?.total ?? 0
                  const acc = cell?.accent ?? 0
                  const bg = heatColor(v, maxVal)
                  const fg = textOnHeat(v, maxVal)
                  return (
                    <div
                      key={h}
                      title={v ? `${fmtDF(dia)} ${String(h).padStart(2,'0')}h: ${v} ${metricLabel}${acc ? ` · ${acc} ${accentLabel}` : ''}` : undefined}
                      style={{
                        flex: 1, height: CELL_H,
                        background: bg,
                        borderRadius: 2,
                        marginRight: 1,
                        position: 'relative',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {/* Accent dot (watchlist/alerta) */}
                      {acc > 0 && (
                        <span style={{
                          position: 'absolute', top: 2, right: 2,
                          width: 4, height: 4, borderRadius: '50%',
                          background: accentColor, flexShrink: 0,
                        }} />
                      )}
                      {/* Value label — only shown when cell is big enough and has value */}
                      {v > 0 && CELL_H >= 22 && (
                        <span style={{ fontSize: 7, fontWeight: 600, color: fg, lineHeight: 1, userSelect: 'none' }}>
                          {v > 999 ? `${(v/1000).toFixed(1)}k` : v}
                        </span>
                      )}
                    </div>
                  )
                })}

                {/* Day total bar */}
                <div style={{ width: 36, paddingLeft: 5, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3 }}>
                  <div style={{
                    height: 6, background: P.navy, borderRadius: 2, opacity: .7,
                    width: `${Math.round((dayTotal / (Math.max(...dayTotals.map(d => d.total), 1))) * 28)}px`,
                  }} />
                </div>
              </div>
            )
          })}

          {/* Hour total sparkbar */}
          <div style={{ display: 'flex', marginTop: 4 }}>
            <div style={{ width: LABEL_W, flexShrink: 0, paddingRight: 8, textAlign: 'right' }}>
              <span style={{ fontSize: 8, color: P.muted }}>Total</span>
            </div>
            {HOURS.map(h => {
              const barH = Math.round((hourTotals[h] / maxHourTotal) * 28)
              return (
                <div key={h} style={{ flex: 1, marginRight: 1, height: 32, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                  <div style={{
                    width: '100%', height: barH,
                    background: h === peakHour ? P.navy : P.slate,
                    borderRadius: '2px 2px 0 0',
                    opacity: h === peakHour ? 1 : 0.45,
                  }} />
                </div>
              )
            })}
            <div style={{ width: 36 }} />
          </div>

          {/* Peak hour marker */}
          <div style={{ display: 'flex', marginTop: 2 }}>
            <div style={{ width: LABEL_W, flexShrink: 0 }} />
            {HOURS.map(h => (
              <div key={h} style={{ flex: 1, marginRight: 1, textAlign: 'center' }}>
                {h === peakHour && (
                  <span style={{ fontSize: 7, fontWeight: 700, color: P.navy }}>▲</span>
                )}
              </div>
            ))}
            <div style={{ width: 36 }} />
          </div>
        </div>
      </div>

      {/* Day-of-week profile */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${P.light}` }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: P.muted, marginBottom: 8 }}>
          Perfil por Dia da Semana
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {DOW_PT.map((label, dow) => (
            <div key={dow} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                background: heatColor(dowTotals[dow], maxDow),
                borderRadius: 4, padding: '8px 4px', marginBottom: 4,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: textOnHeat(dowTotals[dow], maxDow) }}>
                  {fmtN(dowTotals[dow])}
                </div>
              </div>
              <div style={{ fontSize: 9, color: P.muted, fontWeight: 600 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, justifyContent: 'flex-end' }}>
        <span style={{ fontSize: 9, color: P.muted }}>Menor</span>
        {[0.05, 0.2, 0.4, 0.65, 0.85, 1.0].map(t => (
          <div key={t} style={{
            width: 18, height: 10, borderRadius: 2,
            background: heatColor(Math.round(t * maxVal), maxVal),
            border: `1px solid ${P.light}`,
          }} />
        ))}
        <span style={{ fontSize: 9, color: P.muted }}>Maior</span>
        {accentLabel && (
          <>
            <div style={{ width: 1, height: 12, background: P.light, margin: '0 6px' }} />
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: accentColor, display: 'inline-block' }} />
            <span style={{ fontSize: 9, color: P.muted }}>{accentLabel}</span>
          </>
        )}
      </div>
    </div>
  )
}

// ── LPR Report ────────────────────────────────────────────────────────────────

function LprReport({ report }: { report: CustomReport }) {
  const lpr  = report.lpr || []
  const tl   = report.lpr_timeline || []
  const hm   = report.lpr_heatmap || []

  const total     = lpr.reduce((s, r) => s + (r.total as number || 0), 0)
  const comPlaca  = lpr.reduce((s, r) => s + (r.com_placa as number || 0), 0)
  const watchlist = lpr.reduce((s, r) => s + (r.watchlist as number || 0), 0)
  const diverg    = lpr.reduce((s, r) => s + (r.divergencias as number || 0), 0)
  const taxa      = total > 0 ? (comPlaca / total) * 100 : 0
  const confMedia = lpr.length > 0 ? lpr.reduce((s, r) => s + (r.confianca_media as number || 0), 0) / lpr.length : 0
  const dias      = tl.length

  return (
    <>
      {/* Executive summary */}
      <div style={{
        background: P.bg, borderLeft: `4px solid ${P.navy}`,
        borderRadius: '0 6px 6px 0', padding: '14px 18px', marginBottom: 28,
        fontSize: 13, color: P.slate, lineHeight: 1.7,
      }}>
        No período analisado foram registradas <strong style={{ color: P.ink }}>{fmtN(total)} leituras</strong>,
        com <strong style={{ color: P.ink }}>{fmtN(comPlaca)}</strong> placas identificadas
        (taxa de {fmtPct(taxa)}).
        {watchlist > 0 && <> Foram acionados <strong style={{ color: P.red }}>{fmtN(watchlist)} alertas de watchlist</strong>.</>}
        {confMedia > 0 && <> Confiança média de leitura: <strong style={{ color: P.ink }}>{fmtPct(confMedia)}</strong>.</>}
        {dias > 0 && <> Dados coletados ao longo de {dias} dia{dias > 1 ? 's' : ''}.</>}
      </div>

      {/* KPI strip */}
      <MetricStrip metrics={[
        { label: 'Total de Leituras',  value: fmtN(total),     sub: `${dias} dia${dias !== 1 ? 's' : ''} monitorados` },
        { label: 'Placas Identificadas', value: fmtN(comPlaca), sub: `Taxa ${fmtPct(taxa)}` },
        { label: 'Taxa de Leitura',    value: fmtPct(taxa),     accent: good(taxa >= 80), sub: taxa >= 80 ? 'Boa performance' : 'Abaixo do esperado' },
        { label: 'Confiança Média',    value: fmtPct(confMedia), accent: good(confMedia >= 80) },
        { label: 'Alertas Watchlist',  value: fmtN(watchlist),  accent: watchlist > 0 ? P.red : P.green, sub: watchlist > 0 ? 'Requer atenção' : 'Sem alertas' },
        { label: 'Divergências',       value: fmtN(diverg),     accent: diverg > 0 ? P.amber : undefined },
      ]} />

      {/* Evolution chart */}
      {tl.length > 0 && (
        <div className="doc-section doc-chart" style={{ marginBottom: 28 }}>
          <SectionHead title="Evolução Diária de Leituras" right={`${tl.length} dias`} />
          <ResponsiveContainer width="100%" height={200} minWidth={0}>
            <ComposedChart data={tl} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke={P.light} vertical={false} />
              <XAxis dataKey="dia" tickFormatter={fmtD}
                tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} width={36} />
              <Tooltip content={<ChartTip />} cursor={{ fill: `${P.navy}08` }} />
              <Bar dataKey="total"     name="Total"     fill={P.light}    radius={[2,2,0,0]} maxBarSize={32} />
              <Bar dataKey="com_placa" name="Com Placa" fill={P.navy}     radius={[2,2,0,0]} maxBarSize={22} />
              {watchlist > 0 && <Bar dataKey="watchlist" name="Watchlist" fill={P.red} radius={[2,2,0,0]} maxBarSize={12} />}
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 20, marginTop: 8, justifyContent: 'center' }}>
            {[
              { color: P.light, label: 'Volume total' },
              { color: P.navy,  label: 'Placas lidas' },
              ...(watchlist > 0 ? [{ color: P.red, label: 'Alertas' }] : []),
            ].map(l => (
              <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: P.muted }}>
                <span style={{ width: 10, height: 10, background: l.color, borderRadius: 2, display: 'inline-block' }} />
                {l.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Confidence trend */}
      {tl.length > 0 && (
        <div className="doc-section doc-chart" style={{ marginBottom: 28 }}>
          <SectionHead title="Tendência de Confiança de Leitura" />
          <ResponsiveContainer width="100%" height={140} minWidth={0}>
            <AreaChart data={tl} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="confGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={P.blue} stopOpacity={0.12} />
                  <stop offset="95%" stopColor={P.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke={P.light} vertical={false} />
              <XAxis dataKey="dia" tickFormatter={fmtD}
                tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`}
                tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} width={36} />
              <Tooltip content={<ChartTip />} cursor={{ stroke: P.blue, strokeWidth: 1 }} />
              <Area type="monotone" dataKey="confianca_media" name="Confiança %"
                stroke={P.blue} strokeWidth={2} fill="url(#confGrad)" dot={false}
                activeDot={{ r: 4, fill: P.blue }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Heatmap */}
      {hm.length > 0 && (
        <HeatmapChart
          data={hm}
          metricLabel="leituras"
          accentLabel="alertas watchlist"
          accentColor={P.red}
        />
      )}

      <Sep />

      {/* Per-camera table */}
      <div className="doc-section" style={{ marginBottom: 28 }}>
        <SectionHead title="Resultado por Câmera" right={`${lpr.length} câmera${lpr.length !== 1 ? 's' : ''}`} />
        <DataTable
          cols={[
            { key: 'nome',            label: 'Câmera' },
            { key: 'local',           label: 'Localização', render: v => <span style={{ color: P.slate }}>{v as string || '—'}</span> },
            { key: 'total',           label: 'Leituras',    align: 'right', render: v => <strong>{fmtN(v)}</strong> },
            { key: 'com_placa',       label: 'Com Placa',   align: 'right', render: v => fmtN(v) },
            { key: 'watchlist',       label: 'Watchlist',   align: 'right', render: v => <span style={{ color: (v as number) > 0 ? P.red : P.muted, fontWeight: (v as number) > 0 ? 700 : 400 }}>{fmtN(v)}</span> },
            { key: 'divergencias',    label: 'Diverg.',     align: 'right', render: v => <span style={{ color: (v as number) > 0 ? P.amber : P.muted }}>{fmtN(v)}</span> },
            { key: 'confianca_media', label: 'Confiança',   align: 'right', render: v => <span style={{ fontWeight: 700, color: good((v as number) >= 80) }}>{fmtPct(v)}</span> },
          ]}
          rows={lpr as Record<string, unknown>[]}
        />
      </div>

      {/* Daily history table */}
      {tl.length > 0 && (
        <div className="doc-section">
          <SectionHead title="Histórico Diário" right={`${tl.length} dias`} />
          <DataTable
            cols={[
              { key: 'dia',             label: 'Data',       render: v => <span style={{ fontFamily: 'monospace' }}>{fmtDF(v as string)}</span> },
              { key: 'total',           label: 'Leituras',   align: 'right', render: v => <strong>{fmtN(v)}</strong> },
              { key: 'com_placa',       label: 'Com Placa',  align: 'right', render: v => fmtN(v) },
              { key: 'watchlist',       label: 'Watchlist',  align: 'right', render: v => <span style={{ color: (v as number) > 0 ? P.red : P.muted }}>{fmtN(v)}</span> },
              { key: 'confianca_media', label: 'Confiança',  align: 'right', render: v => <span style={{ color: good((v as number) >= 80) }}>{fmtPct(v)}</span> },
            ]}
            rows={tl as unknown as Record<string, unknown>[]}
          />
        </div>
      )}
    </>
  )
}

// ── Pessoas Report ────────────────────────────────────────────────────────────

function PessoasReport({ report }: { report: CustomReport }) {
  const pes     = report.pessoas || []
  const tl      = report.pessoas_timeline || []
  const hm      = report.pessoas_heatmap || []
  const total   = pes.reduce((s, r) => s + (r.total_pessoas as number || 0), 0)
  const alertas = pes.reduce((s, r) => s + (r.alertas as number || 0), 0)
  const pico    = Math.max(0, ...pes.map(r => r.pico as number || 0))
  const dias    = tl.length

  return (
    <>
      <div style={{
        background: P.bg, borderLeft: `4px solid ${P.navy}`,
        borderRadius: '0 6px 6px 0', padding: '14px 18px', marginBottom: 28,
        fontSize: 13, color: P.slate, lineHeight: 1.7,
      }}>
        Foram contabilizadas <strong style={{ color: P.ink }}>{fmtN(total)} pessoas</strong> no período,
        com pico de <strong style={{ color: P.ink }}>{fmtN(pico)}</strong> pessoas simultâneas.
        {alertas > 0 && <> Registrados <strong style={{ color: P.amber }}>{fmtN(alertas)} alertas de lotação</strong>.</>}
        {dias > 0 && <> Cobertura de {dias} dia{dias !== 1 ? 's' : ''} de monitoramento.</>}
      </div>

      <MetricStrip metrics={[
        { label: 'Total de Pessoas',   value: fmtN(total),   sub: `${dias} dia${dias !== 1 ? 's' : ''} de coleta` },
        { label: 'Pico Simultâneo',    value: fmtN(pico),    sub: 'Maior fluxo registrado' },
        { label: 'Alertas de Lotação', value: fmtN(alertas), accent: alertas > 0 ? P.amber : P.green, sub: alertas > 0 ? 'Requer atenção' : 'Dentro do limite' },
        { label: 'Câmeras Ativas',     value: fmtN(pes.length) },
      ]} />

      {tl.length > 0 && (
        <div className="doc-section doc-chart" style={{ marginBottom: 28 }}>
          <SectionHead title="Fluxo Diário de Pessoas" />
          <ResponsiveContainer width="100%" height={200} minWidth={0}>
            <AreaChart data={tl} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pesGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={P.navy} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={P.navy} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke={P.light} vertical={false} />
              <XAxis dataKey="dia" tickFormatter={fmtD}
                tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} width={36} />
              <Tooltip content={<ChartTip />} cursor={{ stroke: P.navy, strokeWidth: 1 }} />
              <Area type="monotone" dataKey="total_pessoas" name="Pessoas"
                stroke={P.navy} strokeWidth={2} fill="url(#pesGrad)" dot={false} />
              {alertas > 0 && (
                <Area type="monotone" dataKey="alertas" name="Alertas"
                  stroke={P.amber} strokeWidth={1.5} fill={`${P.amber}10`} dot={false} strokeDasharray="4 3" />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Heatmap */}
      {hm.length > 0 && (
        <HeatmapChart
          data={hm}
          metricLabel="pessoas"
          accentLabel="alertas lotação"
          accentColor={P.amber}
        />
      )}

      <Sep />

      <div className="doc-section" style={{ marginBottom: 28 }}>
        <SectionHead title="Resultado por Câmera" right={`${pes.length} câmera${pes.length !== 1 ? 's' : ''}`} />
        <DataTable
          cols={[
            { key: 'nome',          label: 'Câmera' },
            { key: 'local',         label: 'Localização', render: v => <span style={{ color: P.slate }}>{v as string || '—'}</span> },
            { key: 'frames',        label: 'Frames',      align: 'right', render: v => fmtN(v) },
            { key: 'total_pessoas', label: 'Pessoas',     align: 'right', render: v => <strong>{fmtN(v)}</strong> },
            { key: 'pico',          label: 'Pico',        align: 'right', render: v => fmtN(v) },
            { key: 'alertas',       label: 'Alertas',     align: 'right', render: v => <span style={{ color: (v as number) > 0 ? P.amber : P.muted, fontWeight: (v as number) > 0 ? 700 : 400 }}>{fmtN(v)}</span> },
          ]}
          rows={pes as Record<string, unknown>[]}
        />
      </div>

      {tl.length > 0 && (
        <div className="doc-section">
          <SectionHead title="Histórico Diário" />
          <DataTable
            cols={[
              { key: 'dia',           label: 'Data',    render: v => <span style={{ fontFamily: 'monospace' }}>{fmtDF(v as string)}</span> },
              { key: 'total_pessoas', label: 'Pessoas', align: 'right', render: v => <strong>{fmtN(v)}</strong> },
              { key: 'pico',          label: 'Pico',    align: 'right', render: v => fmtN(v) },
              { key: 'alertas',       label: 'Alertas', align: 'right', render: v => <span style={{ color: (v as number) > 0 ? P.amber : P.muted }}>{fmtN(v)}</span> },
            ]}
            rows={tl as unknown as Record<string, unknown>[]}
          />
        </div>
      )}
    </>
  )
}

// ── EPI Report ────────────────────────────────────────────────────────────────

function EpiReport({ report }: { report: CustomReport }) {
  const epi       = report.epi || []
  const tl        = report.epi_timeline || []
  const hm        = report.epi_heatmap || []
  const total     = epi.reduce((s, r) => s + (r.eventos as number || 0), 0)
  const violacoes = epi.reduce((s, r) => s + (r.violacoes as number || 0), 0)
  const confMedia = epi.length > 0 ? epi.reduce((s, r) => s + (r.conformidade_media as number || 0), 0) / epi.length : 0
  const dias      = tl.length

  return (
    <>
      <div style={{
        background: P.bg, borderLeft: `4px solid ${P.navy}`,
        borderRadius: '0 6px 6px 0', padding: '14px 18px', marginBottom: 28,
        fontSize: 13, color: P.slate, lineHeight: 1.7,
      }}>
        Registrados <strong style={{ color: P.ink }}>{fmtN(total)} eventos EPI</strong> no período.
        {violacoes > 0
          ? <> Foram identificadas <strong style={{ color: P.red }}>{fmtN(violacoes)} violações</strong> de equipamento de proteção.</>
          : <> Nenhuma violação registrada.</>}
        {confMedia > 0 && <> Conformidade média: <strong style={{ color: good(confMedia >= 80) }}>{fmtPct(confMedia)}</strong>.</>}
        {dias > 0 && <> Monitoramento de {dias} dia{dias !== 1 ? 's' : ''}.</>}
      </div>

      <MetricStrip metrics={[
        { label: 'Total de Eventos',      value: fmtN(total),       sub: `${dias} dia${dias !== 1 ? 's' : ''} de coleta` },
        { label: 'Violações EPI',         value: fmtN(violacoes),   accent: violacoes > 0 ? P.red : P.green, sub: violacoes > 0 ? 'Requer ação imediata' : 'Conformidade total' },
        { label: 'Conformidade Média',    value: fmtPct(confMedia),  accent: good(confMedia >= 80), sub: confMedia >= 80 ? 'Dentro do padrão' : 'Abaixo do esperado' },
        { label: 'Câmeras EPI',           value: fmtN(epi.length) },
      ]} />

      {tl.length > 0 && (
        <div className="doc-section doc-chart" style={{ marginBottom: 28 }}>
          <SectionHead title="Conformidade EPI — Evolução Diária" />
          <ResponsiveContainer width="100%" height={200} minWidth={0}>
            <ComposedChart data={tl} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="confEpiGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={P.green} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={P.green} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke={P.light} vertical={false} />
              <XAxis dataKey="dia" tickFormatter={fmtD}
                tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} width={36} />
              <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tickFormatter={v => `${v}%`}
                tick={{ fontSize: 10, fill: P.muted }} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={<ChartTip />} cursor={{ fill: `${P.navy}08` }} />
              <Bar yAxisId="l" dataKey="eventos"   name="Eventos"   fill={P.light} radius={[2,2,0,0]} maxBarSize={28} />
              <Bar yAxisId="l" dataKey="violacoes" name="Violações" fill={P.red}   radius={[2,2,0,0]} maxBarSize={18} />
              <Line yAxisId="r" type="monotone" dataKey="conformidade_media" name="Conformidade %"
                stroke={P.green} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 20, marginTop: 8, justifyContent: 'center' }}>
            {[
              { color: P.light, label: 'Eventos' },
              { color: P.red,   label: 'Violações' },
              { color: P.green, label: 'Conformidade %', line: true },
            ].map(l => (
              <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: P.muted }}>
                <span style={{ width: l.line ? 14 : 10, height: l.line ? 2 : 10, background: l.color, borderRadius: 2, display: 'inline-block' }} />
                {l.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Heatmap */}
      {hm.length > 0 && (
        <HeatmapChart
          data={hm}
          metricLabel="eventos"
          accentLabel="violações"
          accentColor={P.red}
        />
      )}

      <Sep />

      <div className="doc-section" style={{ marginBottom: 28 }}>
        <SectionHead title="Resultado por Câmera" right={`${epi.length} câmera${epi.length !== 1 ? 's' : ''}`} />
        <DataTable
          cols={[
            { key: 'nome',               label: 'Câmera' },
            { key: 'local',              label: 'Localização',   render: v => <span style={{ color: P.slate }}>{v as string || '—'}</span> },
            { key: 'eventos',            label: 'Eventos',       align: 'right', render: v => <strong>{fmtN(v)}</strong> },
            { key: 'total_pessoas',      label: 'Pessoas',       align: 'right', render: v => fmtN(v) },
            { key: 'violacoes',          label: 'Violações',     align: 'right', render: v => <span style={{ color: (v as number) > 0 ? P.red : P.muted, fontWeight: (v as number) > 0 ? 700 : 400 }}>{fmtN(v)}</span> },
            { key: 'conformidade_media', label: 'Conformidade',  align: 'right', render: v => <span style={{ fontWeight: 700, color: good((v as number) >= 80) }}>{fmtPct(v)}</span> },
          ]}
          rows={epi as Record<string, unknown>[]}
        />
      </div>

      {tl.length > 0 && (
        <div className="doc-section">
          <SectionHead title="Histórico Diário" />
          <DataTable
            cols={[
              { key: 'dia',                label: 'Data',         render: v => <span style={{ fontFamily: 'monospace' }}>{fmtDF(v as string)}</span> },
              { key: 'eventos',            label: 'Eventos',      align: 'right', render: v => <strong>{fmtN(v)}</strong> },
              { key: 'violacoes',          label: 'Violações',    align: 'right', render: v => <span style={{ color: (v as number) > 0 ? P.red : P.muted }}>{fmtN(v)}</span> },
              { key: 'conformidade_media', label: 'Conformidade', align: 'right', render: v => <span style={{ color: good((v as number) >= 80) }}>{fmtPct(v)}</span> },
            ]}
            rows={tl as unknown as Record<string, unknown>[]}
          />
        </div>
      )}
    </>
  )
}

// ── Consolidated ──────────────────────────────────────────────────────────────

function GeralReport({ report }: { report: CustomReport }) {
  const hasLpr     = (report.lpr?.length ?? 0) > 0
  const hasPessoas = (report.pessoas?.length ?? 0) > 0
  const hasEpi     = (report.epi?.length ?? 0) > 0

  if (!hasLpr && !hasPessoas && !hasEpi) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0', color: P.muted, fontSize: 13 }}>
        Sem dados no período selecionado.
      </div>
    )
  }

  const modules = [
    hasLpr     && { label: 'Leitura LPR',        accent: P.navy,  children: <LprReport report={report} /> },
    hasPessoas && { label: 'Contagem de Pessoas', accent: P.amber, children: <PessoasReport report={report} /> },
    hasEpi     && { label: 'EPI / PPE',           accent: P.green, children: <EpiReport report={report} /> },
  ].filter(Boolean) as { label: string; accent: string; children: React.ReactNode }[]

  return (
    <>
      {modules.map((mod, i) => (
        <div key={mod.label}>
          {i > 0 && <div style={{ height: 2, background: P.ink, margin: '36px 0 32px' }} />}
          {/* Module header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24,
          }}>
            <div style={{ width: 6, height: 24, background: mod.accent, borderRadius: 3, flexShrink: 0 }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: P.ink, letterSpacing: '-.01em' }}>
              {mod.label}
            </span>
          </div>
          {mod.children}
        </div>
      ))}
    </>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Relatorios() {
  const nav     = useNavigate()
  const { can } = useAuth()
  useEffect(() => { if (!can.sistema.read) nav('/', { replace: true }) }, [])

  const printRef = useRef<HTMLDivElement>(null)

  const today = format(new Date(), 'yyyy-MM-dd')
  const week  = format(new Date(Date.now() - 6 * 864e5), 'yyyy-MM-dd')

  const [activeTab,   setActiveTab]  = useState('lpr')
  const [dataInicio,  setDataInicio] = useState(week)
  const [dataFim,     setDataFim]    = useState(today)
  const [cameraId,    setCameraId]   = useState<number | undefined>()
  const [cameras,     setCameras]    = useState<Camera[]>([])
  const [emitente,    setEmitente_]  = useState<Emitente>({})
  const [report,      setReport]     = useState<CustomReport | null>(null)
  const [loading,     setLoading]    = useState(false)
  const [exporting,   setExporting]  = useState(false)
  const [err,         setErr]        = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getEmitente(), getCameras()])
      .then(([e, c]) => { setEmitente_(e.data); setCameras(c.data.data || []) })
  }, [])

  const generate = async () => {
    setLoading(true); setErr(null); setReport(null)
    try {
      const r = await getCustomReport({ tipo: activeTab, data_inicio: dataInicio, data_fim: dataFim, camera_id: cameraId })
      setReport(r.data)
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Erro ao gerar relatório')
    } finally { setLoading(false) }
  }

  const handlePrint = () => window.print()

  const handlePDF = async () => {
    const el = printRef.current
    if (!el) return
    setExporting(true)
    try {
      const html2canvas = (await import('html2canvas')).default
      const { jsPDF }   = await import('jspdf')
      const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
      const imgData = canvas.toDataURL('image/png')
      const pdf  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const w    = pdf.internal.pageSize.getWidth()
      const h    = (canvas.height * w) / canvas.width
      const pageH = pdf.internal.pageSize.getHeight()
      let y = 0
      while (y < h) {
        if (y > 0) pdf.addPage()
        pdf.addImage(imgData, 'PNG', 0, -y, w, h)
        y += pageH
      }
      const label = TABS.find(t => t.value === activeTab)?.label || 'relatorio'
      pdf.save(`${label}_${dataInicio}_${dataFim}.pdf`)
    } catch {
      alert('Erro ao gerar PDF. Tente a impressão do navegador.')
    } finally { setExporting(false) }
  }

  const periodoLabel = `${fmtDF(dataInicio)} a ${fmtDF(dataFim)}`
  const titoLabel    = TABS.find(t => t.value === activeTab)?.label || activeTab

  return (
    <>
      <style>{PRINT_CSS}</style>

      <div className="page">

        {/* ── Page header ── */}
        <div className="no-print" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Relatórios</h1>
            <p style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 0' }}>
              Relatórios analíticos para gestores e diretoria
            </p>
          </div>

          {report && !loading && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={handlePDF} disabled={exporting}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                {exporting
                  ? <><span className="spinner" style={{ width: 12, height: 12 }} />Exportando…</>
                  : <><Ic d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" size={14} />Exportar PDF</>
                }
              </button>
              <button className="btn btn-primary" onClick={handlePrint}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <Ic d="M6 9V2h12v7 M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2 M6 14h12v8H6z" size={14} color="#fff" />
                Imprimir
              </button>
            </div>
          )}
        </div>

        {/* ── Filter panel ── */}
        <div className="no-print" style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '18px 20px', marginBottom: 24,
        }}>
          {/* Report type tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>
            {TABS.map(t => {
              const active = activeTab === t.value
              return (
                <button key={t.value} onClick={() => setActiveTab(t.value)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 7, border: active ? 'none' : '1px solid var(--border)',
                  cursor: 'pointer', fontWeight: active ? 600 : 400, fontSize: 13,
                  background: active ? 'var(--primary)' : 'transparent',
                  color: active ? '#fff' : 'var(--text2)', transition: 'all .15s',
                }}>
                  <Ic d={t.icon} size={13} color={active ? '#fff' : 'var(--text3)'} />
                  {t.label}
                </button>
              )
            })}
          </div>

          {/* Filters row */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6, fontWeight: 500 }}>Período rápido</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {PRESETS.map(p => (
                  <button key={p.label} onClick={() => {
                    const [s, e] = presetRange(p.days)
                    setDataInicio(s); setDataFim(e)
                  }} style={{
                    padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--surface2)', color: 'var(--text2)',
                    fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .12s',
                  }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)'; (e.currentTarget as HTMLElement).style.color = 'var(--primary)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--text2)' }}
                  >{p.label}</button>
                ))}
              </div>
            </div>

            <div style={{ width: 1, height: 32, background: 'var(--border)', alignSelf: 'flex-end' }} />

            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6, fontWeight: 500 }}>De</div>
              <input className="form-input" type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)}
                style={{ fontSize: 13, padding: '6px 10px' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6, fontWeight: 500 }}>Até</div>
              <input className="form-input" type="date" value={dataFim} onChange={e => setDataFim(e.target.value)}
                style={{ fontSize: 13, padding: '6px 10px' }} />
            </div>

            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6, fontWeight: 500 }}>Câmera</div>
              <select className="form-input" value={cameraId ?? ''} onChange={e => setCameraId(e.target.value ? +e.target.value : undefined)}
                style={{ minWidth: 160, fontSize: 13, padding: '6px 10px' }}>
                <option value="">Todas as câmeras</option>
                {cameras.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </div>

            <div style={{ flex: 1 }} />

            <button className="btn btn-primary" onClick={generate} disabled={loading}
              style={{ padding: '8px 22px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 }}>
              {loading
                ? <><span className="spinner" style={{ width: 13, height: 13 }} />Gerando…</>
                : <><Ic d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6" size={14} color="#fff" />Gerar Relatório</>
              }
            </button>
          </div>

          {/* Company strip */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
            {emitente.logo_url
              ? <img src={emitente.logo_url} alt="" style={{ height: 18, objectFit: 'contain' }}
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
              : <div style={{ width: 18, height: 18, borderRadius: 4, background: 'var(--surface3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Ic d="M2 7h20M2 7a2 2 0 00-2 2v10a2 2 0 002 2h20a2 2 0 002-2V9a2 2 0 00-2-2M2 7V5a2 2 0 012-2h6" size={10} color="var(--text3)" />
                </div>
            }
            {emitente.nome_empresa
              ? <><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{emitente.nome_empresa}</span>
                  {emitente.cnpj && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {emitente.cnpj}</span>}
                  {emitente.cidade_uf && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {emitente.cidade_uf}</span>}
                </>
              : <span style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Empresa não configurada — configure em Sistema</span>
            }
            <button className="btn btn-ghost" onClick={() => nav('/sistema')}
              style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Ic d="M12 20h9 M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" size={11} />
              Editar empresa
            </button>
          </div>
        </div>

        {/* ── States ── */}
        {err && (
          <div style={{
            background: 'rgba(220,38,38,.06)', border: '1px solid rgba(220,38,38,.2)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#dc2626',
          }}>
            <Ic d="M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" size={15} color="#dc2626" />
            {err}
          </div>
        )}

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '72px 0', gap: 12 }}>
            <span className="spinner" style={{ width: 20, height: 20 }} />
            <span style={{ color: 'var(--text2)', fontSize: 14 }}>Compilando dados do relatório…</span>
          </div>
        )}

        {!report && !loading && !err && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', padding: '72px 0', gap: 16, color: 'var(--text3)',
          }}>
            <div style={{
              width: 64, height: 64, borderRadius: 16,
              background: 'var(--surface)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Ic d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" size={26} color="var(--text3)" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }}>Configure e gere seu relatório</div>
              <div style={{ fontSize: 13 }}>Selecione o módulo, defina o período e clique em <strong style={{ color: 'var(--text2)' }}>Gerar Relatório</strong></div>
            </div>
          </div>
        )}

        {/* ── Report document (always white for print) ── */}
        {report && !loading && (
          <div
            id="relatorio-doc"
            ref={printRef}
            style={{
              background: P.paper,
              color: P.ink,
              borderRadius: 12,
              padding: '40px 48px',
              boxShadow: '0 1px 3px rgba(0,0,0,.06), 0 8px 32px rgba(0,0,0,.06)',
              border: `1px solid ${P.light}`,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <DocHeader emitente={emitente} titulo={titoLabel} periodo={periodoLabel} />

            {activeTab === 'lpr'     && <LprReport     report={report} />}
            {activeTab === 'pessoas' && <PessoasReport report={report} />}
            {activeTab === 'epi'     && <EpiReport     report={report} />}
            {activeTab === 'geral'   && <GeralReport   report={report} />}

            <DocFooter emitente={emitente} />
          </div>
        )}

      </div>
    </>
  )
}
