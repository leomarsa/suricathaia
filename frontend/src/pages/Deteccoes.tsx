import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  getDeteccoes, getDeteccaoStats, getCameras, getLprTimeline, getLprActivity,
  type Deteccao, type Stats, type Camera, type LprTimelineRow, type CameraLprActivity,
} from '../api'
import { useModuleAlerts } from '../hooks/useModuleAlerts'
import ModuleAlertBanner from '../components/ModuleAlertBanner'
import { format } from 'date-fns'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'

// ── Helpers ───────────────────────────────────────────────────────────────────

const LIMIT = 30

function storageUrl(caminho: string | null): string | null {
  if (!caminho) return null
  return caminho.replace(/^\/opt\/suricatha/, '')
}

function fmtTs(ts: string) {
  return format(new Date(ts), 'dd/MM/yy HH:mm:ss')
}
function fmtTime(ts: string) {
  return format(new Date(ts), 'HH:mm:ss')
}
function fmtTlTs(ts: string, periodo: string) {
  const d = new Date(ts)
  return periodo === '30d' || periodo === '7d' ? format(d, 'dd/MM') : format(d, 'HH:mm')
}
function timeSince(ts: string | null): string {
  if (!ts) return 'Nunca'
  const diff = (Date.now() - new Date(ts).getTime()) / 1000
  if (diff < 60)   return `${Math.round(diff)}s atrás`
  if (diff < 3600) return `${Math.round(diff / 60)}min atrás`
  if (diff < 86400) return `${Math.round(diff / 3600)}h atrás`
  return `${Math.round(diff / 86400)}d atrás`
}
function isNew(ts: string, seconds = 30) {
  return (Date.now() - new Date(ts).getTime()) / 1000 < seconds
}

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

// ── Placa badge (visual de placa real) ────────────────────────────────────────

function PlacaTag({ placa, size = 'md' }: { placa: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: { fs: 11, px: '4px 8px', r: 4 }, md: { fs: 15, px: '5px 12px', r: 6 }, lg: { fs: 22, px: '7px 18px', r: 8 } }
  const s = sizes[size]
  if (!placa) return <span style={{ fontSize: s.fs, color: 'rgba(255,255,255,.3)', fontFamily: 'monospace' }}>—</span>
  return (
    <span style={{
      display: 'inline-block',
      fontFamily: 'JetBrains Mono, monospace', fontSize: s.fs, fontWeight: 900,
      letterSpacing: '0.12em', color: '#1a1a2e',
      background: 'linear-gradient(180deg,#fff 0%,#f0f0f0 100%)',
      padding: s.px, borderRadius: s.r,
      border: '2px solid #d0d0d0',
      boxShadow: '0 2px 6px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.8)',
      lineHeight: 1.1,
    }}>
      {placa}
    </span>
  )
}

// ── Confidence pill ───────────────────────────────────────────────────────────

