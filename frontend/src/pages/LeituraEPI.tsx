import { useEffect, useRef, useState } from 'react'
import {
  getEventosEPI, getEPITimeline, getCameras,
  type EventoEPI, type EpiTimelineRow, type Camera,
} from '../api'
import { useModuleAlerts } from '../hooks/useModuleAlerts'
import ModuleAlertBanner from '../components/ModuleAlertBanner'
import { format } from 'date-fns'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'

const LIMIT = 24

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtTs(ts: string, periodo: string) {
  const d = new Date(ts)
  if (periodo === '30d') return format(d, 'dd/MM')
  return format(d, 'HH:mm')
}

// ── sub-components ────────────────────────────────────────────────────────────

function KpiCard({ label, value, color = 'var(--text)', sub }: {
  label: string; value: string | number; color?: string; sub?: string
}) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 16px', flex: 1, minWidth: 110,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function EpiMiniBar({ com, sem, label }: { com: number; sem: number; label: string }) {
  const total = com + sem
  if (total === 0) return <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
  const pct = (com / total) * 100
  return (
    <div style={{ minWidth: 100 }}>
      <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', background: 'var(--surface2)' }}>
        <div style={{ width: `${pct}%`, background: 'var(--success)' }} />
        <div style={{ width: `${100 - pct}%`, background: 'var(--danger)' }} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>{com}✓ {sem}✗</div>
    </div>
  )
}

function ConformBadge({ ok, pct }: { ok: boolean; pct: number }) {
  return ok
    ? <span className="badge badge-green">✓ {pct.toFixed(0)}%</span>
    : <span className="badge badge-red">✗ {pct.toFixed(0)}%</span>
}

// ── Snapshot card ─────────────────────────────────────────────────────────────

