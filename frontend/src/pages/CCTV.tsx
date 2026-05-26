import { useEffect, useRef, useState } from 'react'
import api from '../api'
import type { Camera } from '../api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function streamUrl(camId: number, type: 'snapshot' | 'mjpeg') {
  const token = localStorage.getItem('api_key') ?? ''
  const base  = (import.meta.env.VITE_API_URL ?? '')
  return `${base}/api/v1/cameras/${camId}/${type}?token=${encodeURIComponent(token)}`
}

function hasStream(cam: Camera) {
  if (cam.protocolo === 'rtsp' && cam.url_stream) return true
  if (cam.protocolo === 'rtmp' && cam.url_stream) return true
  return false
}

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color = status === 'online' ? '#22c55e'
    : status === 'offline' || status === 'erro' ? '#ef4444'
    : '#94a3b8'
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7,
      borderRadius: '50%', background: color, flexShrink: 0,
      boxShadow: status === 'online' ? `0 0 0 2px ${color}33` : 'none',
    }} />
  )
}

// ── Camera tile ───────────────────────────────────────────────────────────────

function CamTile({
  cam,
  active,
  live,
  onExpand,
}: {
  cam: Camera
  active: boolean
  live: boolean
  onExpand: (cam: Camera) => void
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const streamable = hasStream(cam)
  const src = streamable
    ? (live ? streamUrl(cam.id, 'mjpeg') : streamUrl(cam.id, 'snapshot'))
    : null

  useEffect(() => {
    setError(false)
    setLoaded(false)
  }, [cam.id, live])

  // Snapshot polling every 5s when not live
  useEffect(() => {
    if (!streamable || live || !imgRef.current) return
    const tick = () => {
      if (imgRef.current) {
        imgRef.current.src = streamUrl(cam.id, 'snapshot') + '&_t=' + Date.now()
      }
    }
    const t = setInterval(tick, 5000)
    return () => clearInterval(t)
  }, [cam.id, live, streamable])

  return (
    <div
      style={{
        position: 'relative', borderRadius: 10, overflow: 'hidden',
        background: '#0a0a0f',
        border: active ? '2px solid var(--primary)' : '1px solid #1e1e2e',
        cursor: streamable ? 'pointer' : 'default',
        aspectRatio: '16/9',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={() => streamable && onExpand(cam)}
    >
      {/* Video feed */}
      {streamable && !error ? (
        <img
          ref={imgRef}
          src={src!}
          alt={cam.nome}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            display: loaded ? 'block' : 'none',
          }}
        />
      ) : null}

      {/* Loading / no-stream placeholder */}
      {(!loaded || error) && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 8, color: '#3a3a5c',
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            {error || !streamable
              ? <><path d="M1 1l22 22M17 6H3a2 2 0 00-2 2v8a2 2 0 002 2h14M7 3h7l3 3" /><path d="M23 7v10a2 2 0 01-2 2" /></>
              : <><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></>
            }
          </svg>
          <span style={{ fontSize: 11, textAlign: 'center', padding: '0 8px' }}>
            {error ? 'Stream indisponível'
              : !streamable ? 'Sem stream ao vivo'
              : 'Conectando…'}
          </span>
        </div>
      )}

      {/* Overlay: name + status */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: '20px 10px 7px',
        background: 'linear-gradient(transparent, rgba(0,0,0,.75))',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <StatusDot status={cam.status_conexao} />
          <span style={{
            fontSize: 11, fontWeight: 600, color: '#e2e8f0',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{cam.nome}</span>
        </div>
        {live && loaded && !error && (
          <span style={{
            fontSize: 9, fontWeight: 800, color: '#ef4444',
            background: 'rgba(239,68,68,.2)', padding: '1px 5px',
            borderRadius: 3, letterSpacing: '.08em', border: '1px solid rgba(239,68,68,.4)',
            flexShrink: 0,
          }}>AO VIVO</span>
        )}
      </div>

      {/* Expand icon on hover */}
      {streamable && (
        <div style={{
          position: 'absolute', top: 7, right: 7,
          background: 'rgba(0,0,0,.5)', borderRadius: 5, padding: 4,
          opacity: 0.7,
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="#fff" strokeWidth="2" strokeLinecap="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </div>
      )}
    </div>
  )
}

// ── Fullscreen modal ──────────────────────────────────────────────────────────

function FullscreenModal({ cam, onClose }: { cam: Camera; onClose: () => void }) {
  const [error, setError] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(0,0,0,.92)', backdropFilter: 'blur(4px)',
      display: 'flex', flexDirection: 'column',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px', borderBottom: '1px solid #1e1e2e',
        background: '#08080f',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StatusDot status={cam.status_conexao} />
          <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0' }}>{cam.nome}</span>
          <span style={{ fontSize: 11, color: '#64748b' }}>{cam.local}</span>
          <span style={{
            fontSize: 9, fontWeight: 800, color: '#ef4444',
            background: 'rgba(239,68,68,.15)', padding: '2px 7px',
            borderRadius: 4, letterSpacing: '.08em', border: '1px solid rgba(239,68,68,.3)',
          }}>AO VIVO</span>
        </div>
        <button onClick={onClose} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
          background: 'rgba(255,255,255,.08)', border: '1px solid #2a2a3e', color: '#94a3b8',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Stream */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}>
        {error ? (
          <div style={{ color: '#64748b', textAlign: 'center', fontSize: 14 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📷</div>
            Stream indisponível no momento
          </div>
        ) : (
          <img
            src={streamUrl(cam.id, 'mjpeg')}
            alt={cam.nome}
            onError={() => setError(true)}
            style={{
              maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
              borderRadius: 8,
            }}
          />
        )}
      </div>

      {/* Footer info */}
      <div style={{
        padding: '8px 20px', borderTop: '1px solid #1e1e2e',
        background: '#08080f', fontSize: 11, color: '#475569',
        display: 'flex', gap: 20,
      }}>
        <span>Protocolo: <strong style={{ color: '#94a3b8' }}>{cam.protocolo.toUpperCase()}</strong></span>
        {cam.resolucao && <span>Resolução: <strong style={{ color: '#94a3b8' }}>{cam.resolucao}</strong></span>}
        {cam.fps && <span>FPS: <strong style={{ color: '#94a3b8' }}>{cam.fps}</strong></span>}
        {cam.fabricante && <span>Fabricante: <strong style={{ color: '#94a3b8' }}>{cam.fabricante}</strong></span>}
        <span style={{ marginLeft: 'auto' }}>Pressione ESC para fechar</span>
      </div>
    </div>
  )
}

// ── Layout configs ────────────────────────────────────────────────────────────

const LAYOUTS = [
  { cols: 1, label: '1×1', icon: 'M3 3h18v18H3z' },
  { cols: 2, label: '2×2', icon: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },
  { cols: 3, label: '3×3', icon: 'M3 3h5v5H3zM9.5 3h5v5h-5zM16 3h5v5h-5zM3 9.5h5v5H3zM9.5 9.5h5v5h-5zM16 9.5h5v5h-5zM3 16h5v5H3zM9.5 16h5v5h-5zM16 16h5v5h-5z' },
  { cols: 4, label: '4×4', icon: 'M3 3h4v4H3zM9 3h4v4H9zM15 3h4v4h-4zM21 3h0v4h0zM3 9h4v4H3zM9 9h4v4H9zM15 9h4v4h-4zM3 15h4v4H3zM9 15h4v4H9zM15 15h4v4h-4z' },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CCTV() {
  const [cameras, setCameras]         = useState<Camera[]>([])
  const [loading, setLoading]         = useState(true)
  const [cols, setCols]               = useState(2)
  const [liveMode, setLiveMode]       = useState(false)
  const [selected, setSelected]       = useState<Set<number>>(new Set())
  const [expanded, setExpanded]       = useState<Camera | null>(null)
  const [filterStatus, setFilterStatus] = useState<'all' | 'online' | 'stream'>('all')

  useEffect(() => {
    api.get<{ total: number; data: Camera[] }>('/api/v1/cameras')
      .then(r => {
        const active = r.data.data.filter(c => c.ativa)
        setCameras(active)
        // pre-seleciona câmeras com stream
        const withStream = new Set(active.filter(hasStream).map(c => c.id))
        setSelected(withStream)
      })
      .finally(() => setLoading(false))
  }, [])

  const allCams = cameras.filter(c => {
    if (filterStatus === 'online') return c.status_conexao === 'online'
    if (filterStatus === 'stream') return hasStream(c)
    return true
  })

  const visibleCams = allCams.filter(c => selected.has(c.id))
  const onlineCount  = cameras.filter(c => c.status_conexao === 'online').length
  const streamCount  = cameras.filter(hasStream).length

  const toggleCam = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  if (loading) return <div className="page"><div className="empty-state"><div className="spinner" /></div></div>

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="page-title">Play CCTV</div>
          <div className="page-subtitle">
            {onlineCount} online · {streamCount} com stream · {cameras.length} câmeras ativas
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Live toggle */}
          <button
            onClick={() => setLiveMode(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', border: '1px solid',
              background: liveMode ? 'rgba(239,68,68,.12)' : 'transparent',
              borderColor: liveMode ? 'rgba(239,68,68,.4)' : 'var(--border)',
              color: liveMode ? '#ef4444' : 'var(--text2)',
              transition: 'all .15s',
            }}
          >
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: liveMode ? '#ef4444' : 'var(--text3)',
              boxShadow: liveMode ? '0 0 0 2px rgba(239,68,68,.3)' : 'none',
            }} />
            {liveMode ? 'MJPEG ao vivo' : 'Snapshot 5s'}
          </button>

          {/* Filter */}
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as typeof filterStatus)}
            style={{
              padding: '6px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--border)', background: 'var(--surface2)',
              color: 'var(--text)', cursor: 'pointer',
            }}
          >
            <option value="all">Todas</option>
            <option value="online">Somente online</option>
            <option value="stream">Com stream</option>
          </select>

          {/* Layout selector */}
          <div style={{
            display: 'flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
          }}>
            {LAYOUTS.map(l => (
              <button key={l.cols} title={`Grade ${l.label}`} onClick={() => setCols(l.cols)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 34, height: 32, cursor: 'pointer',
                background: cols === l.cols ? 'var(--primary-10, rgba(99,102,241,.15))' : 'transparent',
                border: 'none', borderRight: '1px solid var(--border)',
                color: cols === l.cols ? 'var(--primary)' : 'var(--text2)',
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d={l.icon} />
                </svg>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Body: sidebar + grid ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>

        {/* Camera list sidebar */}
        <div style={{
          width: 220, flexShrink: 0,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid var(--border)',
            fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
            textTransform: 'uppercase', color: 'var(--text2)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Câmeras</span>
            <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text3)' }}>
              {visibleCams.length}/{allCams.length}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
            {allCams.length === 0 ? (
              <div style={{ padding: '16px', fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>
                Nenhuma câmera
              </div>
            ) : allCams.map(cam => {
              const checked  = selected.has(cam.id)
              const canStream = hasStream(cam)
              return (
                <div
                  key={cam.id}
                  onClick={() => toggleCam(cam.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 14px', cursor: 'pointer',
                    background: checked ? 'var(--primary-10, rgba(99,102,241,.1))' : 'transparent',
                    transition: 'background .12s',
                  }}
                  onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = 'var(--surface2)' }}
                  onMouseLeave={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <StatusDot status={cam.status_conexao} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 11, fontWeight: 600,
                      color: checked ? 'var(--primary)' : 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{cam.nome}</div>
                    <div style={{ fontSize: 9, color: 'var(--text3)', display: 'flex', gap: 4, marginTop: 1 }}>
                      <span>{cam.protocolo.toUpperCase()}</span>
                      {!canStream && <span style={{ color: '#ef444488' }}>· sem stream</span>}
                    </div>
                  </div>
                  <div style={{
                    width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                    border: `1.5px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
                    background: checked ? 'var(--primary)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all .15s',
                  }}>
                    {checked && (
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
                        stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {/* Shortcuts */}
          <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', gap: 6 }}>
            <button
              onClick={() => setSelected(new Set(allCams.filter(hasStream).map(c => c.id)))}
              style={{ flex: 1, fontSize: 10, padding: '4px 0', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)' }}>
              Com stream
            </button>
            <button
              onClick={() => setSelected(new Set())}
              style={{ flex: 1, fontSize: 10, padding: '4px 0', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)' }}>
              Limpar
            </button>
          </div>
        </div>

        {/* Video grid */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {visibleCams.length === 0 ? (
            <div style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 10,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 12, color: 'var(--text2)',
            }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"
                style={{ opacity: .3 }}>
                <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
              <div style={{ fontSize: 13 }}>Selecione câmeras na lista para visualizar</div>
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: 8,
            }}>
              {visibleCams.map(cam => (
                <CamTile
                  key={cam.id}
                  cam={cam}
                  active={false}
                  live={liveMode}
                  onExpand={setExpanded}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Fullscreen modal */}
      {expanded && (
        <FullscreenModal cam={expanded} onClose={() => setExpanded(null)} />
      )}
    </div>
  )
}