function ConfPill({ v }: { v: number }) {
  if (!v) return <span style={{ color: 'rgba(255,255,255,.3)', fontSize: 11 }}>—</span>
  const pct = v * 100
  const color = pct > 85 ? '#4ade80' : pct > 60 ? '#fbbf24' : '#f87171'
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color,
      background: `${color}22`, padding: '1px 7px', borderRadius: 20,
      border: `1px solid ${color}44`,
    }}>{pct.toFixed(0)}%</span>
  )
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function Lightbox({ det, onClose }: { det: Deteccao; onClose: () => void }) {
  const imgUrl  = storageUrl(det.caminho_storage)
  const cropUrl = det.crop_url

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(0,0,0,.88)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', borderRadius: 16,
          border: '1px solid var(--border)',
          maxWidth: 900, width: '100%',
          boxShadow: '0 32px 100px rgba(0,0,0,.7)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          background: 'var(--surface2)',
        }}>
          <PlacaTag placa={det.placa} size="lg" />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {det.watchlist_hit && (
              <span style={{ background: 'rgba(239,68,68,.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,.35)', borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>
                ⚠ WATCHLIST — {det.watchlist_tipo || 'Alerta'}
              </span>
            )}
            {det.divergencia && (
              <span style={{ background: 'rgba(245,158,11,.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.35)', borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>
                DIVERGÊNCIA
              </span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{det.camera_nome}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'monospace' }}>{fmtTs(det.detectado_em)}</div>
          </div>
          <button onClick={onClose} style={{
            background: 'var(--surface3)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '5px 10px', cursor: 'pointer', color: 'var(--text2)', fontSize: 14,
          }}>✕</button>
        </div>

        {/* Images */}
        <div style={{ display: 'grid', gridTemplateColumns: cropUrl ? '2fr 1fr' : '1fr', gap: 0 }}>
          <div style={{ background: '#000', position: 'relative' }}>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,.45)', position: 'absolute', top: 10, left: 12, zIndex: 1, letterSpacing: '.06em', textTransform: 'uppercase', background: 'rgba(0,0,0,.5)', padding: '2px 8px', borderRadius: 4 }}>
              Câmera — original
            </div>
            {imgUrl ? (
              <img src={imgUrl} alt="original"
                style={{ width: '100%', maxHeight: 400, objectFit: 'contain', display: 'block' }}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,.2)', fontSize: 13 }}>
                Imagem não disponível
              </div>
            )}
          </div>
          {cropUrl && (
            <div style={{ background: '#0a0a0a', borderLeft: '1px solid var(--border)', position: 'relative' }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,.45)', position: 'absolute', top: 10, left: 12, zIndex: 1, letterSpacing: '.06em', textTransform: 'uppercase', background: 'rgba(0,0,0,.5)', padding: '2px 8px', borderRadius: 4 }}>
                Recorte da placa
              </div>
              <img src={cropUrl} alt="crop"
                style={{ width: '100%', height: '100%', maxHeight: 400, objectFit: 'contain', display: 'block' }}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          )}
        </div>

        {/* Meta */}
        <div style={{
          display: 'flex', gap: 24, padding: '12px 20px',
          borderTop: '1px solid var(--border)', background: 'var(--surface2)',
          fontSize: 12, color: 'var(--text2)', flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span>Confiança: <ConfPill v={det.confianca_final} /></span>
          <span>Processado: <b style={{ color: 'var(--text)' }}>{det.tempo_processo_ms ? `${det.tempo_processo_ms}ms` : '—'}</b></span>
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text3)' }}>{det.arquivo_original}</span>
          {imgUrl && (
            <a href={imgUrl} target="_blank" rel="noopener"
              style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>
              Abrir original ↗
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Live feed item ─────────────────────────────────────────────────────────────

function FeedItem({ det, fresh }: { det: Deteccao; fresh: boolean }) {
  const [open, setOpen] = useState(false)
  const imgUrl = storageUrl(det.caminho_storage)
  const alert  = det.watchlist_hit

  return (
    <>
      <div
        onClick={() => setOpen(true)}
        style={{
          display: 'flex', gap: 10, alignItems: 'center',
          padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
          background: alert ? 'rgba(239,68,68,.07)' : fresh ? 'rgba(99,102,241,.06)' : 'transparent',
          border: `1px solid ${alert ? 'rgba(239,68,68,.25)' : fresh ? 'rgba(99,102,241,.2)' : 'var(--border)'}`,
          transition: 'background .15s',
          animation: fresh ? 'feed-slide-in .35s ease-out' : 'none',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = alert ? 'rgba(239,68,68,.13)' : 'var(--surface2)')}
        onMouseLeave={e => (e.currentTarget.style.background = alert ? 'rgba(239,68,68,.07)' : fresh ? 'rgba(99,102,241,.06)' : 'transparent')}
      >
        {/* Thumbnail */}
        <div style={{ width: 58, height: 42, borderRadius: 6, overflow: 'hidden', background: '#111', flexShrink: 0, position: 'relative' }}>
          {imgUrl ? (
            <img src={imgUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Ic d="M15 10l-4 4l6 6l4-16l-18 6l4 4l2 3z" size={12} color="rgba(255,255,255,.2)" />
            </div>
          )}
          {alert && <div style={{ position: 'absolute', inset: 0, border: '2px solid #ef4444', borderRadius: 6 }} />}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
            {det.placa ? (
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 900,
                letterSpacing: '.1em', color: 'var(--text)',
              }}>{det.placa}</span>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>sem placa</span>
            )}
            {fresh && !alert && (
              <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: '#6366f1', color: '#fff', letterSpacing: '.04em' }}>NOVO</span>
            )}
            {alert && (
              <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: '#ef4444', color: '#fff', letterSpacing: '.04em' }}>⚠</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {det.camera_nome || '—'}
          </div>
        </div>

        {/* Right: time + conf */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: alert ? '#ef4444' : 'var(--text2)', fontWeight: 600 }}>
            {fmtTime(det.detectado_em)}
          </div>
          {det.confianca_final > 0 && (
            <div style={{
              fontSize: 10, fontWeight: 700,
              color: det.confianca_final > .85 ? '#4ade80' : det.confianca_final > .6 ? '#fbbf24' : '#f87171',
            }}>
              {(det.confianca_final * 100).toFixed(0)}%
            </div>
          )}
        </div>
      </div>

      {open && createPortal(<Lightbox det={det} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

// ── Live Feed Panel ───────────────────────────────────────────────────────────

function LiveFeedPanel({ items, liveStatus }: { items: Deteccao[]; liveStatus: 'connecting' | 'live' | 'offline' }) {
  const alerts = items.filter(d => d.watchlist_hit).length
  return (
    <div style={{
      position: 'sticky', top: 24, height: 'calc(100vh - 140px)',
      display: 'flex', flexDirection: 'column',
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 14, overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 14px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: liveStatus === 'live' ? '#22c55e' : liveStatus === 'offline' ? '#ef4444' : '#818cf8',
            boxShadow: liveStatus === 'live' ? '0 0 0 0 rgba(34,197,94,.5)' : 'none',
            animation: liveStatus === 'live' ? 'pulse-dot 1.8s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', flex: 1 }}>Feed ao Vivo</span>
          {alerts > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(239,68,68,.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)',
            }}>
              ⚠ {alerts}
            </span>
          )}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: '.04em' }}>
          {items.length} leitura{items.length !== 1 ? 's' : ''} recente{items.length !== 1 ? 's' : ''}
          {liveStatus === 'live' ? ' · atualização automática' : liveStatus === 'offline' ? ' · sem conexão' : ' · conectando…'}
        </div>
      </div>

      {/* List */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '8px',
        display: 'flex', flexDirection: 'column', gap: 5,
      }}>
        {items.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            Aguardando novas leituras…
          </div>
        ) : items.map(det => (
          <FeedItem key={det.id} det={det} fresh={isNew(det.detectado_em, 60)} />
        ))}
      </div>
    </div>
  )
}

