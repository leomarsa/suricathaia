import { useEffect, useRef, useState, useCallback } from 'react'
import { getContagensPessoas, getCameras, updateSchedulePessoas, getPessoasTimeline, type ContagemPessoa, type Camera } from '../api'
import { useModuleAlerts } from '../hooks/useModuleAlerts'
import ModuleAlertBanner from '../components/ModuleAlertBanner'
import { format } from 'date-fns'
import {
  ComposedChart, Bar, Line, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, LabelList,
} from 'recharts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(ts: string) {
  try {
    const d = new Date(ts), diff = Math.floor((Date.now() - d.getTime()) / 1000)
    if (diff < 60) return `${diff}s atrás`
    if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return '' }
}



// ── Shared lightbox ───────────────────────────────────────────────────────────

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(12px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
    }}>
      <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '88vh' }} onClick={e => e.stopPropagation()}>
        <img src={url} alt="snapshot"
          style={{ maxWidth: '100%', maxHeight: '88vh', borderRadius: 4, boxShadow: '0 32px 80px rgba(0,0,0,.8)', display: 'block' }} />
        <button onClick={onClose} style={{
          position: 'absolute', top: -10, right: -10, width: 26, height: 26, borderRadius: '50%',
          background: 'var(--surface1)', border: '1px solid var(--border)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function SnapshotThumb({ url, size = 40, noZoom }: { url: string; size?: number; noZoom?: boolean }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState(false)
  if (err) return null
  return (
    <>
      <div onClick={noZoom ? undefined : () => setOpen(true)} title={noZoom ? undefined : 'Ver snapshot'} style={{
        width: size, height: size, borderRadius: 3, flexShrink: 0,
        overflow: 'hidden', cursor: noZoom ? 'inherit' : 'pointer', position: 'relative',
        background: 'var(--surface2)', border: '1px solid var(--border)',
      }}>
        {!loaded && !err && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--primary)', animation: 'spin .7s linear infinite' }} />
          </div>
        )}
        <img src={url} alt="snapshot" onLoad={() => setLoaded(true)} onError={() => setErr(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: loaded ? 'block' : 'none' }} />
      </div>
      {open && <Lightbox url={url} onClose={() => setOpen(false)} />}
    </>
  )
}

// ── Event Detail Modal ────────────────────────────────────────────────────────

const AC = '#f59e0b'

function EventDetailModal({ ev, onClose }: { ev: ContagemPessoa; onClose: () => void }) {
  const [lbOpen, setLbOpen] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgErr, setImgErr] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const conf = ev.confianca_media != null ? (ev.confianca_media * 100).toFixed(0) + '%' : '—'
  const confColor = ev.confianca_media != null
    ? ev.confianca_media > 0.7 ? '#22c55e' : ev.confianca_media > 0.5 ? AC : '#ef4444'
    : 'var(--text2)'

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 500,
      background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderTop: `2px solid ${AC}`, borderRadius: 4,
        width: '100%', maxWidth: 720,
        boxShadow: '0 32px 80px rgba(0,0,0,.6)',
        display: 'flex', flexDirection: 'column',
        maxHeight: '90vh', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {ev.alerta_lotacao && (
              <span style={{
                fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase',
                padding: '2px 7px', borderRadius: 3,
                background: `${AC}22`, border: `1px solid ${AC}55`, color: AC,
              }}>⚠ Lotação</span>
            )}
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{ev.camera_nome}</span>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)',
            display: 'flex', padding: 4,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Snapshot panel */}
          <div style={{
            width: 320, flexShrink: 0,
            background: '#050505', position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {ev.snapshot_url && !imgErr ? (
              <>
                {!imgLoaded && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid #ffffff18', borderTopColor: '#ffffff66', animation: 'spin .7s linear infinite' }} />
                  </div>
                )}
                <img
                  src={ev.snapshot_url}
                  alt="snapshot"
                  onLoad={() => setImgLoaded(true)}
                  onError={() => setImgErr(true)}
                  onClick={() => imgLoaded && setLbOpen(true)}
                  style={{
                    width: '100%', display: imgLoaded ? 'block' : 'none',
                    objectFit: 'cover', cursor: 'zoom-in',
                  }}
                />
                {imgLoaded && (
                  <div style={{ position: 'absolute', bottom: 8, right: 8 }}>
                    <button onClick={() => setLbOpen(true)} style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 8px', borderRadius: 3,
                      background: 'rgba(0,0,0,.7)', border: '1px solid rgba(255,255,255,.12)',
                      color: '#fff', fontSize: 10, cursor: 'pointer',
                    }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                      </svg>
                      Ampliar
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: '#ffffff22', padding: 40 }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                </svg>
                <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>Sem snapshot</span>
              </div>
            )}
          </div>

          {/* Details panel */}
          <div style={{ flex: 1, padding: '20px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[
              { label: 'Câmera',          val: ev.camera_nome },
              { label: 'Total detectado', val: `${ev.total_pessoas} pessoa${ev.total_pessoas !== 1 ? 's' : ''}`, color: ev.alerta_lotacao ? AC : undefined },
              { label: 'Confiança',       val: conf, color: confColor },
              { label: 'Horário',         val: fmtTime(ev.detectado_em), mono: true },
              { label: 'Há quanto tempo', val: fmtTs(ev.detectado_em) },
              { label: 'Alerta lotação',  val: ev.alerta_lotacao ? 'Sim' : 'Não', color: ev.alerta_lotacao ? AC : '#22c55e' },
            ].map((r, i, arr) => (
              <div key={r.label} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '11px 0',
                borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 500 }}>{r.label}</span>
                <span style={{
                  fontSize: 12, fontWeight: 700, color: r.color ?? 'var(--text)',
                  fontFamily: r.mono ? 'JetBrains Mono, monospace' : 'inherit',
                }}>{r.val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {lbOpen && ev.snapshot_url && <Lightbox url={ev.snapshot_url} onClose={() => setLbOpen(false)} />}
    </div>
  )
}

// ── Event Card (grid) — same structure as AlarmeCCTV ─────────────────────────

function SnapImgCard({ url, onError }: { url: string; onError: () => void }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, cursor: 'inherit' }}>
        {!loaded && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid #ffffff22', borderTopColor: '#ffffff88', animation: 'spin .7s linear infinite' }} />
          </div>
        )}
        <img src={url} alt="snapshot" onLoad={() => setLoaded(true)} onError={onError}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: loaded ? 'block' : 'none' }} />
        {loaded && (
          <div style={{ position: 'absolute', inset: 0, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background .15s' }} className="card-hover-overlay">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0, transition: 'opacity .15s' }} className="card-zoom-icon">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </div>
        )}
      </div>
    </>
  )
}