function EpiCard({ ev, onClick }: { ev: EventoEPI; onClick: () => void }) {
  const [imgErr, setImgErr] = useState(false)
  const hasSnap = !!ev.snapshot_url && !imgErr

  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${!ev.conformidade ? 'rgba(239,68,68,.45)' : 'var(--border)'}`,
        borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
        transition: 'box-shadow .15s',
        boxShadow: !ev.conformidade ? '0 0 0 0 rgba(239,68,68,.3)' : 'none',
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--primary)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = !ev.conformidade ? '0 0 8px rgba(239,68,68,.2)' : 'none')}
    >
      <div style={{ position: 'relative', background: '#0d0d0d', height: 140 }}>
        {hasSnap ? (
          <img
            src={ev.snapshot_url!} alt="snapshot"
            onError={() => setImgErr(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, color: 'var(--text3)' }}>
            🦺
          </div>
        )}
        {/* Badge conformidade */}
        <div style={{
          position: 'absolute', top: 6, right: 6,
          background: ev.conformidade ? 'rgba(16,185,129,.9)' : 'rgba(220,38,38,.9)',
          color: '#fff', fontWeight: 700, fontSize: 11, borderRadius: 6, padding: '2px 8px',
        }}>
          {ev.conformidade ? `✓ ${ev.percentual_conformidade.toFixed(0)}%` : `✗ ${ev.percentual_conformidade.toFixed(0)}%`}
        </div>
        {/* Badge pessoas */}
        {ev.total_pessoas > 0 && (
          <div style={{
            position: 'absolute', bottom: 6, left: 6,
            background: 'rgba(0,0,0,.75)', color: '#fff', fontSize: 11, borderRadius: 6, padding: '2px 6px',
          }}>
            👷 {ev.total_pessoas}
          </div>
        )}
      </div>

      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)', marginBottom: 2, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {ev.camera_nome}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 6 }}>
          {format(new Date(ev.detectado_em), 'dd/MM/yy HH:mm:ss')}
        </div>

        {/* Barras EPI */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(ev.com_capacete + ev.sem_capacete) > 0 && (
            <EpiMiniBar com={ev.com_capacete} sem={ev.sem_capacete} label="🪖 Capacete" />
          )}
          {(ev.com_colete + ev.sem_colete) > 0 && (
            <EpiMiniBar com={ev.com_colete} sem={ev.sem_colete} label="🦺 Colete" />
          )}
        </div>

        {/* Alertas separados por tipo */}
        {(ev.sem_capacete > 0 || ev.sem_colete > 0) && (
          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {ev.sem_capacete > 0 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                background: 'rgba(239,68,68,.15)', border: '1px solid rgba(239,68,68,.4)',
                color: '#ef4444',
              }}>
                🪖 {ev.sem_capacete} sem capacete
              </span>
            )}
            {ev.sem_colete > 0 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                background: 'rgba(245,158,11,.13)', border: '1px solid rgba(245,158,11,.4)',
                color: '#f59e0b',
              }}>
                🦺 {ev.sem_colete} sem colete
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Snapshot modal ────────────────────────────────────────────────────────────

function EpiStatusBar({ com, sem, icon, label, color }: {
  com: number; sem: number; icon: string; label: string; color: string
}) {
  const total = com + sem
  if (total === 0) return null
  const pct = Math.round((com / total) * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 16, width: 22, textAlign: 'center' }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
          <span style={{ fontSize: 11, color: 'var(--text2)' }}>
            <b style={{ color: 'var(--success)' }}>{com}</b> com · <b style={{ color: com < total ? color : 'var(--text2)' }}>{sem}</b> sem
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--surface2)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--success)' : color, transition: 'width .3s' }} />
        </div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: pct === 100 ? 'var(--success)' : color, minWidth: 36, textAlign: 'right' }}>
        {pct}%
      </span>
    </div>
  )
}

function SnapModal({ ev, onClose }: { ev: EventoEPI; onClose: () => void }) {
  const totalEpi = ev.com_capacete + ev.sem_capacete + ev.com_colete + ev.sem_colete
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.88)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--surface)', borderRadius: 14, overflow: 'hidden',
          maxWidth: 1100, width: '97vw', maxHeight: '94vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface2)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{ev.camera_nome}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2, display: 'flex', gap: 12 }}>
              <span>📅 {format(new Date(ev.detectado_em), 'dd/MM/yyyy HH:mm:ss')}</span>
              <span>👷 {ev.total_pessoas} pessoa{ev.total_pessoas !== 1 ? 's' : ''} detectada{ev.total_pessoas !== 1 ? 's' : ''}</span>
              {ev.camera_local && <span>📍 {ev.camera_local}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              padding: '4px 12px', borderRadius: 8, fontWeight: 700, fontSize: 13,
              background: ev.conformidade ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)',
              color: ev.conformidade ? 'var(--success)' : 'var(--danger)',
              border: `1px solid ${ev.conformidade ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
            }}>
              {ev.conformidade ? '✓ Conforme' : '✗ Violação'} · {ev.percentual_conformidade.toFixed(0)}%
            </span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              style={{ fontSize: 18, lineHeight: 1, padding: '4px 8px' }}
            >✕</button>
          </div>
        </div>

        {/* Conteúdo */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {/* Snapshot */}
          <div style={{ flex: 1, background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {ev.snapshot_url
              ? <img src={ev.snapshot_url} alt="snapshot EPI" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              : (
                <div style={{ textAlign: 'center', color: 'var(--text3)' }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>🦺</div>
                  <div style={{ fontSize: 13 }}>Snapshot não disponível</div>
                </div>
              )
            }
          </div>

          {/* Painel lateral */}
          <div style={{ width: 270, flexShrink: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>

            {/* Seção EPI */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 12 }}>
                Equipamentos de Proteção
              </div>
              {totalEpi > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <EpiStatusBar icon="🪖" label="Capacete de Segurança"
                    com={ev.com_capacete} sem={ev.sem_capacete} color="var(--danger)" />
                  <EpiStatusBar icon="🦺" label="Colete de Alta Visibilidade"
                    com={ev.com_colete} sem={ev.sem_colete} color="var(--warning)" />
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Nenhuma pessoa detectada</div>
              )}
            </div>

            {/* Seção Conformidade */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 12 }}>
                Resultado da Análise
              </div>
              <div style={{
                padding: '12px 14px', borderRadius: 10,
                background: ev.conformidade ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
                border: `1px solid ${ev.conformidade ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.3)'}`,
              }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: ev.conformidade ? 'var(--success)' : 'var(--danger)', marginBottom: 8 }}>
                  {ev.conformidade ? '✓ Conformidade Total' : '✗ Violação Detectada'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--text2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Conformidade</span>
                    <b style={{ color: ev.conformidade ? 'var(--success)' : 'var(--danger)' }}>
                      {ev.percentual_conformidade.toFixed(0)}%
                    </b>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Pessoas detectadas</span>
                    <b style={{ color: 'var(--text)' }}>{ev.total_pessoas}</b>
                  </div>
                  {ev.sem_capacete > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#ef4444' }}>🪖 Sem capacete</span>
                      <b style={{ color: '#ef4444' }}>{ev.sem_capacete}</b>
                    </div>
                  )}
                  {ev.sem_colete > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#f59e0b' }}>🦺 Sem colete</span>
                      <b style={{ color: '#f59e0b' }}>{ev.sem_colete}</b>
                    </div>
                  )}
                  {ev.com_capacete > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text3)' }}>🪖 Com capacete</span>
                      <b style={{ color: 'var(--success)' }}>{ev.com_capacete}</b>
                    </div>
                  )}
                  {ev.com_colete > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text3)' }}>🦺 Com colete</span>
                      <b style={{ color: 'var(--success)' }}>{ev.com_colete}</b>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Rodapé */}
            <div style={{ padding: '12px 18px', marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {ev.tempo_processo_ms && (
                <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Tempo de análise</span>
                  <span>{ev.tempo_processo_ms}ms</span>
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between' }}>
                <span>Evento</span>
                <span className="font-mono">#{ev.id}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Timeline chart ────────────────────────────────────────────────────────────

const PERIODOS = ['6h', '24h', '7d', '30d'] as const

function TimelineChart({ cameraId }: { cameraId?: number }) {
  const [periodo, setPeriodo] = useState<string>('24h')
  const [rows, setRows]       = useState<EpiTimelineRow[]>([])
  const [pico, setPico]       = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const params: Record<string, unknown> = { periodo }
    if (cameraId) params.camera_id = cameraId
    getEPITimeline(params)
      .then(r => { setRows(r.data.data); setPico(r.data.pico_violacoes) })
      .finally(() => setLoading(false))
  }, [periodo, cameraId])

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const d: EpiTimelineRow = payload[0]?.payload
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>{label}</div>
        <div style={{ color: 'var(--danger)' }}>✗ Violações: <b>{d.violacoes}</b></div>
        <div style={{ color: 'var(--success)' }}>✓ Conformes: <b>{d.conformes}</b></div>
        {d.sem_capacete > 0 && <div style={{ color: 'var(--warning)' }}>🪖 Sem capacete: <b>{d.sem_capacete}</b></div>}
        {d.sem_colete > 0 && <div style={{ color: 'var(--warning)' }}>🦺 Sem colete: <b>{d.sem_colete}</b></div>}
        <div style={{ color: 'var(--text2)', marginTop: 4 }}>Conformidade: <b>{Number(d.conformidade_media).toFixed(1)}%</b></div>
        <div style={{ color: 'var(--text3)' }}>Scans: {d.total_frames}</div>
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Fluxo Temporal — Alertas EPI</span>
        {PERIODOS.map(p => (
          <button
            key={p}
            className={`btn btn-ghost btn-sm${periodo === p ? ' btn-active' : ''}`}
            style={periodo === p ? { background: 'var(--primary)', color: '#fff' } : {}}
            onClick={() => setPeriodo(p)}
          >{p}</button>
        ))}
      </div>
      {loading ? (
        <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner" />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>
          Sem dados para o período
        </div>
      ) : (
        <ResponsiveContainer width="100%" minWidth={0} height={220}>
          <ComposedChart data={rows} margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="ts"
              tickFormatter={v => fmtTs(v, periodo)}
              tick={{ fontSize: 10, fill: 'var(--text2)' }}
              interval="preserveStartEnd"
            />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: 'var(--text2)' }} allowDecimals={false} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 100]}
              tick={{ fontSize: 10, fill: 'var(--text2)' }} tickFormatter={v => `${v}%`} />
            <Tooltip content={<CustomTooltip />} />
            {pico > 0 && (
              <ReferenceLine yAxisId="left" y={pico} stroke="rgba(239,68,68,.4)" strokeDasharray="4 4" />
            )}
            <Bar yAxisId="left" dataKey="conformes" name="Conformes" stackId="a" radius={[0, 0, 0, 0]} maxBarSize={28}>
              {rows.map((_, i) => <Cell key={i} fill="rgba(16,185,129,.7)" />)}
            </Bar>
            <Bar yAxisId="left" dataKey="violacoes" name="Violações" stackId="a" radius={[4, 4, 0, 0]} maxBarSize={28}>
              {rows.map((r, i) => <Cell key={i} fill={r.violacoes > 0 ? 'rgba(239,68,68,.85)' : 'rgba(239,68,68,.2)'} />)}
            </Bar>
            <Line
              yAxisId="right"
              dataKey="conformidade_media"
              name="Conformidade %"
              type="monotone"
              stroke="#a78bfa"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(16,185,129,.7)', borderRadius: 2, marginRight: 4 }} />Conformes</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(239,68,68,.85)', borderRadius: 2, marginRight: 4 }} />Violações</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 3, background: '#a78bfa', borderRadius: 1, marginRight: 4, verticalAlign: 'middle' }} />Conformidade %</span>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LeituraEPI() {
  const [data, setData]         = useState<EventoEPI[]>([])
  const [total, setTotal]       = useState(0)
  const [cameras, setCameras]   = useState<Camera[]>([])
  const [loading, setLoading]   = useState(true)
  const [offset, setOffset]     = useState(0)
  const [modal, setModal]       = useState<EventoEPI | null>(null)
  const [view, setView]         = useState<'grid' | 'table'>('grid')
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const [filters, setFilters]   = useState({
    camera_id: '', apenas_violacoes: '', apenas_deteccoes: 'true',
    data_inicio: '', data_fim: '',
  })
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { alert: moduleAlert, prefs, toggleSound, toggleVisual, dismiss } = useModuleAlerts({
    moduleKey: 'epi',
    eventTypes: ['epi_violacao'],
    buildMessage: (e) => {
      const parts: string[] = []
      if (e.sem_capacete) parts.push(`${e.sem_capacete} sem capacete`)
      if (e.sem_colete)   parts.push(`${e.sem_colete} sem colete`)
      return `Violação EPI: ${parts.join(', ') || 'não conformidade detectada'}`
    },
    sirenDuration: 6,
  })

  const load = async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = { limit: LIMIT, offset }
      if (filters.camera_id)        params.camera_id        = +filters.camera_id
      if (filters.apenas_violacoes === 'true') params.apenas_violacoes = true
      if (filters.apenas_deteccoes === 'true') params.apenas_deteccoes = true
      if (filters.data_inicio)      params.data_inicio      = filters.data_inicio
      if (filters.data_fim)         params.data_fim         = filters.data_fim
      const r = await getEventosEPI(params)
      setData(r.data.data)
      setTotal(r.data.total)
      setLastRefresh(new Date())
    } finally { setLoading(false) }
  }

  useEffect(() => {
    getCameras().then(r => setCameras(r.data.data.filter(c => c.rec_epi && c.ativa)))
  }, [])

  useEffect(() => { load() }, [offset, filters])

  useEffect(() => {
    timerRef.current = setInterval(load, 30_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [offset, filters])

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters(f => ({ ...f, [k]: v }))
    setOffset(0)
  }

  const violacoes     = data.filter(r => !r.conformidade).length
  const conformMedia  = data.filter(r => r.total_pessoas > 0).length > 0
    ? (data.filter(r => r.total_pessoas > 0).reduce((s, r) => s + r.percentual_conformidade, 0) /
       data.filter(r => r.total_pessoas > 0).length).toFixed(1)
    : '—'
  const semCapacete   = data.reduce((s, r) => s + r.sem_capacete, 0)
  const semColete     = data.reduce((s, r) => s + r.sem_colete, 0)
  const comSnapshot   = data.filter(r => r.snapshot_url).length

  const pages = Math.ceil(total / LIMIT)
  const page  = Math.floor(offset / LIMIT)
  const camId = filters.camera_id ? +filters.camera_id : undefined

  return (
    <div className="page">
      {modal && <SnapModal ev={modal} onClose={() => setModal(null)} />}

      <div className="page-header">
        <div>
          <div className="page-title">Leitura EPI / PPE</div>
          <div className="page-subtitle">
            {total.toLocaleString()} registro(s) · atualizado {format(lastRefresh, 'HH:mm:ss')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-ghost btn-sm"
            style={view === 'grid' ? { background: 'var(--surface2)' } : {}}
            onClick={() => setView('grid')} title="Grade">⊞</button>
          <button
            className="btn btn-ghost btn-sm"
            style={view === 'table' ? { background: 'var(--surface2)' } : {}}
            onClick={() => setView('table')} title="Tabela">☰</button>
          <button className="btn btn-ghost" onClick={load} disabled={loading}>
            {loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : '↻ Atualizar'}
          </button>
        </div>
      </div>

      {/* ── Alert Banner ── */}
      <div style={{ marginBottom: 14 }}>
        <ModuleAlertBanner
          alert={moduleAlert}
          soundEnabled={prefs.sound}
          visualEnabled={prefs.visual}
          onToggleSound={toggleSound}
          onToggleVisual={toggleVisual}
          onDismiss={dismiss}
          accentColor="#ef4444"
        />
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <KpiCard label="Total registros" value={total.toLocaleString()} />
        <KpiCard
          label="Conformidade média"
          value={conformMedia !== '—' ? `${conformMedia}%` : '—'}
          color={parseFloat(conformMedia as string) >= 80 ? 'var(--success)' : 'var(--danger)'}
        />
        <KpiCard label="Violações (pág)" value={violacoes}
          color={violacoes > 0 ? 'var(--danger)' : 'var(--text)'} />
        <KpiCard label="Sem capacete (pág)" value={semCapacete}
          color={semCapacete > 0 ? 'var(--warning)' : 'var(--text)'} />
        <KpiCard label="Sem colete (pág)" value={semColete}
          color={semColete > 0 ? 'var(--warning)' : 'var(--text)'} />
        <KpiCard label="Com snapshot" value={comSnapshot}
          sub={`de ${data.length} nesta pág`} />
      </div>

      {/* Timeline */}
      <TimelineChart cameraId={camId} />

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0, minWidth: 180 }}>
            <label className="form-label">Câmera</label>
            <select className="form-input" value={filters.camera_id}
              onChange={e => setFilter('camera_id', e.target.value)}>
              <option value="">Todas as câmeras</option>
              {cameras.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0, minWidth: 150 }}>
            <label className="form-label">Conformidade</label>
            <select className="form-input" value={filters.apenas_violacoes}
              onChange={e => setFilter('apenas_violacoes', e.target.value)}>
              <option value="">Todos</option>
              <option value="true">✗ Apenas violações</option>
            </select>
          </div>
          <div className="form-group" style={{ margin: 0, minWidth: 160 }}>
            <label className="form-label">Detecções</label>
            <select className="form-input" value={filters.apenas_deteccoes}
              onChange={e => setFilter('apenas_deteccoes', e.target.value)}>
              <option value="true">Com pessoas detectadas</option>
              <option value="">Todos os registros</option>
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">De</label>
            <input className="form-input" type="date" value={filters.data_inicio}
              onChange={e => setFilter('data_inicio', e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Até</label>
            <input className="form-input" type="date" value={filters.data_fim}
              onChange={e => setFilter('data_fim', e.target.value)} />
          </div>
          {(filters.camera_id || filters.apenas_violacoes || filters.data_inicio || filters.data_fim || filters.apenas_deteccoes !== 'true') && (
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-end' }}
              onClick={() => { setFilters({ camera_id: '', apenas_violacoes: '', apenas_deteccoes: 'true', data_inicio: '', data_fim: '' }); setOffset(0) }}>
              ✕ Limpar
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {loading && data.length === 0 ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : data.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">🦺</div>
            <div>Nenhum evento EPI encontrado</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
              Os dados aparecerão quando câmeras com análise EPI enviarem imagens para /epi
            </div>
          </div>
        </div>
      ) : view === 'grid' ? (
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {data.map(ev => <EpiCard key={ev.id} ev={ev} onClick={() => setModal(ev)} />)}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>#</th>
                  <th>Câmera</th>
                  <th style={{ width: 80 }}>Pessoas</th>
                  <th style={{ width: 130 }}>Capacete</th>
                  <th style={{ width: 130 }}>Colete</th>
                  <th style={{ width: 120 }}>Conformidade</th>
                  <th style={{ width: 70 }}>Snapshot</th>
                  <th style={{ width: 140 }}>Detectado em</th>
                </tr>
              </thead>
              <tbody>
                {data.map(r => (
                  <tr key={r.id}
                    style={{ background: !r.conformidade ? 'rgba(239,68,68,.05)' : undefined, cursor: r.snapshot_url ? 'pointer' : undefined }}
                    onClick={() => r.snapshot_url && setModal(r)}
                  >
                    <td className="font-mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{r.id}</td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{r.camera_nome}</div>
                      <div style={{ fontSize: 11, color: 'var(--text2)' }}>{r.camera_local}</div>
                    </td>
                    <td style={{ fontWeight: 700, color: r.total_pessoas > 0 ? 'var(--primary)' : 'var(--text3)' }}>
                      {r.total_pessoas}
                    </td>
                    <td><EpiMiniBar label="" com={r.com_capacete} sem={r.sem_capacete} /></td>
                    <td><EpiMiniBar label="" com={r.com_colete} sem={r.sem_colete} /></td>
                    <td><ConformBadge ok={r.conformidade} pct={r.percentual_conformidade} /></td>
                    <td style={{ textAlign: 'center' }}>
                      {r.snapshot_url
                        ? <span style={{ color: 'var(--success)', fontSize: 14 }} title="Ver snapshot">📷</span>
                        : <span style={{ color: 'var(--text3)' }}>—</span>
                      }
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                      {format(new Date(r.detectado_em), 'dd/MM/yy HH:mm:ss')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' }}>
          <button className="btn btn-ghost btn-sm" disabled={page === 0}
            onClick={() => setOffset(o => o - LIMIT)}>← Anterior</button>
          <span style={{ fontSize: 12, color: 'var(--text2)', padding: '0 8px' }}>
            Página {page + 1} de {pages} · {total.toLocaleString()} registros
          </span>
          <button className="btn btn-ghost btn-sm" disabled={page >= pages - 1}
            onClick={() => setOffset(o => o + LIMIT)}>Próximo →</button>
        </div>
      )}
    </div>
  )
}