// ── Grid Card ─────────────────────────────────────────────────────────────────

function DetCard({ det, isNewest }: { det: Deteccao; isNewest: boolean }) {
  const [open, setOpen] = useState(false)
  const imgUrl  = storageUrl(det.caminho_storage)
  const alert   = det.watchlist_hit
  const conf    = det.confianca_final
  const confColor = conf > .85 ? '#4ade80' : conf > .6 ? '#fbbf24' : '#f87171'

  return (
    <>
      <div
        onClick={() => setOpen(true)}
        style={{
          background: 'var(--surface)', borderRadius: 12, overflow: 'hidden',
          cursor: 'pointer', position: 'relative',
          border: `1.5px solid ${alert ? '#ef444450' : isNewest ? '#6366f140' : 'var(--border)'}`,
          boxShadow: alert ? '0 0 0 1px #ef444430, 0 4px 20px #ef444418' : 'none',
          transition: 'transform .15s, box-shadow .15s',
        }}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLElement
          el.style.transform = 'translateY(-3px)'
          el.style.boxShadow = alert
            ? '0 0 0 1px #ef444450, 0 12px 32px #ef444428'
            : '0 8px 28px rgba(0,0,0,.2)'
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLElement
          el.style.transform = 'translateY(0)'
          el.style.boxShadow = alert ? '0 0 0 1px #ef444430, 0 4px 20px #ef444418' : 'none'
        }}
      >
        {/* Image 16:9 */}
        <div style={{ position: 'relative', aspectRatio: '16/9', background: '#080808', overflow: 'hidden' }}>
          {imgUrl ? (
            <img
              src={imgUrl} alt={det.placa || 'sem placa'}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transition: 'transform .3s' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'rgba(255,255,255,.15)' }}>
              <Ic d="M23 7l-7 5 7 5V7z M1 5h14a2 2 0 012 2v10a2 2 0 01-2 2H1a2 2 0 01-2-2V7a2 2 0 012-2z" size={28} color="rgba(255,255,255,.12)" />
              <span style={{ fontSize: 11 }}>Sem imagem</span>
            </div>
          )}

          {/* Bottom gradient */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: '65%',
            background: 'linear-gradient(to top, rgba(0,0,0,.92) 0%, rgba(0,0,0,.4) 60%, transparent 100%)',
          }} />

          {/* Plate — center bottom */}
          <div style={{ position: 'absolute', bottom: 10, left: 10 }}>
            <PlacaTag placa={det.placa} size="md" />
          </div>

          {/* Confidence — bottom right */}
          {conf > 0 && (
            <div style={{
              position: 'absolute', bottom: 10, right: 10,
              background: 'rgba(0,0,0,.7)', borderRadius: 6, padding: '2px 7px',
              fontSize: 11, fontWeight: 700, color: confColor,
              border: `1px solid ${confColor}40`,
            }}>
              {(conf * 100).toFixed(0)}%
            </div>
          )}

          {/* Top badges */}
          <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 5 }}>
            {isNewest && !alert && (
              <span style={{ background: '#6366f1cc', color: '#fff', borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '.04em' }}>
                NOVO
              </span>
            )}
            {alert && (
              <span style={{ background: '#ef4444cc', color: '#fff', borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '.04em' }}>
                ⚠ ALERTA
              </span>
            )}
            {det.divergencia && (
              <span style={{ background: '#f59e0bcc', color: '#fff', borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 800 }}>
                DIV
              </span>
            )}
          </div>

          {/* Source + Validated badges */}
          <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            {det.fonte === 'intelbras_api' && (
              <span style={{ background: 'rgba(16,185,129,.85)', color: '#fff', borderRadius: 5, padding: '2px 7px', fontSize: 9, fontWeight: 800, letterSpacing: '.04em' }}>
                INTELBRAS
              </span>
            )}
            {det.validado && (
              <span style={{ background: 'rgba(34,197,94,.85)', color: '#fff', borderRadius: 5, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>✓</span>
            )}
          </div>

          {/* Conf bar at very bottom */}
          {conf > 0 && (
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(0,0,0,.5)' }}>
              <div style={{ height: '100%', width: `${conf * 100}%`, background: confColor, transition: 'width .3s' }} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '9px 11px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {det.camera_nome || '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'monospace', marginTop: 1 }}>
              {fmtTs(det.detectado_em)}
            </div>
          </div>
          {det.tempo_processo_ms && (
            <span style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
              {det.tempo_processo_ms}ms
            </span>
          )}
        </div>
      </div>

      {open && createPortal(<Lightbox det={det} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

// ── List row ──────────────────────────────────────────────────────────────────

function DetRow({ det, isNewest }: { det: Deteccao; isNewest: boolean }) {
  const [open, setOpen] = useState(false)
  const imgUrl = storageUrl(det.caminho_storage)
  const alert  = det.watchlist_hit

  return (
    <>
      <tr
        onClick={() => setOpen(true)}
        style={{
          cursor: 'pointer',
          background: alert ? 'rgba(239,68,68,.05)' : isNewest ? 'rgba(99,102,241,.04)' : undefined,
          borderLeft: `3px solid ${alert ? '#ef4444' : isNewest ? '#6366f1' : 'transparent'}`,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface2)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = alert ? 'rgba(239,68,68,.05)' : isNewest ? 'rgba(99,102,241,.04)' : '' }}
      >
        <td style={{ padding: '6px 10px', width: 64 }}>
          {imgUrl ? (
            <div style={{ width: 52, height: 36, borderRadius: 5, overflow: 'hidden', background: '#111' }}>
              <img src={imgUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
            </div>
          ) : (
            <div style={{ width: 52, height: 36, borderRadius: 5, background: 'var(--surface3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Ic d="M15 10l-4 4l6 6l4-16l-18 6l4 4l2 3z" size={14} color="var(--text3)" />
            </div>
          )}
        </td>
        <td style={{ padding: '6px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, fontWeight: 800, letterSpacing: 2, color: det.placa ? 'var(--text)' : 'var(--text3)' }}>
              {det.placa || '—'}
            </span>
            {det.divergencia && <span style={{ fontSize: 10, background: 'rgba(245,158,11,.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.3)', borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>DIV</span>}
          </div>
        </td>
        <td style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text2)' }}>{det.camera_nome}</td>
        <td style={{ padding: '6px 10px' }}><ConfPill v={det.confianca_final} /></td>
        <td style={{ padding: '6px 10px' }}>
          {det.validado
            ? <span style={{ fontSize: 10, background: 'rgba(34,197,94,.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,.3)', borderRadius: 4, padding: '2px 7px', fontWeight: 700 }}>✓ OK</span>
            : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}
        </td>
        <td style={{ padding: '6px 10px' }}>
          {alert
            ? <span style={{ fontSize: 10, background: 'rgba(239,68,68,.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,.3)', borderRadius: 4, padding: '2px 7px', fontWeight: 700 }}>⚠ {det.watchlist_tipo || 'Alerta'}</span>
            : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}
        </td>
        <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text3)', fontFamily: 'monospace' }}>
          {det.tempo_processo_ms ? `${det.tempo_processo_ms}ms` : '—'}
        </td>
        <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
          {fmtTs(det.detectado_em)}
        </td>
      </tr>
      {open && createPortal(<Lightbox det={det} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

// ── LPR Timeline (collapsible) ────────────────────────────────────────────────

const PERIODOS = ['6h', '24h', '7d', '30d'] as const

function LprTimeline({ cameraId }: { cameraId?: number }) {
  const [periodo, setPeriodo] = useState<string>('24h')
  const [rows, setRows]       = useState<LprTimelineRow[]>([])
  const [pico, setPico]       = useState(0)
  const [loading, setLoading] = useState(true)
  const [open, setOpen]       = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    const params: Record<string, unknown> = { periodo }
    if (cameraId) params.camera_id = cameraId
    getLprTimeline(params)
      .then(r => { setRows(r.data.data); setPico(r.data.pico_leituras) })
      .finally(() => setLoading(false))
  }, [periodo, cameraId, open])

  const totalMax = Math.max(...rows.map(r => r.total), 1)

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: {payload: LprTimelineRow}[] }) => {
    if (!active || !payload?.length) return null
    const d = payload[0]?.payload
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, boxShadow: '0 4px 20px #0003' }}>
        <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>{fmtTlTs(d.ts, periodo)}</div>
        <div style={{ color: 'var(--text2)' }}>Total: <b style={{ color: 'var(--text)' }}>{d.total.toLocaleString()}</b></div>
        <div style={{ color: 'var(--primary)' }}>Com placa: <b>{d.com_placa}</b></div>
        {d.watchlist > 0 && <div style={{ color: '#ef4444' }}>⚠ Watchlist: <b>{d.watchlist}</b></div>}
        {d.divergencias > 0 && <div style={{ color: '#f59e0b' }}>Divergências: <b>{d.divergencias}</b></div>}
        <div style={{ color: 'var(--text3)', marginTop: 4 }}>Conf. média: <b>{Number(d.confianca_media).toFixed(1)}%</b></div>
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen(o => !o)}
      >
        <Ic d="M18 20V10 M12 20V4 M6 20v-6" size={13} color="var(--primary)" />
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1, color: 'var(--text)' }}>Fluxo de Leituras</span>
        {open && rows.length > 0 && (
          <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
            {PERIODOS.map(p => (
              <button key={p} onClick={() => setPeriodo(p)} style={{
                padding: '2px 9px', borderRadius: 6, border: '1px solid var(--border)',
                cursor: 'pointer', fontSize: 11, fontWeight: periodo === p ? 700 : 400,
                background: periodo === p ? 'var(--primary)' : 'transparent',
                color: periodo === p ? '#fff' : 'var(--text2)',
              }}>{p}</button>
            ))}
          </div>
        )}
        <Ic d={open ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} size={13} color="var(--text3)" />
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          {loading ? (
            <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="spinner" />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>
              Sem leituras no período
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={190} minWidth={0}>
                <ComposedChart data={rows} margin={{ top: 4, right: 28, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="ts" tickFormatter={v => fmtTlTs(v, periodo)}
                    tick={{ fontSize: 10, fill: 'var(--text3)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="placas" tick={{ fontSize: 10, fill: 'var(--text3)' }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                  <YAxis yAxisId="conf" orientation="right" domain={[0, 100]}
                    tick={{ fontSize: 10, fill: 'var(--text3)' }} tickFormatter={v => `${v}%`} axisLine={false} tickLine={false} width={36} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--surface2)' }} />
                  <Bar yAxisId="placas" dataKey="total" maxBarSize={28} radius={[2,2,0,0]}>
                    {rows.map((r, i) => <Cell key={i} fill={r.total >= totalMax * 0.6 ? 'rgba(99,102,241,.2)' : 'rgba(99,102,241,.1)'} />)}
                  </Bar>
                  <Bar yAxisId="placas" dataKey="com_placa" maxBarSize={18} radius={[4,4,0,0]}>
                    {rows.map((r, i) => <Cell key={i} fill={r.watchlist > 0 ? '#ef4444' : r.com_placa > 0 ? 'var(--primary)' : 'rgba(99,102,241,.2)'} />)}
                  </Bar>
                  <Line yAxisId="conf" dataKey="confianca_media" type="monotone"
                    stroke="#a78bfa" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
                  {pico > 0 && (
                    <ReferenceLine yAxisId="placas" y={pico} stroke="rgba(99,102,241,.3)" strokeDasharray="4 4"
                      label={{ value: `pico ${pico}`, position: 'right', fontSize: 9, fill: 'var(--text3)' }} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--text2)', flexWrap: 'wrap' }}>
                {[
                  { color: 'rgba(99,102,241,.2)', label: 'Volume' },
                  { color: 'var(--primary)', label: 'Placas lidas' },
                  { color: '#ef4444', label: 'Com alerta' },
                  { color: '#a78bfa', label: 'Confiança', line: true },
                ].map(l => (
                  <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ display: 'inline-block', width: l.line ? 14 : 10, height: l.line ? 2 : 10, background: l.color, borderRadius: l.line ? 1 : 2 }} />
                    {l.label}
                  </span>
                ))}
                <span style={{ marginLeft: 'auto', color: 'var(--text3)' }}>
                  {rows.reduce((s, r) => s + r.com_placa, 0)} placas · {rows.reduce((s, r) => s + r.total, 0).toLocaleString()} leituras
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Camera Activity Panel (collapsible) ───────────────────────────────────────

function CameraActivityPanel() {
  const [cams, setCams]   = useState<CameraLprActivity[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen]   = useState(false)

  const reload = () => {
    getLprActivity().then(r => setCams(r.data)).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { reload(); const t = setInterval(reload, 30_000); return () => clearInterval(t) }, [])

  if (loading || cams.length === 0) return null

  const online = cams.filter(c => c.ultima_imagem_sftp && (Date.now() - new Date(c.ultima_imagem_sftp).getTime()) < 300_000).length

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setOpen(o => !o)}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: online > 0 ? '#22c55e' : '#6b7280', boxShadow: online > 0 ? '0 0 6px #22c55e88' : 'none' }} />
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1, color: 'var(--text)' }}>Câmeras LPR</span>
        <span style={{ fontSize: 11, color: online > 0 ? '#22c55e' : 'var(--text3)', fontWeight: 600 }}>{online}/{cams.length} ativas</span>
        <Ic d={open ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} size={13} color="var(--text3)" />
      </div>

      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8, marginTop: 12 }}>
          {cams.map(cam => {
            const lastSeen = cam.ultima_imagem_sftp ? (Date.now() - new Date(cam.ultima_imagem_sftp).getTime()) / 1000 : null
            const onl = lastSeen !== null && lastSeen < 300
            const rec = lastSeen !== null && lastSeen < 3600
            return (
              <div key={cam.id} style={{
                background: 'var(--surface2)', borderRadius: 8,
                border: `1px solid ${onl ? 'rgba(34,197,94,.3)' : rec ? 'rgba(245,158,11,.25)' : 'var(--border)'}`,
                padding: '10px 12px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: onl ? '#22c55e' : rec ? '#f59e0b' : '#6b7280', boxShadow: onl ? '0 0 6px #22c55e88' : 'none' }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{cam.nome}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cam.local}</div>
                <div style={{ display: 'flex', gap: 10, fontSize: 11 }}>
                  <div>
                    <div style={{ color: 'var(--text3)', fontSize: 10 }}>ÚLTIMA</div>
                    <div style={{ color: onl ? '#22c55e' : rec ? '#f59e0b' : 'var(--text2)', fontWeight: 600 }}>{timeSince(cam.ultima_imagem_sftp)}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text3)', fontSize: 10 }}>1H / 24H</div>
                    <div style={{ color: 'var(--text)', fontWeight: 600 }}>{cam.deteccoes_1h} / {cam.deteccoes_24h}</div>
                  </div>
                  {cam.alertas_24h > 0 && (
                    <div>
                      <div style={{ color: 'var(--text3)', fontSize: 10 }}>ALERTAS</div>
                      <div style={{ color: '#ef4444', fontWeight: 700 }}>{cam.alertas_24h}</div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Stats row ─────────────────────────────────────────────────────────────────

function StatsRow({ stats }: { stats: Stats }) {
  const items = [
    { label: 'Últimas 24h', value: stats.total_24h.toLocaleString(), color: 'var(--primary)' },
    { label: 'Última 1h',   value: stats.total_1h.toLocaleString(),  color: 'var(--text)' },
    { label: 'Alertas 24h', value: stats.watchlist_hits_24h.toLocaleString(), color: stats.watchlist_hits_24h > 0 ? '#ef4444' : 'var(--text)' },
    { label: 'Divergências', value: stats.divergencias_24h.toLocaleString(), color: stats.divergencias_24h > 0 ? '#f59e0b' : 'var(--text)' },
    { label: 'Tempo médio', value: stats.tempo_medio_ms ? `${stats.tempo_medio_ms}ms` : '—', color: 'var(--text)' },
  ]
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
      {items.map(s => (
        <div key={s.label} style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '10px 16px',
          display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 100,
        }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase' }}>{s.label}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
        </div>
      ))}
    </div>
  )
}

// ── Filter bar (compact) ──────────────────────────────────────────────────────

function FilterBar({ filters, setFilter, cameras, onClear, hasFilters }: {
  filters: Record<string, string>
  setFilter: (k: string, v: string) => void
  cameras: Camera[]
  onClear: () => void
  hasFilters: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const inp: React.CSSProperties = { padding: '6px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, outline: 'none', width: '100%' }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Ic d="M3 6h18M6 12h12M9 18h6" size={13} color="var(--text3)" />
        <span style={{ fontSize: 13, fontWeight: 700, flex: 1, color: 'var(--text)' }}>Filtros</span>
        {hasFilters && (
          <button onClick={onClear} style={{ fontSize: 11, color: '#ef4444', background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 600 }}>
            ✕ Limpar
          </button>
        )}
        <button onClick={() => setExpanded(e => !e)} style={{ fontSize: 12, color: 'var(--text2)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 7, padding: '4px 10px', cursor: 'pointer' }}>
          {expanded ? 'Ocultar' : hasFilters ? '● Filtros ativos' : 'Expandir'}
        </button>
      </div>

      {/* Quick filters - always visible */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <input style={{ ...inp, minWidth: 140, flex: 2 }} placeholder="🔍 Buscar placa…"
          value={filters.placa} onChange={e => setFilter('placa', e.target.value)} />
        <select style={{ ...inp, flex: 2, minWidth: 160 }} value={filters.camera_id} onChange={e => setFilter('camera_id', e.target.value)}>
          <option value="">Todas as câmeras</option>
          {cameras.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
        <select style={{ ...inp, flex: 1, minWidth: 120 }} value={filters.watchlist_hit} onChange={e => setFilter('watchlist_hit', e.target.value)}>
          <option value="">Qualquer alerta</option>
          <option value="true">⚠ Watchlist hits</option>
          <option value="false">Sem alerta</option>
        </select>
        <select style={{ ...inp, flex: 1, minWidth: 110 }} value={filters.apenas_com_placa} onChange={e => setFilter('apenas_com_placa', e.target.value)}>
          <option value="">Todos</option>
          <option value="true">Com placa</option>
        </select>
      </div>

      {/* Advanced filters */}
      {expanded && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <select style={{ ...inp, minWidth: 110 }} value={filters.validado} onChange={e => setFilter('validado', e.target.value)}>
            <option value="">Validação</option>
            <option value="true">✓ Validados</option>
            <option value="false">Não validados</option>
          </select>
          <select style={{ ...inp, minWidth: 120 }} value={filters.confianca_minima} onChange={e => setFilter('confianca_minima', e.target.value)}>
            <option value="">Confiança</option>
            <option value="50">≥ 50%</option>
            <option value="70">≥ 70%</option>
            <option value="85">≥ 85%</option>
            <option value="95">≥ 95%</option>
          </select>
          <select style={{ ...inp, minWidth: 140 }} value={filters.fonte} onChange={e => setFilter('fonte', e.target.value)}>
            <option value="">Todas as fontes</option>
            <option value="intelbras_api">Intelbras API</option>
            <option value="sftp_pillar">SFTP Pillar</option>
            <option value="sftp_legado">SFTP Legado</option>
            <option value="reprocessamento">Reprocessamento</option>
          </select>
          <input style={{ ...inp, minWidth: 130 }} type="date" value={filters.data_inicio} onChange={e => setFilter('data_inicio', e.target.value)} title="Data início" />
          <input style={{ ...inp, minWidth: 130 }} type="date" value={filters.data_fim} onChange={e => setFilter('data_fim', e.target.value)} title="Data fim" />
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Deteccoes() {
  const [data, setData]         = useState<Deteccao[]>([])
  const [liveItems, setLiveItems] = useState<Deteccao[]>([])
  const [total, setTotal]       = useState(0)
  const [stats, setStats]       = useState<Stats | null>(null)
  const [cameras, setCameras]   = useState<Camera[]>([])
  const [loading, setLoading]   = useState(true)
  const [offset, setOffset]     = useState(0)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const [liveStatus, setLiveStatus]   = useState<'connecting' | 'live' | 'offline'>('connecting')
  const [pendingCount, setPendingCount] = useState(0)

  const [filters, setFilters] = useState({
    placa: '', camera_id: '', watchlist_hit: '', validado: '',
    data_inicio: '', data_fim: '', confianca_minima: '', apenas_com_placa: '', fonte: '',
  })

  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const offsetRef  = useRef(0)
  const filtersRef = useRef(filters)

  const { alert: watchlistAlert, prefs: watchlistPrefs, toggleSound: twSound, toggleVisual: twVisual, dismiss: twDismiss } = useModuleAlerts({
    moduleKey: 'lpr_watchlist', eventTypes: ['nova_leitura'],
    filterEvent: (e) => !!(e.watchlist_hit),
    buildMessage: (e) => `Placa ${e.placa || '—'} detectada na Watchlist`, sirenDuration: 6,
  })
  const { alert: divergenciaAlert, prefs: divPrefs, toggleSound: tdSound, toggleVisual: tdVisual, dismiss: tdDismiss } = useModuleAlerts({
    moduleKey: 'lpr_divergencia', eventTypes: ['nova_leitura'],
    filterEvent: (e) => !!(e.divergencia),
    buildMessage: (e) => `Divergência detectada — placa ${e.placa || '—'}`, sirenDuration: 4,
  })

  const loadStats = useCallback(async () => {
    try { const r = await getDeteccaoStats(); setStats(r.data) } catch {}
  }, [])

  const loadLive = useCallback(async () => {
    try {
      const r = await getDeteccoes({ limit: 20, offset: 0 })
      setLiveItems(r.data.data)
    } catch {}
  }, [])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const f   = filtersRef.current
      const off = offsetRef.current
      const params: Record<string, unknown> = { limit: LIMIT, offset: off }
      if (f.placa)            params.placa            = f.placa
      if (f.camera_id)        params.camera_id        = +f.camera_id
      if (f.watchlist_hit)    params.watchlist_hit    = f.watchlist_hit === 'true'
      if (f.validado)         params.validado         = f.validado === 'true'
      if (f.data_inicio)      params.data_inicio      = f.data_inicio
      if (f.data_fim)         params.data_fim         = f.data_fim
      if (f.confianca_minima) params.confianca_minima = +f.confianca_minima / 100
      if (f.apenas_com_placa) params.apenas_com_placa = f.apenas_com_placa === 'true'
      if (f.fonte)            params.fonte            = f.fonte
      const r = await getDeteccoes(params)
      setData(r.data.data)
      setTotal(r.data.total)
      setLastRefresh(new Date())
      setPendingCount(0)
    } finally { if (!silent) setLoading(false) }
  }, [])

  useEffect(() => { filtersRef.current = filters }, [filters])
  useEffect(() => { offsetRef.current = offset }, [offset])

  useEffect(() => {
    getCameras().then(r => setCameras(r.data.data.filter((c: Camera) => c.ativa && c.rec_lpr)))
    loadStats()
    loadLive()
  }, [loadStats, loadLive])

  useEffect(() => { load() }, [offset, filters])

  useEffect(() => {
    timerRef.current = setInterval(() => { load(true); loadStats(); loadLive() }, 30_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [load, loadStats, loadLive])

  // SSE
  useEffect(() => {
    const base = (import.meta.env.VITE_API_URL ?? '') as string
    const es = new EventSource(`${base}/api/v1/stream`)
    es.onopen  = () => setLiveStatus('live')
    es.onerror = () => setLiveStatus('offline')
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'connected') { setLiveStatus('live'); return }
        if (msg.type === 'nova_leitura') {
          loadLive()
          if (offsetRef.current === 0) {
            load(true)
          } else {
            setPendingCount(n => n + (msg.count ?? 1))
          }
        }
      } catch {}
    }
    return () => es.close()
  }, [load, loadLive])

  const setFilter = (k: string, v: string) => {
    setFilters(f => ({ ...f, [k]: v }))
    setOffset(0)
  }

  const clearFilters = () => {
    setFilters({ placa: '', camera_id: '', watchlist_hit: '', validado: '', data_inicio: '', data_fim: '', confianca_minima: '', apenas_com_placa: '', fonte: '' })
    setOffset(0)
  }

  const pages = Math.ceil(total / LIMIT)
  const page  = Math.floor(offset / LIMIT)
  const hasFilters = Object.values(filters).some(v => v !== '')

  return (
    <div className="page">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            Leitura LPR
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
              background: liveStatus === 'live' ? 'rgba(34,197,94,.12)' : liveStatus === 'offline' ? 'rgba(239,68,68,.12)' : 'rgba(99,102,241,.12)',
              border: `1px solid ${liveStatus === 'live' ? 'rgba(34,197,94,.3)' : liveStatus === 'offline' ? 'rgba(239,68,68,.3)' : 'rgba(99,102,241,.3)'}`,
              borderRadius: 20, padding: '2px 10px',
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: liveStatus === 'live' ? '#22c55e' : liveStatus === 'offline' ? '#ef4444' : '#818cf8',
                animation: liveStatus === 'live' ? 'pulse-dot 1.8s ease-in-out infinite' : 'none',
              }} />
              {liveStatus === 'live' ? 'AO VIVO' : liveStatus === 'offline' ? 'OFFLINE' : 'CONECTANDO'}
            </span>
          </div>
          <div className="page-subtitle">
            {total.toLocaleString()} registro(s) · atualizado às {format(lastRefresh, 'HH:mm:ss')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', background: 'var(--surface2)', borderRadius: 8, padding: 3, gap: 2 }}>
            {(['grid', 'list'] as const).map(m => (
              <button key={m} onClick={() => setViewMode(m)} style={{
                padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: viewMode === m ? 'var(--surface)' : 'transparent',
                color: viewMode === m ? 'var(--primary)' : 'var(--text3)',
                boxShadow: viewMode === m ? '0 1px 3px rgba(0,0,0,.15)' : 'none',
              }}>
                {m === 'grid' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                )}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost" onClick={() => { load(); loadStats(); loadLive() }} disabled={loading}>
            {loading ? <span className="spinner" style={{ width: 13, height: 13 }} /> : '↻ Atualizar'}
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && <StatsRow stats={stats} />}

      {/* Alert banners */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: stats ? 14 : 0 }}>
        <ModuleAlertBanner alert={watchlistAlert} soundEnabled={watchlistPrefs.sound} visualEnabled={watchlistPrefs.visual} onToggleSound={twSound} onToggleVisual={twVisual} onDismiss={twDismiss} accentColor="#ef4444" />
        <ModuleAlertBanner alert={divergenciaAlert} soundEnabled={divPrefs.sound} visualEnabled={divPrefs.visual} onToggleSound={tdSound} onToggleVisual={tdVisual} onDismiss={tdDismiss} accentColor="#f59e0b" />
      </div>

      {/* ── Two-column layout: live feed + main ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, alignItems: 'start' }}>

        {/* Live feed */}
        <LiveFeedPanel items={liveItems} liveStatus={liveStatus} />

        {/* Main panel */}
        <div style={{ minWidth: 0 }}>

          <CameraActivityPanel />
          <LprTimeline cameraId={filters.camera_id ? +filters.camera_id : undefined} />

          {pendingCount > 0 && (
            <div
              onClick={() => { setOffset(0); load() }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: 'rgba(99,102,241,.12)', border: '1px solid rgba(99,102,241,.3)',
                borderRadius: 8, padding: '9px 16px', marginBottom: 12, cursor: 'pointer',
                fontSize: 13, fontWeight: 600, color: 'var(--primary)',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,.2)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(99,102,241,.12)')}
            >
              ↑ {pendingCount} nova{pendingCount > 1 ? 's' : ''} leitura{pendingCount > 1 ? 's' : ''} — clique para ver
            </div>
          )}

          <FilterBar
            filters={filters} setFilter={setFilter}
            cameras={cameras} onClear={clearFilters} hasFilters={hasFilters}
          />

          {/* Content */}
          {loading && data.length === 0 ? (
            <div className="empty-state"><div className="spinner" /></div>
          ) : data.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Ic d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" size={28} color="var(--text3)" />
              </div>
              <div>Nenhuma leitura encontrada</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
                As leituras aparecem aqui conforme as câmeras enviam imagens via SFTP
              </div>
            </div>
          ) : viewMode === 'grid' ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 12, marginBottom: 16,
              opacity: loading ? .6 : 1, transition: 'opacity .2s',
            }}>
              {data.map((d, i) => <DetCard key={d.id} det={d} isNewest={i === 0 && offset === 0} />)}
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 16, opacity: loading ? .6 : 1, transition: 'opacity .2s' }}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 64 }}>Foto</th>
                      <th>Placa</th>
                      <th>Câmera</th>
                      <th style={{ width: 80 }}>Conf.</th>
                      <th style={{ width: 80 }}>Status</th>
                      <th>Alerta</th>
                      <th style={{ width: 80 }}>Tempo</th>
                      <th style={{ width: 150 }}>Detectado em</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((d, i) => <DetRow key={d.id} det={d} isNewest={i === 0 && offset === 0} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pagination */}
          {pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', marginBottom: 8 }}>
              <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setOffset(o => o - LIMIT)}>← Anterior</button>
              <span style={{ fontSize: 12, color: 'var(--text2)', padding: '0 8px' }}>
                Página {page + 1} de {pages} · {total.toLocaleString()} registros
              </span>
              <button className="btn btn-ghost btn-sm" disabled={page >= pages - 1} onClick={() => setOffset(o => o + LIMIT)}>Próximo →</button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes feed-slide-in {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse-dot {
          0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,.5); }
          50%       { box-shadow: 0 0 0 5px rgba(34,197,94,0); }
        }
      `}</style>
    </div>
  )
}