function EventCard({ ev, isNewest, onSelect }: { ev: ContagemPessoa; isNewest: boolean; onSelect: (ev: ContagemPessoa) => void }) {
  const [imgErr, setImgErr] = useState(false)
  const isAlert = ev.alerta_lotacao

  return (
    <div onClick={() => onSelect(ev)} style={{
      borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
      border: `1px solid ${isAlert ? '#f59e0b55' : isNewest ? '#6366f155' : 'var(--border)'}`,
      background: isAlert ? '#f59e0b0a' : isNewest ? '#6366f10a' : 'var(--surface2)',
      transition: 'border-color .15s, box-shadow .15s',
    }} className="ev-card">

      {/* 16:9 image */}
      <div style={{ position: 'relative', width: '100%', paddingTop: '56.25%', background: '#0a0a0a' }}>
        {ev.snapshot_url && !imgErr ? (
          <SnapImgCard url={ev.snapshot_url} onError={() => setImgErr(true)} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: '#ffffff22' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" />
            </svg>
            <span style={{ fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase' }}>{ev.snapshot_url ? 'Processando…' : 'Sem snapshot'}</span>
          </div>
        )}

        {/* Badges */}
        {isNewest && !isAlert && (
          <div style={{ position: 'absolute', top: 7, left: 7, background: '#6366f1', color: '#fff', fontSize: 8, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4 }}>Novo</div>
        )}
        {isAlert && (
          <div style={{ position: 'absolute', top: 7, left: 7, background: '#f59e0b', color: '#000', fontSize: 8, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4 }}>⚠ Lotação</div>
        )}
        <div style={{ position: 'absolute', bottom: 7, right: 7, background: '#000000bb', color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z"/>
          </svg>
          {ev.total_pessoas}
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.camera_nome}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <div style={{ fontSize: 10, color: 'var(--text2)' }}>
            {fmtTime(ev.detectado_em)}
            <span style={{ marginLeft: 4, opacity: .6 }}>· {fmtTs(ev.detectado_em)}</span>
          </div>
          {ev.confianca_media != null && (
            <span style={{ fontSize: 9, fontWeight: 600, color: ev.confianca_media > .7 ? '#22c55e' : '#f59e0b' }}>
              {(ev.confianca_media * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function EventGrid({ events, onSelect }: { events: ContagemPessoa[]; onSelect: (ev: ContagemPessoa) => void }) {
  return (
    <div style={{ padding: 12, maxHeight: 640, overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {events.map((ev, i) => <EventCard key={ev.id} ev={ev} isNewest={i === 0} onSelect={onSelect} />)}
      </div>
    </div>
  )
}

// ── Event List — same row format as AlarmeCCTV ────────────────────────────────

function EventList({ events, onSelect }: { events: ContagemPessoa[]; onSelect: (ev: ContagemPessoa) => void }) {
  return (
    <div style={{ maxHeight: 640, overflowY: 'auto' }}>
      {events.map((ev, i) => {
        const isAlert = ev.alerta_lotacao
        const isNewest = i === 0
        return (
          <div key={ev.id} className="alarm-row" onClick={() => onSelect(ev)} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', cursor: 'pointer',
            borderBottom: i < events.length - 1 ? '1px solid var(--border)' : 'none',
            background: isAlert ? '#f59e0b08' : isNewest ? '#6366f108' : 'transparent',
            borderLeft: `3px solid ${isAlert ? '#f59e0b' : isNewest ? '#6366f1' : 'transparent'}`,
            transition: 'background .12s',
          }}>
            {/* Timestamp */}
            <div style={{ flexShrink: 0, width: 56, textAlign: 'center' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: isAlert ? '#f59e0b' : 'var(--text)', fontFamily: 'JetBrains Mono, monospace' }}>{fmtTime(ev.detectado_em)}</div>
              <div style={{ fontSize: 9, color: 'var(--text2)', marginTop: 2 }}>{fmtTs(ev.detectado_em)}</div>
            </div>

            <div style={{ width: 1, height: 32, background: 'var(--border)', flexShrink: 0 }} />

            {/* Snapshot thumbnail */}
            {ev.snapshot_url ? (
              <SnapshotThumb url={ev.snapshot_url} size={52} noZoom />
            ) : (
              <div style={{ width: 52, height: 52, borderRadius: 6, flexShrink: 0, background: 'var(--surface2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .2 }}>
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z" />
                </svg>
              </div>
            )}

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.camera_nome}</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
                <span style={{ fontWeight: 600, color: isAlert ? '#f59e0b' : 'var(--text2)' }}>{ev.total_pessoas}</span>
                {' '}pessoa{ev.total_pessoas !== 1 ? 's' : ''}
                {ev.confianca_media != null && <span style={{ marginLeft: 6, opacity: .6 }}>· {(ev.confianca_media * 100).toFixed(0)}% conf.</span>}
              </div>
            </div>

            {/* Alert badge */}
            {isAlert && (
              <div style={{ flexShrink: 0, padding: '3px 8px', borderRadius: 5, background: '#f59e0b18', border: '1px solid #f59e0b33', fontSize: 10, fontWeight: 700, color: '#f59e0b' }}>
                ⚠ Lotação
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Gráfico temporal ─────────────────────────────────────────────────────────

type TimelineRow = { ts: string; frames: number; frames_total: number; pico: number; media: number; total: number; alertas: number }
type Periodo = '6h' | '24h' | '7d' | '30d'

const PERIODOS: { key: Periodo; label: string }[] = [
  { key: '6h',  label: '6h'   },
  { key: '24h', label: '24h'  },
  { key: '7d',  label: '7 dias' },
  { key: '30d', label: '30 dias' },
]

function fmtTick(ts: string, periodo: Periodo) {
  try {
    const d = new Date(ts)
    if (periodo === '6h' || periodo === '24h')
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  } catch { return '' }
}

function fmtTooltipLabel(ts: string, periodo: Periodo) {
  try {
    const d = new Date(ts)
    if (periodo === '6h' || periodo === '24h')
      return d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' })
  } catch { return ts }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label, periodo }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as TimelineRow
  if (!d) return null
  const cobertura = d.frames_total > 0 ? ((d.frames / d.frames_total) * 100).toFixed(1) : '0'
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 14px', fontSize: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,.4)', minWidth: 200,
    }}>
      <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 8, fontSize: 11 }}>
        {fmtTooltipLabel(label, periodo)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Row2 color="#0ea5e9" label="Pico"           val={d.pico}                        unit=" pessoas" />
        <Row2 color="#38bdf8" label="Média p/ frame" val={Number(d.media).toFixed(1)}    unit=" pessoas" />
        <Row2 color="#22c55e" label="Total acumulado" val={d.total}                       unit=" pessoas" />
        <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />
        <Row2 color="var(--text2)" label="Frames c/ pessoas" val={d.frames} />
        <Row2 color="var(--text2)" label="Escaneamentos"    val={(d.frames_total ?? 0).toLocaleString()} />
        <Row2 color={parseFloat(cobertura) > 10 ? '#22c55e' : '#f59e0b'}
              label="Cobertura"   val={`${cobertura}%`} />
        {d.alertas > 0 && <Row2 color="#ef4444" label="Alertas lotação" val={d.alertas} />}
      </div>
    </div>
  )
}
function Row2({ color, label, val, unit = '' }: { color: string; label: string; val: string | number; unit?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <div style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
        <span style={{ color: 'var(--text2)', fontSize: 11 }}>{label}</span>
      </div>
      <span style={{ fontWeight: 700, color: 'var(--text)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>
        {val}{unit}
      </span>
    </div>
  )
}

// custom bar shape that rounds the top corners
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RoundBar(props: any) {
  const { x, y, width, height, fill } = props
  if (!height || height <= 0) return null
  const r = Math.min(4, width / 2)
  return (
    <path
      d={`M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`}
      fill={fill}
    />
  )
}

function PessoasChart({ cameras }: { cameras: Camera[] }) {
  const [periodo, setPeriodo] = useState<Periodo>('24h')
  const [camId, setCamId]     = useState<number | undefined>(undefined)
  const [rows, setRows]       = useState<TimelineRow[]>([])
  const [picoGlobal, setPicoGlobal] = useState(0)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getPessoasTimeline({ periodo, ...(camId ? { camera_id: camId } : {}) })
      setRows(r.data.data)
      setPicoGlobal(r.data.pico_global)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [periodo, camId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const hasAlerts    = rows.some(r => r.alertas > 0)
  const maxY         = Math.max(picoGlobal, 1)
  const totalPessoas = rows.reduce((s, r) => s + r.total, 0)
  const totalAlertas = rows.reduce((s, r) => s + r.alertas, 0)
  const totalFrames  = rows.reduce((s, r) => s + (r.frames_total ?? 0), 0)
  const totalDetec   = rows.reduce((s, r) => s + r.frames, 0)
  const coberturaGlobal = totalFrames > 0 ? ((totalDetec / totalFrames) * 100).toFixed(1) : '0'
  const mediaGlobal  = rows.length > 0
    ? (rows.reduce((s, r) => s + Number(r.media), 0) / rows.filter(r => Number(r.media) > 0).length || 0).toFixed(1)
    : '0'

  // Avisa câmeras com limite irreal (> 500 para contexto de vigilância)
  const alertCams = cameras.filter(c => c.limite_pessoas != null && c.limite_pessoas > 500)

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, marginBottom: 16, overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '13px 18px', borderBottom: '1px solid var(--border)', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
          </svg>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', letterSpacing: '-.01em' }}>
            Fluxo Temporal de Pessoas
          </span>
          {loading && <span className="spinner" style={{ width: 12, height: 12 }} />}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {cameras.length > 1 && (
            <select
              value={camId ?? ''}
              onChange={e => setCamId(e.target.value ? +e.target.value : undefined)}
              style={{
                padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)',
                background: 'var(--surface2)', color: 'var(--text)', fontSize: 11, outline: 'none',
              }}
            >
              <option value="">Todas as câmeras</option>
              {cameras.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          )}
          <div style={{ display: 'flex', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', background: 'var(--surface2)' }}>
            {PERIODOS.map(p => (
              <button key={p.key} onClick={() => setPeriodo(p.key)} style={{
                padding: '4px 10px', border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                background: periodo === p.key ? 'var(--primary)' : 'transparent',
                color: periodo === p.key ? '#e0f2fe' : 'var(--text2)',
                transition: 'all .15s',
              }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
        borderBottom: '1px solid var(--border)',
      }}>
        {[
          { label: 'Pico máximo',      val: picoGlobal,                   unit: 'pessoas',      color: '#0ea5e9' },
          { label: 'Média / frame',    val: mediaGlobal,                  unit: 'pessoas',      color: '#38bdf8' },
          { label: 'Total acumulado',  val: totalPessoas.toLocaleString(), unit: 'pessoas',      color: '#22c55e' },
          { label: 'Cobertura',        val: `${coberturaGlobal}%`,        unit: `${totalDetec.toLocaleString()} frames`, color: parseFloat(coberturaGlobal) > 10 ? '#22c55e' : '#f59e0b' },
          { label: 'Alertas lotação',  val: totalAlertas,                 unit: 'eventos',      color: totalAlertas > 0 ? '#ef4444' : 'var(--text2)' },
        ].map((s, i) => (
          <div key={s.label} style={{
            padding: '10px 14px',
            borderRight: i < 4 ? '1px solid var(--border)' : 'none',
          }}>
            <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 3 }}>{s.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={{ fontSize: 20, fontWeight: 750, color: s.color, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>{s.val}</span>
            </div>
            <div style={{ fontSize: 9, color: 'var(--text2)', marginTop: 2 }}>{s.unit}</div>
          </div>
        ))}
      </div>

      {/* Aviso câmeras com limite irreal */}
      {alertCams.length > 0 && (
        <div style={{
          padding: '8px 16px', background: 'rgba(239,68,68,.05)',
          borderBottom: '1px solid rgba(239,68,68,.15)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span style={{ fontSize: 11, color: '#ef4444' }}>
            <strong>Alertas desativados:</strong>{' '}
            {alertCams.map(c => `${c.nome} (limite=${c.limite_pessoas?.toLocaleString()})`).join(', ')}{' '}
            — limite muito alto para disparar. Ajuste em Câmeras.
          </span>
        </div>
      )}

      {/* Chart */}
      <div style={{ padding: '18px 8px 4px 0', height: 280 }}>
        {rows.length === 0 && !loading ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--text2)' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .25 }}>
              <path d="M18 20V10M12 20V4M6 20v-6"/>
            </svg>
            <span style={{ fontSize: 12, opacity: .5 }}>Sem dados para o período</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" minWidth={0} height="100%">
            <ComposedChart data={rows} margin={{ top: 6, right: 24, left: 0, bottom: 0 }} barCategoryGap="20%">
              <defs>
                <linearGradient id="barGradNormal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.85} />
                  <stop offset="100%" stopColor="#0369a1" stopOpacity={0.7} />
                </linearGradient>
                <linearGradient id="barGradAlert" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#d97706" stopOpacity={0.7} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="rgba(14,165,233,.07)" vertical={false} />

              <XAxis
                dataKey="ts"
                tickFormatter={ts => fmtTick(ts, periodo)}
                tick={{ fontSize: 10, fill: 'var(--text2)', fontFamily: 'inherit' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={36}
              />

              <YAxis
                yAxisId="pessoas"
                domain={[0, maxY + Math.ceil(maxY * 0.18)]}
                tick={{ fontSize: 10, fill: 'var(--text2)', fontFamily: 'inherit' }}
                axisLine={false}
                tickLine={false}
                width={34}
                tickFormatter={v => String(v)}
              />
              <YAxis
                yAxisId="cobertura"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 9, fill: 'rgba(14,165,233,.4)', fontFamily: 'inherit' }}
                axisLine={false}
                tickLine={false}
                width={28}
                tickFormatter={v => `${v}%`}
              />

              <Tooltip
                content={<CustomTooltip periodo={periodo} />}
                cursor={{ fill: 'rgba(14,165,233,.06)', radius: 4 } as object}
              />

              {hasAlerts && (
                <ReferenceLine
                  yAxisId="pessoas"
                  y={picoGlobal}
                  stroke="rgba(239,68,68,.4)"
                  strokeDasharray="4 3"
                  label={{ value: '⚠ pico alerta', position: 'insideTopRight', fontSize: 9, fill: '#ef4444', opacity: .7 }}
                />
              )}

              <Legend
                iconSize={8}
                iconType="circle"
                wrapperStyle={{ fontSize: 11, paddingTop: 10, paddingLeft: 36 }}
                formatter={(value) => <span style={{ color: 'var(--text2)' }}>{value}</span>}
              />

              {/* Barras de cobertura (% frames com pessoas) — fundo semi-transparente */}
              <Bar
                yAxisId="cobertura"
                dataKey={(r: TimelineRow) => r.frames_total > 0
                  ? parseFloat(((r.frames / r.frames_total) * 100).toFixed(1))
                  : 0}
                name="Cobertura %"
                maxBarSize={40}
                fill="rgba(14,165,233,.10)"
                radius={[3, 3, 0, 0]}
              />

              {/* Barras de pico por hora — coloridas por alerta */}
              <Bar
                yAxisId="pessoas"
                dataKey="pico"
                name="Pico / hora"
                shape={<RoundBar />}
                maxBarSize={40}
              >
                {rows.map((r, i) => (
                  <Cell
                    key={i}
                    fill={r.alertas > 0 ? 'url(#barGradAlert)' : 'url(#barGradNormal)'}
                  />
                ))}
                {/* Label acima de barras só quando pico >= 3 para não poluir */}
                <LabelList
                  dataKey="pico"
                  position="top"
                  style={{ fontSize: 9, fill: 'var(--text2)', fontFamily: 'inherit' }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(v: any) => Number(v) >= 3 ? String(v) : ''}
                />
              </Bar>

              {/* Linha de média */}
              <Line
                yAxisId="pessoas"
                type="monotone"
                dataKey="media"
                name="Média"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#38bdf8', stroke: 'var(--surface)', strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Legend note */}
      <div style={{ padding: '8px 16px 12px', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text2)' }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: '#0ea5e9' }} />
          Pico (hora normal)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text2)' }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: '#f59e0b' }} />
          Pico (hora c/ alerta)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text2)' }}>
          <div style={{ width: 22, height: 2, background: '#38bdf8', borderRadius: 2 }} />
          Média p/ frame
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text2)' }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: 'rgba(14,165,233,.25)' }} />
          Cobertura % (eixo direito)
        </div>
        {rows.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text2)', fontFamily: 'JetBrains Mono, monospace' }}>
            {totalFrames.toLocaleString()} frames · {rows.length} pontos · {periodo}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Helpers de horário ────────────────────────────────────────────────────────

function parseSchedule(faixa: string | null | undefined): { ini: string; fim: string } {
  const raw = faixa || '00:00-23:59'
  const [ini, fim] = raw.split('-')
  return { ini: ini || '00:00', fim: fim || '23:59' }
}

function isAlwaysOn(faixa: string | null | undefined) {
  const f = (faixa || '').trim()
  return !f || f === '00:00-23:59'
}

function isInScheduleNow(faixa: string | null | undefined): boolean {
  if (isAlwaysOn(faixa)) return true
  try {
    const { ini, fim } = parseSchedule(faixa)
    const [h1, m1] = ini.split(':').map(Number)
    const [h2, m2] = fim.split(':').map(Number)
    const now = new Date()
    const curr  = now.getHours() * 60 + now.getMinutes()
    const start = h1 * 60 + m1
    const end   = h2 * 60 + m2
    return start <= end ? (curr >= start && curr <= end) : (curr >= start || curr <= end)
  } catch { return true }
}

// ── Modal de configuração de horário ─────────────────────────────────────────

function ScheduleModal({ camera, onClose, onSaved }: {
  camera: Camera
  onClose: () => void
  onSaved: () => void
}) {
  const [ini, setIni] = useState(() => parseSchedule(camera.faixa_horaria).ini)
  const [fim, setFim] = useState(() => parseSchedule(camera.faixa_horaria).fim)
  const [always, setAlways] = useState(() => isAlwaysOn(camera.faixa_horaria))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    const faixa = always ? '00:00-23:59' : `${ini}-${fim}`
    setSaving(true); setErr('')
    try {
      await updateSchedulePessoas(camera.id, faixa)
      onSaved()
      onClose()
    } catch {
      setErr('Falha ao salvar. Tente novamente.')
    } finally { setSaving(false) }
  }

  // Preview: mostra se estaria ativo agora com configuração atual
  const previewFaixa = always ? '00:00-23:59' : `${ini}-${fim}`
  const activeNow = isInScheduleNow(previewFaixa)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const inp: React.CSSProperties = {
    width: '100%', padding: '9px 11px', borderRadius: 3,
    border: '1px solid var(--border)', background: 'var(--surface2)',
    color: 'var(--text)', fontSize: 14, fontWeight: 700,
    outline: 'none', fontFamily: 'JetBrains Mono, monospace',
    letterSpacing: 1, boxSizing: 'border-box',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderTop: `2px solid ${AC}`, borderRadius: 4,
        width: '100%', maxWidth: 400,
        boxShadow: '0 32px 80px rgba(0,0,0,.6)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '13px 16px', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 7 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={AC} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
              </svg>
              Horário de Ativação
            </div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{camera.nome}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', display: 'flex', padding: 4 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 16px 14px' }}>

          {/* Toggle sempre ativo */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '11px 13px', borderRadius: 3,
            background: always ? 'rgba(16,185,129,.06)' : 'var(--surface2)',
            border: `1px solid ${always ? 'rgba(16,185,129,.25)' : 'var(--border)'}`,
            marginBottom: 16, cursor: 'pointer', transition: 'all .15s',
          }} onClick={() => setAlways(v => !v)}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Sempre ativo (24h)</div>
              <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>Sem restrição de horário</div>
            </div>
            <div style={{
              width: 36, height: 20, borderRadius: 10, transition: 'background .18s',
              background: always ? '#10b981' : 'var(--surface3)',
              border: `1px solid ${always ? '#10b981' : 'var(--border)'}`,
              position: 'relative', flexShrink: 0,
            }}>
              <div style={{
                position: 'absolute', top: 2, width: 14, height: 14, borderRadius: '50%',
                background: '#fff', transition: 'left .18s',
                left: always ? 18 : 2, boxShadow: '0 1px 3px rgba(0,0,0,.3)',
              }} />
            </div>
          </div>

          {/* Time range */}
          <div style={{ opacity: always ? .4 : 1, transition: 'opacity .2s', pointerEvents: always ? 'none' : 'auto' }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 10 }}>
              Faixa Horária
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 20px 1fr', alignItems: 'center', gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 5 }}>Início</div>
                <input type="time" value={ini} onChange={e => setIni(e.target.value)} style={inp} />
              </div>
              <div style={{ textAlign: 'center', paddingTop: 20 }}>
                <div style={{ width: '100%', height: 1, background: 'var(--border)' }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 5 }}>Fim</div>
                <input type="time" value={fim} onChange={e => setFim(e.target.value)} style={inp} />
              </div>
            </div>

            {!always && ini > fim && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--primary)', display: 'flex', gap: 5, alignItems: 'center' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                Faixa noturna: ativa das {ini} até {fim} do dia seguinte
              </div>
            )}
          </div>

          {/* Preview status */}
          <div style={{
            marginTop: 16, padding: '9px 12px', borderRadius: 3,
            background: activeNow ? 'rgba(16,185,129,.06)' : 'rgba(245,158,11,.06)',
            border: `1px solid ${activeNow ? 'rgba(16,185,129,.2)' : 'rgba(245,158,11,.2)'}`,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: activeNow ? '#10b981' : AC,
              boxShadow: `0 0 5px ${activeNow ? '#10b981' : AC}`,
            }} />
            <div style={{ fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: activeNow ? '#10b981' : AC }}>
                {activeNow ? 'Ativo agora' : 'Pausado agora'}
              </span>
              <span style={{ color: 'var(--text2)', marginLeft: 4 }}>
                · {new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>

          {err && (
            <div style={{ marginTop: 10, fontSize: 11, color: '#f87171', padding: '7px 11px', borderRadius: 3, background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.2)' }}>
              {err}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '0 16px 16px', display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '8px 0', borderRadius: 3, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text2)', fontSize: 12, fontWeight: 500,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancelar</button>
          <button onClick={save} disabled={saving} style={{
            flex: 2, padding: '8px 0', borderRadius: 3, border: 'none',
            background: AC, color: '#000', fontSize: 12, fontWeight: 700,
            cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            opacity: saving ? .6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
            {saving
              ? <><span className="spinner" style={{ width: 13, height: 13 }} /> Salvando...</>
              : '✓ Salvar horário'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Painel lateral de câmeras ─────────────────────────────────────────────────

function CameraSidebar({ cameras, alertas, onUpdated }: {
  cameras: Camera[]
  alertas: number
  onUpdated: () => void
}) {
  const [scheduleFor, setScheduleFor] = useState<Camera | null>(null)

  return (
    <>
      {scheduleFor && (
        <ScheduleModal
          camera={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onSaved={onUpdated}
        />
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Câmeras Ativas</div>
          <span style={{ fontSize: 10, color: 'var(--text2)' }}>{cameras.length}</span>
        </div>

        <div style={{ maxHeight: 500, overflowY: 'auto' }}>
          {cameras.length === 0 ? (
            <div style={{ padding: '24px 14px', textAlign: 'center', fontSize: 12, color: 'var(--text2)', opacity: .6 }}>
              Nenhuma câmera com contagem ativa
            </div>
          ) : cameras.map(c => {
            const active = isInScheduleNow(c.faixa_horaria)
            const always = isAlwaysOn(c.faixa_horaria)
            return (
              <div key={c.id} style={{
                padding: '9px 12px', borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: active ? '#22c55e' : '#f59e0b',
                    boxShadow: `0 0 0 3px ${active ? '#22c55e28' : '#f59e0b28'}`,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.nome}</div>
                    {c.local && (
                      <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.local}</div>
                    )}
                  </div>
                  {c.limite_pessoas != null && (
                    <span title={c.limite_pessoas > 500 ? 'Limite muito alto — alertas dificilmente disparam' : `Alerta acima de ${c.limite_pessoas} pessoas`}
                      style={{
                        fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4, flexShrink: 0,
                        color: c.limite_pessoas > 500 ? '#ef4444' : '#f59e0b',
                        background: c.limite_pessoas > 500 ? '#ef444418' : '#f59e0b18',
                      }}>
                      {c.limite_pessoas > 500 ? `⚠ lim ${c.limite_pessoas}` : `≤${c.limite_pessoas}`}
                    </span>
                  )}
                </div>

                {/* Horário + botão configurar */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 7 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '3px 8px', borderRadius: 6,
                    background: always ? 'rgba(14,165,233,.07)' : active ? 'rgba(16,185,129,.07)' : 'rgba(245,158,11,.07)',
                    border: `1px solid ${always ? 'rgba(14,165,233,.18)' : active ? 'rgba(16,185,129,.18)' : 'rgba(245,158,11,.18)'}`,
                  }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                      stroke={always ? 'var(--primary)' : active ? '#22c55e' : '#f59e0b'}
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                    </svg>
                    <span style={{ fontSize: 10, fontWeight: 600, color: always ? 'var(--primary)' : active ? '#22c55e' : '#f59e0b', fontFamily: 'JetBrains Mono, monospace' }}>
                      {always ? '24h' : c.faixa_horaria}
                    </span>
                  </div>
                  <button
                    onClick={() => setScheduleFor(c)}
                    title="Configurar horário"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--text2)', fontSize: 10, fontWeight: 500,
                      fontFamily: 'inherit', transition: 'all .15s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--text2)' }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    Horário
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Alertas */}
        {alertas > 0 && (
          <div style={{ margin: 10, borderRadius: 8, padding: '10px 12px', background: '#f59e0b08', border: '1px solid #f59e0b33' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 4 }}>
              Alertas nesta página
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#f59e0b' }}>{alertas}</div>
            <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>evento{alertas !== 1 ? 's' : ''} de lotação</div>
          </div>
        )}
      </div>
    </>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const LIMIT = 120

export default function LeituraPessoas() {
  const [data, setData]       = useState<ContagemPessoa[]>([])
  const [total, setTotal]     = useState(0)
  const [cameras, setCameras] = useState<Camera[]>([])
  const [loading, setLoading] = useState(true)
  const [offset, setOffset]   = useState(0)
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const [view, setView]       = useState<'grid' | 'list'>('grid')
  const [selectedEv, setSelectedEv] = useState<ContagemPessoa | null>(null)
  const [filters, setFilters] = useState({
    camera_id: '', apenas_alertas: '', data_inicio: '', data_fim: '',
  })
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { alert: moduleAlert, prefs, toggleSound, toggleVisual, dismiss } = useModuleAlerts({
    moduleKey: 'pessoas',
    eventTypes: ['alerta_lotacao'],
    buildMessage: (e) => `Lotação detectada: ${e.total} pessoas${e.limite ? ` (limite: ${e.limite})` : ''}`,
    sirenDuration: 6,
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = { limit: LIMIT, offset }
      if (filters.camera_id)     params.camera_id     = +filters.camera_id
      if (filters.apenas_alertas === 'true') params.apenas_alertas = true
      if (filters.data_inicio)   params.data_inicio   = filters.data_inicio
      if (filters.data_fim)      params.data_fim      = filters.data_fim
      const r = await getContagensPessoas(params)
      setData(r.data.data)
      setTotal(r.data.total)
      setLastRefresh(new Date())
    } finally { setLoading(false) }
  }, [offset, filters])

  const loadCameras = useCallback(() => {
    getCameras().then(r => setCameras(r.data.data.filter(c => c.rec_contagem_pessoas && c.ativa)))
  }, [])

  useEffect(() => { loadCameras() }, [loadCameras])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    timerRef.current = setInterval(load, 30_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [load])

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters(f => ({ ...f, [k]: v }))
    setOffset(0)
  }

  const totalPessoas = data.reduce((s, r) => s + r.total_pessoas, 0)
  const pico         = data.reduce((s, r) => Math.max(s, r.total_pessoas), 0)
  const alertas      = data.filter(r => r.alerta_lotacao).length
  const pages = Math.ceil(total / LIMIT)
  const page  = Math.floor(offset / LIMIT)

  return (
    <div style={{ padding: '24px 28px', width: '100%', boxSizing: 'border-box' }}>
      {selectedEv && <EventDetailModal ev={selectedEv} onClose={() => setSelectedEv(null)} />}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        .alarm-row:hover { background: var(--surface2) !important; }
        .ev-card:hover { box-shadow: 0 4px 20px #0002; border-color: #6366f188 !important; }
        .ev-card:hover .card-hover-overlay { background: #00000022 !important; }
        .ev-card:hover .card-zoom-icon { opacity: 1 !important; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: moduleAlert ? 10 : 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: 'var(--text)', letterSpacing: '-.01em' }}>Leitura Pessoas</h2>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text2)' }}>
            {total.toLocaleString()} registro{total !== 1 ? 's' : ''} · atualizado {format(lastRefresh, 'HH:mm:ss')}
          </p>
        </div>
        <button onClick={load} disabled={loading} style={{
          padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)',
          background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text2)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {loading
            ? <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--primary)', animation: 'spin .7s linear infinite' }} />
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
          }
          Atualizar
        </button>
      </div>

      {/* ── Alert Banner ── */}
      <div style={{ marginBottom: 16 }}>
        <ModuleAlertBanner
          alert={moduleAlert}
          soundEnabled={prefs.sound}
          visualEnabled={prefs.visual}
          onToggleSound={toggleSound}
          onToggleVisual={toggleVisual}
          onDismiss={dismiss}
          accentColor="#f97316"
        />
      </div>

      {/* ── Stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Total registros', val: total.toLocaleString(), accent: 'var(--primary)' },
          { label: 'Pessoas (pág)',   val: totalPessoas.toLocaleString(), accent: '#38bdf8' },
          { label: 'Pico detecção',  val: pico, accent: pico > 0 ? '#f59e0b' : 'var(--primary)' },
          { label: 'Alertas lotação', val: alertas, accent: alertas > 0 ? '#ef4444' : '#22c55e' },
        ].map(s => (
          <div key={s.label} style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '12px 16px', position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: s.accent }} />
            <div style={{ fontSize: 24, fontWeight: 750, color: 'var(--text)', lineHeight: 1.1 }}>{s.val}</div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3, fontWeight: 500 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Gráfico temporal ── */}
      <PessoasChart cameras={cameras} />

      {/* ── Main panel ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 12, alignItems: 'start' }}>

        {/* Event log */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>

          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid var(--border)', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 8, flex: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <select style={selStyle} value={filters.camera_id} onChange={e => setFilter('camera_id', e.target.value)}>
                <option value="">Todas as câmeras</option>
                {cameras.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
              <select style={selStyle} value={filters.apenas_alertas} onChange={e => setFilter('apenas_alertas', e.target.value)}>
                <option value="">Todos</option>
                <option value="true">⚠ Apenas lotação</option>
              </select>
              <input style={selStyle} type="date" value={filters.data_inicio} onChange={e => setFilter('data_inicio', e.target.value)} placeholder="De" />
              <input style={selStyle} type="date" value={filters.data_fim} onChange={e => setFilter('data_fim', e.target.value)} placeholder="Até" />
              {Object.values(filters).some(v => v !== '') && (
                <button onClick={() => { setFilters({ camera_id: '', apenas_alertas: '', data_inicio: '', data_fim: '' }); setOffset(0) }}
                  style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text2)' }}>
                  ✕ Limpar
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              {data.length > 0 && (
                <span style={{ fontSize: 10, color: 'var(--text2)', background: 'var(--surface2)', padding: '1px 7px', borderRadius: 20, border: '1px solid var(--border)' }}>
                  {data.length}
                </span>
              )}
              <div style={{ display: 'flex', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden' }}>
                {(['grid', 'list'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)} style={{
                    padding: '4px 8px', border: 'none', cursor: 'pointer', lineHeight: 0,
                    background: view === v ? 'var(--primary)' : 'transparent',
                    color: view === v ? '#fff' : 'var(--text2)',
                    transition: 'background .15s',
                  }}>
                    {v === 'grid' ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                        <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
                        <line x1="8" y1="18" x2="21" y2="18"/>
                        <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/>
                        <line x1="3" y1="18" x2="3.01" y2="18"/>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loading && data.length === 0 ? (
            <div style={{ padding: '52px 0', textAlign: 'center' }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', border: '3px solid var(--border)', borderTopColor: 'var(--primary)', animation: 'spin .7s linear infinite', margin: '0 auto' }} />
            </div>
          ) : data.length === 0 ? (
            <div style={{ padding: '52px 0', textAlign: 'center', color: 'var(--text2)' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .3, marginBottom: 10 }}>
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" />
              </svg>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Nenhum registro encontrado</div>
              <div style={{ fontSize: 11, marginTop: 4, opacity: .6 }}>Os dados aparecerão quando câmeras com Contagem de Pessoas enviarem imagens</div>
            </div>
          ) : view === 'grid' ? (
            <EventGrid events={data} onSelect={setSelectedEv} />
          ) : (
            <EventList events={data} onSelect={setSelectedEv} />
          )}

          {/* Pagination */}
          {pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderTop: '1px solid var(--border)', justifyContent: 'center' }}>
              <button style={pgBtn} disabled={page === 0} onClick={() => setOffset(o => o - LIMIT)}>← Anterior</button>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>Página {page + 1} de {pages}</span>
              <button style={pgBtn} disabled={page >= pages - 1} onClick={() => setOffset(o => o + LIMIT)}>Próximo →</button>
            </div>
          )}
        </div>

        {/* Camera list sidebar */}
        <CameraSidebar cameras={cameras} alertas={alertas} onUpdated={loadCameras} />
      </div>
    </div>
  )
}

// ── Shared mini styles ────────────────────────────────────────────────────────

const selStyle: React.CSSProperties = {
  padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface2)', color: 'var(--text)', fontSize: 11,
}

const pgBtn: React.CSSProperties = {
  fontSize: 11, padding: '4px 10px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'transparent',
  cursor: 'pointer', color: 'var(--text2)',
}
