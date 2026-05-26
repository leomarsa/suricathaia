import { useEffect, useState, useCallback } from 'react'
import { format } from 'date-fns'
import {
  getAnalyticsResumo, getPessoasTimeline, getEPITimeline, getLprTimeline,
  getPessoasStats, getEPIStats, getDeteccaoStats,
  type AnalyticsResumo, type LprTimelineRow, type EpiTimelineRow,
} from '../api'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

type Periodo = '24h' | '7d' | '30d'
type Tab     = 'geral' | 'lpr' | 'pessoas' | 'epi'

interface PessoasTimelineRow {
  ts: string; frames: number; frames_total: number
  pico: number; media: number; total: number; alertas: number
}
interface PessoasDiaRow {
  dia: string; frames: number; total_pessoas: number; pico: number; media: number; alertas: number
}
interface EpiDiaRow {
  dia: string; frames: number; total_pessoas: number
  total_sem_capacete: number; total_sem_colete: number
  violacoes: number; conformidade_media: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(ts: string, periodo: string) {
  const d = new Date(ts)
  return periodo === '30d' ? format(d, 'dd/MM') : format(d, 'HH:mm')
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return '—'
  return n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n/1_000).toFixed(1)}k`
    : String(n)
}

const PILL: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 10, fontWeight: 700, padding: '2px 7px',
  borderRadius: 20, letterSpacing: '.03em',
}

// ── Micro components ──────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, accent = 'var(--primary)', icon,
}: {
  label: string; value: string | number; sub?: string
  accent?: string; icon?: string
}) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '14px 18px', flex: 1, minWidth: 120,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: accent }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {label}
        </div>
        {icon && <span style={{ fontSize: 16, opacity: .5 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: 26, fontWeight: 750, color: accent, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function PillarDot({ active, label, color }: { active: boolean; label: string; color: string }) {
  return (
    <span style={{
      ...PILL,
      background: active ? `${color}18` : 'var(--surface2)',
      color: active ? color : 'var(--text3)',
      border: `1px solid ${active ? `${color}30` : 'var(--border)'}`,
    }}>{label}</span>
  )
}

function ConfBar({ pct }: { pct: number }) {
  const color = pct >= 90 ? '#22c55e' : pct >= 70 ? '#f59e0b' : '#ef4444'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--surface2)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .4s' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 34, textAlign: 'right' }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  )
}

// ── Period selector ───────────────────────────────────────────────────────────

const PERIODOS: { v: Periodo; label: string }[] = [
  { v: '24h', label: '24h' },
  { v: '7d',  label: '7 dias' },
  { v: '30d', label: '30 dias' },
]

function PeriodSelector({ value, onChange }: { value: Periodo; onChange: (p: Periodo) => void }) {
  return (
    <div style={{ display: 'flex', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
      {PERIODOS.map(p => (
        <button key={p.v} onClick={() => onChange(p.v)} style={{
          padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
          background: value === p.v ? 'var(--primary)' : 'transparent',
          color: value === p.v ? '#fff' : 'var(--text2)',
          transition: 'all .15s',
        }}>{p.label}</button>
      ))}
    </div>
  )
}

// ── Camera summary card ───────────────────────────────────────────────────────

function CameraCard({ r }: { r: AnalyticsResumo }) {
  const hasAlert = r.lpr_alertas_24h > 0 || r.epi_violacoes_24h > 0
  return (
    <div style={{
      background: 'var(--surface)', border: `1px solid ${hasAlert ? 'rgba(239,68,68,.35)' : 'var(--border)'}`,
      borderRadius: 12, padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{r.camera_nome}</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 1 }}>{r.camera_local}</div>
        </div>
        {hasAlert && (
          <span style={{ ...PILL, background: 'rgba(239,68,68,.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)' }}>
            ⚠ Alerta
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
        <PillarDot active={r.rec_lpr}              label="LPR"     color="#6366f1" />
        <PillarDot active={r.rec_contagem_pessoas}  label="Pessoas" color="#06b6d4" />
        <PillarDot active={r.rec_epi}              label="EPI"     color="#f59e0b" />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {r.rec_lpr && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>LPR 24h</span>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{fmtNum(r.lpr_deteccoes_24h)}</span>
              {r.lpr_alertas_24h > 0 && (
                <span style={{ ...PILL, background: 'rgba(239,68,68,.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,.2)' }}>
                  {r.lpr_alertas_24h} ⚠
                </span>
              )}
            </div>
          </div>
        )}
        {r.rec_contagem_pessoas && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>Pessoas 24h</span>
            <span style={{ fontWeight: 700, fontSize: 13 }}>
              {fmtNum(r.pessoas_total_24h)}
              <span style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 400, marginLeft: 4 }}>
                pico {r.pessoas_pico_24h}
              </span>
            </span>
          </div>
        )}
        {r.rec_epi && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>Conformidade EPI</span>
              {r.epi_violacoes_24h > 0 && (
                <span style={{ ...PILL, background: 'rgba(239,68,68,.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,.2)', fontSize: 9 }}>
                  {r.epi_violacoes_24h} violação{r.epi_violacoes_24h > 1 ? 'ões' : ''}
                </span>
              )}
            </div>
            <ConfBar pct={r.epi_conformidade_media} />
          </div>
        )}
      </div>
    </div>
  )
}

// ── LPR Tab ───────────────────────────────────────────────────────────────────

function LprTab({ periodo }: { periodo: Periodo }) {
  const [rows, setRows]   = useState<LprTimelineRow[]>([])
  const [pico, setPico]   = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getLprTimeline({ periodo })
      .then(r => { setRows(r.data.data); setPico(r.data.pico_leituras) })
      .finally(() => setLoading(false))
  }, [periodo])

  const totalPlacas  = rows.reduce((s, r) => s + r.com_placa, 0)
  const totalLeit    = rows.reduce((s, r) => s + r.total, 0)
  const totalWl      = rows.reduce((s, r) => s + r.watchlist, 0)
  const confMedia    = rows.filter(r => r.confianca_media > 0).length > 0
    ? (rows.filter(r => r.confianca_media > 0).reduce((s, r) => s + r.confianca_media, 0) /
       rows.filter(r => r.confianca_media > 0).length).toFixed(1)
    : '—'

  const Tip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d: LprTimelineRow = payload[0]?.payload
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, boxShadow: '0 4px 20px #0003' }}>
        <div style={{ fontWeight: 600, marginBottom: 5, color: 'var(--text)' }}>{fmtTs(d.ts, periodo)}</div>
        <div style={{ color: 'var(--text2)' }}>Volume: <b style={{ color: 'var(--text)' }}>{d.total.toLocaleString()}</b></div>
        <div style={{ color: '#6366f1' }}>Placas: <b>{d.com_placa}</b></div>
        {d.watchlist > 0 && <div style={{ color: '#ef4444' }}>⚠ Watchlist: <b>{d.watchlist}</b></div>}
        <div style={{ color: 'var(--text3)', marginTop: 3 }}>Conf.: <b>{d.confianca_media.toFixed(1)}%</b></div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Mini KPIs */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <KpiCard label="Leituras totais"  value={fmtNum(totalLeit)}    accent="#6366f1" icon="📷" />
        <KpiCard label="Placas lidas"     value={fmtNum(totalPlacas)}  accent="#6366f1" icon="🚗" sub={`de ${fmtNum(totalLeit)} leituras`} />
        <KpiCard label="Alertas watchlist" value={totalWl}  accent={totalWl > 0 ? '#ef4444' : '#6366f1'} icon="⚠" />
        <KpiCard label="Conf. média"       value={confMedia !== '—' ? `${confMedia}%` : '—'} accent="#a78bfa" icon="✓" />
        {pico > 0 && <KpiCard label="Pico placas/h" value={pico} accent="#6366f1" icon="📈" />}
      </div>

      {/* Chart */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: 'var(--text)' }}>
          Leituras por período
        </div>
        {loading ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>
        ) : rows.length === 0 ? (
          <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>Sem dados no período</div>
        ) : (
          <ResponsiveContainer width="100%" minWidth={0} height={220}>
            <ComposedChart data={rows} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="ts" tickFormatter={v => fmtTs(v, periodo)} tick={{ fontSize: 10, fill: 'var(--text2)' }} interval="preserveStartEnd" />
              <YAxis yAxisId="left" tick={{ fontSize: 10, fill: 'var(--text2)' }} allowDecimals={false} width={32} />
              <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text2)' }} tickFormatter={v => `${v}%`} width={36} />
              <Tooltip content={<Tip />} />
              <Bar yAxisId="left" dataKey="total" maxBarSize={28} radius={[2, 2, 0, 0]}>
                {rows.map((r, i) => <Cell key={i} fill={r.total > 0 ? 'rgba(99,102,241,.14)' : 'rgba(99,102,241,.06)'} />)}
              </Bar>
              <Bar yAxisId="left" dataKey="com_placa" maxBarSize={16} radius={[4, 4, 0, 0]}>
                {rows.map((r, i) => <Cell key={i} fill={r.watchlist > 0 ? '#ef4444' : r.com_placa > 0 ? '#6366f1' : 'rgba(99,102,241,.2)'} />)}
              </Bar>
              <Line yAxisId="right" dataKey="confianca_media" type="monotone" stroke="#a78bfa" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
              {pico > 0 && <ReferenceLine yAxisId="left" y={pico} stroke="rgba(99,102,241,.3)" strokeDasharray="4 4" />}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(99,102,241,.14)', borderRadius: 2, marginRight: 4 }} />Volume</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#6366f1', borderRadius: 2, marginRight: 4 }} />Placas</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#ef4444', borderRadius: 2, marginRight: 4 }} />Watchlist</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 3, background: '#a78bfa', borderRadius: 1, marginRight: 4, verticalAlign: 'middle' }} />Confiança %</span>
        </div>
      </div>
    </div>
  )
}

// ── Pessoas Tab ───────────────────────────────────────────────────────────────

function PessoasTab({ periodo }: { periodo: Periodo }) {
  const [tlRows, setTlRows]   = useState<PessoasTimelineRow[]>([])
  const [statsRows, setStats] = useState<PessoasDiaRow[]>([])
  const [picoGlobal, setPico] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const dias = periodo === '24h' ? 1 : periodo === '7d' ? 7 : 30
    Promise.all([
      getPessoasTimeline({ periodo }),
      getPessoasStats({ dias }),
    ]).then(([tl, st]) => {
      setTlRows(tl.data.data); setPico(tl.data.pico_global)
      setStats(st.data.por_dia)
    }).finally(() => setLoading(false))
  }, [periodo])

  const totalPessoas = tlRows.reduce((s, r) => s + r.total, 0)
  const totalAlertas = tlRows.reduce((s, r) => s + r.alertas, 0)
  const picoH        = Math.max(...tlRows.map(r => r.pico), 0)

  const Tip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d: PessoasTimelineRow = payload[0]?.payload
    const cob = d.frames_total > 0 ? ((d.frames / d.frames_total) * 100).toFixed(0) : '0'
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, boxShadow: '0 4px 20px #0003' }}>
        <div style={{ fontWeight: 600, marginBottom: 5, color: 'var(--text)' }}>{fmtTs(d.ts, periodo)}</div>
        <div style={{ color: '#06b6d4' }}>Pico: <b>{d.pico}</b></div>
        <div style={{ color: 'var(--text2)' }}>Total acumulado: <b>{d.total}</b></div>
        <div style={{ color: 'var(--text2)' }}>Média/frame: <b>{Number(d.media).toFixed(1)}</b></div>
        <div style={{ color: 'var(--text3)', marginTop: 3 }}>Cobertura: <b>{cob}%</b> ({d.frames}/{d.frames_total})</div>
        {d.alertas > 0 && <div style={{ color: '#f59e0b' }}>⚠ Alertas: <b>{d.alertas}</b></div>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <KpiCard label="Total pessoas"   value={fmtNum(totalPessoas)} accent="#06b6d4" icon="👥" />
        <KpiCard label="Pico período"    value={picoH}                accent="#06b6d4" icon="📈" sub="pessoas simultâneas" />
        <KpiCard label="Alertas lotação" value={totalAlertas}         accent={totalAlertas > 0 ? '#f59e0b' : '#06b6d4'} icon="⚠" />
        <KpiCard label="Pico global/h"   value={picoGlobal}           accent="#06b6d4" icon="🔝" />
      </div>

      {/* Timeline */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: 'var(--text)' }}>Fluxo de pessoas por período</div>
        {loading ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>
        ) : tlRows.length === 0 ? (
          <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>Sem dados no período</div>
        ) : (
          <ResponsiveContainer width="100%" minWidth={0} height={210}>
            <ComposedChart data={tlRows} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="ts" tickFormatter={v => fmtTs(v, periodo)} tick={{ fontSize: 10, fill: 'var(--text2)' }} interval="preserveStartEnd" />
              <YAxis yAxisId="left" tick={{ fontSize: 10, fill: 'var(--text2)' }} allowDecimals={false} width={32} />
              <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text2)' }} tickFormatter={v => `${v}%`} width={36} />
              <Tooltip content={<Tip />} />
              <Bar yAxisId="left" dataKey="pico" maxBarSize={28} radius={[4, 4, 0, 0]}>
                {tlRows.map((r, i) => <Cell key={i} fill={r.alertas > 0 ? 'rgba(245,158,11,.8)' : r.pico > 0 ? '#06b6d4' : 'rgba(6,182,212,.2)'} />)}
              </Bar>
              <Line yAxisId="right" type="monotone"
                dataKey={r => r.frames_total > 0 ? +((r.frames / r.frames_total) * 100).toFixed(1) : 0}
                name="Cobertura %" stroke="#a78bfa" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
              {picoGlobal > 0 && <ReferenceLine yAxisId="left" y={picoGlobal} stroke="rgba(6,182,212,.3)" strokeDasharray="4 4" />}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#06b6d4', borderRadius: 2, marginRight: 4 }} />Pico pessoas</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(245,158,11,.8)', borderRadius: 2, marginRight: 4 }} />Com alerta</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 3, background: '#a78bfa', borderRadius: 1, marginRight: 4, verticalAlign: 'middle' }} />Cobertura %</span>
        </div>
      </div>

      {/* Stats table */}
      {statsRows.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            Resumo por dia
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dia</th>
                  <th style={{ textAlign: 'right' }}>Scans</th>
                  <th style={{ textAlign: 'right' }}>Total pess.</th>
                  <th style={{ textAlign: 'right' }}>Pico</th>
                  <th style={{ textAlign: 'right' }}>Média</th>
                  <th style={{ textAlign: 'right' }}>Alertas</th>
                </tr>
              </thead>
              <tbody>
                {statsRows.map(r => (
                  <tr key={r.dia}>
                    <td className="font-mono" style={{ fontSize: 12 }}>{r.dia}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>{r.frames.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.total_pessoas.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', color: '#06b6d4', fontWeight: 600 }}>{r.pico}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>{Number(r.media).toFixed(1)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {r.alertas > 0
                        ? <span style={{ color: '#f59e0b', fontWeight: 700 }}>{r.alertas}</span>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── EPI Tab ───────────────────────────────────────────────────────────────────

function EpiTab({ periodo }: { periodo: Periodo }) {
  const [tlRows, setTlRows]   = useState<EpiTimelineRow[]>([])
  const [statsRows, setStats] = useState<EpiDiaRow[]>([])
  const [picoViol, setPico]   = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const dias = periodo === '24h' ? 1 : periodo === '7d' ? 7 : 30
    Promise.all([
      getEPITimeline({ periodo }),
      getEPIStats({ dias }),
    ]).then(([tl, st]) => {
      setTlRows(tl.data.data); setPico(tl.data.pico_violacoes)
      setStats(st.data.por_dia)
    }).finally(() => setLoading(false))
  }, [periodo])

  const totalViol   = tlRows.reduce((s, r) => s + r.violacoes, 0)
  const totalConf   = tlRows.reduce((s, r) => s + r.conformes, 0)
  const totalFrames = tlRows.reduce((s, r) => s + r.total_frames, 0)
  const confMedia   = tlRows.filter(r => r.total_frames > 0).length > 0
    ? (tlRows.reduce((s, r) => s + r.conformidade_media, 0) / tlRows.filter(r => r.total_frames > 0).length).toFixed(1)
    : '100'

  const Tip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d: EpiTimelineRow = payload[0]?.payload
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, boxShadow: '0 4px 20px #0003' }}>
        <div style={{ fontWeight: 600, marginBottom: 5, color: 'var(--text)' }}>{fmtTs(d.ts, periodo)}</div>
        <div style={{ color: '#22c55e' }}>✓ Conformes: <b>{d.conformes}</b></div>
        <div style={{ color: '#ef4444' }}>✗ Violações: <b>{d.violacoes}</b></div>
        {d.sem_capacete > 0 && <div style={{ color: 'var(--text2)' }}>🪖 Sem capacete: <b>{d.sem_capacete}</b></div>}
        <div style={{ color: 'var(--text3)', marginTop: 3 }}>Conformidade: <b>{Number(d.conformidade_media).toFixed(1)}%</b></div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <KpiCard label="Scans totais"    value={fmtNum(totalFrames)} accent="#f59e0b" icon="📷" />
        <KpiCard label="Conformes"        value={fmtNum(totalConf)}  accent="#22c55e" icon="✓" />
        <KpiCard label="Violações"        value={fmtNum(totalViol)}  accent={totalViol > 0 ? '#ef4444' : '#22c55e'} icon="✗" />
        <KpiCard label="Conf. média"      value={`${confMedia}%`}    accent={parseFloat(confMedia) >= 90 ? '#22c55e' : parseFloat(confMedia) >= 70 ? '#f59e0b' : '#ef4444'} icon="🦺" />
        {picoViol > 0 && <KpiCard label="Pico violações/h" value={picoViol} accent="#ef4444" icon="🔝" />}
      </div>

      {/* Timeline */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: 'var(--text)' }}>Conformidade EPI por período</div>
        {loading ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>
        ) : tlRows.length === 0 ? (
          <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>Sem dados no período</div>
        ) : (
          <ResponsiveContainer width="100%" minWidth={0} height={210}>
            <ComposedChart data={tlRows} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="ts" tickFormatter={v => fmtTs(v, periodo)} tick={{ fontSize: 10, fill: 'var(--text2)' }} interval="preserveStartEnd" />
              <YAxis yAxisId="left" tick={{ fontSize: 10, fill: 'var(--text2)' }} allowDecimals={false} width={32} />
              <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text2)' }} tickFormatter={v => `${v}%`} width={36} />
              <Tooltip content={<Tip />} />
              <Bar yAxisId="left" dataKey="conformes" stackId="a" maxBarSize={28}>
                {tlRows.map((_, i) => <Cell key={i} fill="rgba(34,197,94,.7)" />)}
              </Bar>
              <Bar yAxisId="left" dataKey="violacoes" stackId="a" maxBarSize={28} radius={[4, 4, 0, 0]}>
                {tlRows.map((r, i) => <Cell key={i} fill={r.violacoes > 0 ? 'rgba(239,68,68,.85)' : 'rgba(239,68,68,.15)'} />)}
              </Bar>
              <Line yAxisId="right" dataKey="conformidade_media" type="monotone" stroke="#a78bfa" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
              {picoViol > 0 && <ReferenceLine yAxisId="left" y={picoViol} stroke="rgba(239,68,68,.3)" strokeDasharray="4 4" />}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(34,197,94,.7)', borderRadius: 2, marginRight: 4 }} />Conformes</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(239,68,68,.85)', borderRadius: 2, marginRight: 4 }} />Violações</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 3, background: '#a78bfa', borderRadius: 1, marginRight: 4, verticalAlign: 'middle' }} />Conformidade %</span>
        </div>
      </div>

      {/* Stats table */}
      {statsRows.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            Resumo por dia
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dia</th>
                  <th style={{ textAlign: 'right' }}>Scans</th>
                  <th style={{ textAlign: 'right' }}>Pessoas</th>
                  <th style={{ textAlign: 'right' }}>Sem capacete</th>
                  <th style={{ textAlign: 'right' }}>Sem colete</th>
                  <th style={{ textAlign: 'right' }}>Violações</th>
                  <th style={{ textAlign: 'right', minWidth: 130 }}>Conformidade</th>
                </tr>
              </thead>
              <tbody>
                {statsRows.map(r => (
                  <tr key={r.dia} style={{ background: r.violacoes > 0 ? 'rgba(239,68,68,.03)' : undefined }}>
                    <td className="font-mono" style={{ fontSize: 12 }}>{r.dia}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>{r.frames.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.total_pessoas.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', color: r.total_sem_capacete > 0 ? '#ef4444' : 'var(--text3)', fontWeight: r.total_sem_capacete > 0 ? 700 : 400 }}>
                      {r.total_sem_capacete > 0 ? r.total_sem_capacete : '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: r.total_sem_colete > 0 ? '#f59e0b' : 'var(--text3)', fontWeight: r.total_sem_colete > 0 ? 700 : 400 }}>
                      {r.total_sem_colete > 0 ? r.total_sem_colete : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {r.violacoes > 0
                        ? <span style={{ color: '#ef4444', fontWeight: 700 }}>{r.violacoes}</span>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <ConfBar pct={r.conformidade_media} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Geral Tab ─────────────────────────────────────────────────────────────────

function GeralTab({ resumo }: { resumo: AnalyticsResumo[] }) {
  if (resumo.length === 0)
    return (
      <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text3)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
        <div style={{ fontSize: 14 }}>Nenhuma câmera com analytics ativo nas últimas 24h</div>
      </div>
    )

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Câmera / Local</th>
              <th style={{ textAlign: 'center' }}>Pilares</th>
              <th style={{ textAlign: 'right' }}>LPR 24h</th>
              <th style={{ textAlign: 'right' }}>Alertas WL</th>
              <th style={{ textAlign: 'right' }}>Pessoas 24h</th>
              <th style={{ textAlign: 'right' }}>Pico</th>
              <th style={{ textAlign: 'right' }}>Violações EPI</th>
              <th style={{ minWidth: 120 }}>Conformidade EPI</th>
            </tr>
          </thead>
          <tbody>
            {resumo.map(r => {
              const hasAlert = r.lpr_alertas_24h > 0 || r.epi_violacoes_24h > 0
              return (
                <tr key={r.camera_id} style={{ background: hasAlert ? 'rgba(239,68,68,.03)' : undefined }}>
                  <td>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{r.camera_nome}</div>
                    <div style={{ fontSize: 11, color: 'var(--text2)' }}>{r.camera_local}</div>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: 3, justifyContent: 'center', flexWrap: 'wrap' }}>
                      {r.rec_lpr && <span style={{ ...PILL, background: 'rgba(99,102,241,.12)', color: '#6366f1', border: '1px solid rgba(99,102,241,.2)' }}>LPR</span>}
                      {r.rec_contagem_pessoas && <span style={{ ...PILL, background: 'rgba(6,182,212,.12)', color: '#06b6d4', border: '1px solid rgba(6,182,212,.2)' }}>PSS</span>}
                      {r.rec_epi && <span style={{ ...PILL, background: 'rgba(245,158,11,.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.2)' }}>EPI</span>}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>
                    {r.rec_lpr ? fmtNum(r.lpr_deteccoes_24h) : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {r.rec_lpr
                      ? r.lpr_alertas_24h > 0
                        ? <span style={{ color: '#ef4444', fontWeight: 700 }}>⚠ {r.lpr_alertas_24h}</span>
                        : <span style={{ color: 'var(--text3)' }}>0</span>
                      : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>
                    {r.rec_contagem_pessoas ? fmtNum(r.pessoas_total_24h) : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', color: '#06b6d4', fontWeight: 600 }}>
                    {r.rec_contagem_pessoas ? r.pessoas_pico_24h : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {r.rec_epi
                      ? r.epi_violacoes_24h > 0
                        ? <span style={{ color: '#ef4444', fontWeight: 700 }}>{r.epi_violacoes_24h}</span>
                        : <span style={{ color: 'var(--text3)' }}>0</span>
                      : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ minWidth: 120 }}>
                    {r.rec_epi
                      ? <ConfBar pct={r.epi_conformidade_media} />
                      : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Analytics() {
  const [tab, setTab]         = useState<Tab>('geral')
  const [periodo, setPeriodo] = useState<Periodo>('24h')
  const [resumo, setResumo]   = useState<AnalyticsResumo[]>([])
  const [lprStats, setLprStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(new Date())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, ls] = await Promise.all([
        getAnalyticsResumo(),
        getDeteccaoStats(),
      ])
      setResumo(r.data)
      setLprStats(ls.data)
      setLastRefresh(new Date())
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // Global KPIs from resumo
  const totalLpr     = resumo.reduce((s, r) => s + r.lpr_deteccoes_24h, 0)
  const totalPessoas = resumo.reduce((s, r) => s + r.pessoas_total_24h, 0)
  const picoGlobal   = Math.max(...resumo.map(r => r.pessoas_pico_24h), 0)
  const epiConf      = resumo.filter(r => r.rec_epi).length > 0
    ? (resumo.filter(r => r.rec_epi).reduce((s, r) => s + r.epi_conformidade_media, 0) /
       resumo.filter(r => r.rec_epi).length)
    : 100
  const totalAlertas = resumo.reduce((s, r) => s + r.lpr_alertas_24h + r.epi_violacoes_24h, 0)
  const camsAtivas   = resumo.filter(r => r.rec_lpr || r.rec_contagem_pessoas || r.rec_epi).length

  const TABS: { v: Tab; label: string; color: string }[] = [
    { v: 'geral',   label: 'Visão Geral',  color: 'var(--primary)' },
    { v: 'lpr',     label: 'LPR',          color: '#6366f1' },
    { v: 'pessoas', label: 'Pessoas',       color: '#06b6d4' },
    { v: 'epi',     label: 'EPI / PPE',    color: '#f59e0b' },
  ]

  return (
    <div className="page">

      {/* Header */}
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <div className="page-title">Analytics</div>
          <div className="page-subtitle">
            {camsAtivas} câmera{camsAtivas !== 1 ? 's' : ''} ativas · atualizado {format(lastRefresh, 'HH:mm:ss')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <PeriodSelector value={periodo} onChange={setPeriodo} />
          <button className="btn btn-ghost" onClick={load} disabled={loading}>
            {loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : '↻'}
          </button>
        </div>
      </div>

      {/* Top KPI strip */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <KpiCard label="Câmeras ativas"   value={camsAtivas}                icon="📷" />
        <KpiCard label="LPR 24h"          value={fmtNum(totalLpr)}          icon="🚗"  accent="#6366f1" />
        <KpiCard label="Pessoas 24h"      value={fmtNum(totalPessoas)}      icon="👥"  accent="#06b6d4" sub={`pico ${picoGlobal}`} />
        <KpiCard label="Conf. EPI média"  value={`${epiConf.toFixed(1)}%`} icon="🦺"  accent={epiConf >= 90 ? '#22c55e' : epiConf >= 70 ? '#f59e0b' : '#ef4444'} />
        <KpiCard label="Alertas 24h"      value={totalAlertas}              icon="⚠"   accent={totalAlertas > 0 ? '#ef4444' : 'var(--primary)'} />
        {lprStats && <KpiCard label="LPR tempo médio" value={lprStats.tempo_medio_ms ? `${lprStats.tempo_medio_ms}ms` : '—'} icon="⏱" accent="var(--primary)" />}
      </div>

      {/* Camera cards */}
      {!loading && resumo.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginBottom: 20 }}>
          {resumo.map(r => <CameraCard key={r.camera_id} r={r} />)}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
        {TABS.map(t => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            style={{
              padding: '10px 20px', fontWeight: tab === t.v ? 700 : 400, fontSize: 13,
              cursor: 'pointer', background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === t.v ? t.color : 'transparent'}`,
              color: tab === t.v ? t.color : 'var(--text2)',
              marginBottom: -1, transition: 'color .15s, border-color .15s',
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <div className="spinner" />
        </div>
      ) : (
        <>
          {tab === 'geral'   && <GeralTab   resumo={resumo} />}
          {tab === 'lpr'     && <LprTab     periodo={periodo} />}
          {tab === 'pessoas' && <PessoasTab periodo={periodo} />}
          {tab === 'epi'     && <EpiTab     periodo={periodo} />}
        </>
      )}
    </div>
  )
}
