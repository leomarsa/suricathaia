import { useEffect, useRef, useState, useCallback } from 'react'
import api, { getAlarmTimeline, type AlarmTimelineRow } from '../api'
import { format } from 'date-fns'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AlarmConfig {
  camera_id: number; camera_nome: string; camera_local: string
  protocolo: string; status_conexao: string; ativo: boolean
  min_pessoas: number; cooldown_seg: number
  notif_sonoro: boolean; notif_whatsapp: boolean; notif_telegram: boolean
  destinatarios: string[]; notif_usuarios: number[]; mensagem_custom: string | null
  verificacao_yolo: boolean
  horario_inicio: string | null; horario_fim: string | null
  dias_semana: number[] | null
  alarmes_24h: number; ultimo_alarme: string | null
}

interface Operador {
  id: number; nome: string; email: string
  whatsapp: string | null; telegram: string | null
  cargo: string | null; ativo: boolean
}

interface AlarmEvent {
  id: number; camera_id: number; camera_nome: string
  total_pessoas: number; canais: string[]; detectado_em: string
  snapshot_url?: string | null
}

// ── Audio ─────────────────────────────────────────────────────────────────────

let _sirenCtx: AudioContext | null = null

// Desbloqueia AudioContext no primeiro gesto do usuário (política autoplay)
let _audioUnlocked = false
function _ensureAudioUnlocked() {
  if (_audioUnlocked) return
  _audioUnlocked = true
  try {
    const ctx = new AudioContext()
    const buf = ctx.createBuffer(1, 1, 22050)
    const src = ctx.createBufferSource()
    src.buffer = buf; src.connect(ctx.destination)
    src.start(0); src.stop(0.001)
    setTimeout(() => ctx.close(), 500)
  } catch { /* ignore */ }
}

function stopSiren() {
  try { _sirenCtx?.close() } catch { /* ignore */ }
  _sirenCtx = null
}

function playSiren(durationSec = 8, volume = 0.7) {
  stopSiren()
  try {
    const ctx = new AudioContext()
    _sirenCtx = ctx

    const master = ctx.createGain()
    master.gain.value = Math.max(0, Math.min(1, volume))
    master.connect(ctx.destination)

    // Two-tone siren: sweeps between low↔high repeatedly
    const CYCLES = Math.ceil(durationSec / 0.7)
    const cycleDur = durationSec / CYCLES

    for (let i = 0; i < CYCLES; i++) {
      const tStart = ctx.currentTime + i * cycleDur
      const tMid   = tStart + cycleDur * 0.45
      const tEnd   = tStart + cycleDur

      // Primary oscillator — siren sweep
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.connect(env); env.connect(master)
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(660, tStart)
      osc.frequency.linearRampToValueAtTime(1080, tMid)
      osc.frequency.linearRampToValueAtTime(660, tEnd)
      env.gain.setValueAtTime(0, tStart)
      env.gain.linearRampToValueAtTime(1, tStart + 0.04)
      env.gain.setValueAtTime(1, tEnd - 0.05)
      env.gain.linearRampToValueAtTime(0, tEnd)
      osc.start(tStart); osc.stop(tEnd)

      // Sub oscillator — adds body/urgency
      const sub = ctx.createOscillator()
      const subEnv = ctx.createGain()
      sub.connect(subEnv); subEnv.connect(master)
      sub.type = 'sine'
      sub.frequency.setValueAtTime(220, tStart)
      sub.frequency.linearRampToValueAtTime(360, tMid)
      sub.frequency.linearRampToValueAtTime(220, tEnd)
      subEnv.gain.value = 0.35
      sub.start(tStart); sub.stop(tEnd)
    }

    // Auto-stop after duration
    setTimeout(stopSiren, (durationSec + 0.2) * 1000)
  } catch { /* AudioContext blocked */ }
}

function playConfirmBeep(volume = 0.7) {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator(); const g = ctx.createGain()
    osc.connect(g); g.connect(ctx.destination)
    osc.type = 'sine'; osc.frequency.value = 880
    g.gain.setValueAtTime(Math.max(0, Math.min(1, volume)) * 0.3, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
    osc.start(); osc.stop(ctx.currentTime + 0.25)
  } catch { /* ignore */ }
}

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

const CHANNEL_LABEL: Record<string, { icon: string; color: string }> = {
  sonoro:   { icon: '♪', color: '#6366f1' },
  whatsapp: { icon: 'WA', color: '#25D366' },
  telegram: { icon: 'TG', color: '#229ED9' },
}

// ── Micro components ──────────────────────────────────────────────────────────

function Dot({ status }: { status: string }) {
  const c = status === 'online' ? '#22c55e' : status === 'offline' || status === 'erro' ? '#ef4444' : '#94a3b8'
  return <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, display: 'inline-block', flexShrink: 0, boxShadow: status === 'online' ? `0 0 0 3px ${c}28` : undefined }} />
}

function Badge({ label, color = 'var(--text2)', bg = 'var(--surface2)' }: { label: string; color?: string; bg?: string }) {
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 5, color, background: bg, letterSpacing: '.03em' }}>{label}</span>
}

function Toggle({ value, onChange, size = 'md' }: { value: boolean; onChange: (v: boolean) => void; size?: 'sm' | 'md' }) {
  const w = size === 'sm' ? 28 : 34; const h = size === 'sm' ? 16 : 19; const d = size === 'sm' ? 10 : 13
  return (
    <button type="button" onClick={() => onChange(!value)} style={{
      position: 'relative', width: w, height: h, borderRadius: h, border: 'none',
      background: value ? '#6366f1' : 'var(--border)', cursor: 'pointer', transition: 'background .18s', flexShrink: 0,
    }}>
      <span style={{
        position: 'absolute', top: (h - d) / 2, left: value ? w - d - (h - d) / 2 : (h - d) / 2,
        width: d, height: d, borderRadius: '50%', background: '#fff',
        transition: 'left .18s', boxShadow: '0 1px 3px #0003',
      }} />
    </button>
  )
}

// ── Snapshot thumbnail + lightbox ────────────────────────────────────────────

function SnapshotThumb({ url, size = 52 }: { url: string; size?: number }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState(false)

  if (err) return null

  return (
    <>
      <div
        onClick={() => setOpen(true)}
        title="Ver snapshot"
        style={{
          width: size, height: size, borderRadius: 6, flexShrink: 0,
          overflow: 'hidden', cursor: 'pointer', position: 'relative',
          background: 'var(--surface2)', border: '1px solid var(--border)',
        }}
      >
        {!loaded && !err && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--primary)', animation: 'spin .7s linear infinite' }} />
          </div>
        )}
        <img
          src={url}
          alt="snapshot"
          onLoad={() => setLoaded(true)}
          onError={() => setErr(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: loaded ? 'block' : 'none' }}
        />
        {loaded && (
          <div style={{
            position: 'absolute', inset: 0, background: 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0, transition: 'opacity .15s',
          }}
            className="snap-overlay"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </div>
        )}
      </div>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9000,
            background: '#000000cc', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '88vh' }}>
            <img
              src={url}
              alt="snapshot"
              style={{ maxWidth: '100%', maxHeight: '88vh', borderRadius: 10, boxShadow: '0 24px 80px #000a' }}
              onClick={e => e.stopPropagation()}
            />
            <button
              onClick={() => setOpen(false)}
              style={{
                position: 'absolute', top: -12, right: -12,
                width: 28, height: 28, borderRadius: '50%',
                background: 'var(--surface)', border: '1px solid var(--border)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ── Live Alarm Banner ─────────────────────────────────────────────────────────

function AlarmBanner({ event, onDismiss }: { event: AlarmEvent | null; onDismiss: () => void }) {
  const [prog, setProg] = useState(100)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!event) { setProg(100); return }
    setProg(100)
    const start = Date.now(); const dur = 8000
    timer.current = setInterval(() => {
      const elapsed = Date.now() - start
      const p = Math.max(0, 100 - (elapsed / dur) * 100)
      setProg(p)
      if (p <= 0) { clearInterval(timer.current!); onDismiss() }
    }, 80)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [event])

  if (!event) return null

  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      borderRadius: 10, marginBottom: 16,
      background: 'linear-gradient(135deg, #1a0505 0%, #2d0808 100%)',
      border: '1px solid #ef444455',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}>
        {event.snapshot_url ? (
          <SnapshotThumb url={event.snapshot_url} size={52} />
        ) : (
          <div style={{
            width: 38, height: 38, borderRadius: 9, flexShrink: 0,
            background: '#ef44441a', border: '1px solid #ef444433',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01" />
            </svg>
          </div>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 3 }}>
            Alarme Ativo
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>
            {event.camera_nome}
            <span style={{ fontSize: 12, fontWeight: 400, color: '#ffffff88', marginLeft: 8 }}>
              · {event.total_pessoas} pessoa{event.total_pessoas !== 1 ? 's' : ''} detectada{event.total_pessoas !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <span style={{ fontSize: 11, color: '#ffffff55', marginRight: 8 }}>{fmtTs(event.detectado_em)}</span>
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ffffff66', padding: 4, lineHeight: 0, borderRadius: 4 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      {/* Progress bar */}
      <div style={{ height: 2, background: '#ef444415' }}>
        <div style={{ height: '100%', background: '#ef4444', width: `${prog}%`, transition: 'width .08s linear' }} />
      </div>
    </div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ msg }: { msg: string }) {
  if (!msg) return null
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 3000,
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 16px', fontSize: 12, fontWeight: 500,
      boxShadow: '0 8px 32px #0004', color: 'var(--text)',
      display: 'flex', alignItems: 'center', gap: 7,
    }}>
      <span style={{ color: '#22c55e' }}>✓</span> {msg}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AlarmeCCTV() {
  const [tab, setTab]           = useState<'monitor' | 'config'>('monitor')
  const [configs, setConfigs]   = useState<AlarmConfig[]>([])
  const [events, setEvents]     = useState<AlarmEvent[]>([])
  const [loading, setLoading]   = useState(true)
  const _loadPrefs = () => {
    try { return JSON.parse(localStorage.getItem('alert_prefs_alarme_cctv') ?? '{}') } catch { return {} }
  }
  const [soundOn, setSoundOnRaw] = useState(() => _loadPrefs().sound !== false)
  const [volume, setVolumeRaw]   = useState<number>(() => _loadPrefs().volume ?? 0.7)
  const [testing, setTesting]    = useState(false)

  const _savePrefs = (patch: object) => {
    try {
      const cur = _loadPrefs()
      localStorage.setItem('alert_prefs_alarme_cctv', JSON.stringify({ ...cur, ...patch }))
    } catch { /* ignore */ }
  }
  const setSoundOn = (fn: boolean | ((v: boolean) => boolean)) => {
    setSoundOnRaw(prev => {
      const next = typeof fn === 'function' ? fn(prev) : fn
      _savePrefs({ sound: next })
      return next
    })
  }
  const setVolume = (v: number) => {
    setVolumeRaw(v)
    _savePrefs({ volume: v })
  }

  const [liveAlarm, setLiveAlarm] = useState<AlarmEvent | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [localCfg, setLocalCfg] = useState<Record<number, Partial<AlarmConfig>>>({})
  const [toastMsg, setToastMsg] = useState('')
  const soundRef  = useRef(soundOn)
  const volumeRef = useRef(volume)
  soundRef.current  = soundOn
  volumeRef.current = volume

  const toast = (m: string) => { setToastMsg(m); setTimeout(() => setToastMsg(''), 2800) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cr, er] = await Promise.all([
        api.get<AlarmConfig[]>('/api/v1/alarm/config'),
        api.get<AlarmEvent[]>('/api/v1/alarm/events', { params: { limit: 120 } }),
      ])
      setConfigs(cr.data); setEvents(er.data)
      const init: Record<number, Partial<AlarmConfig>> = {}
      cr.data.forEach(c => { init[c.camera_id] = { ...c } })
      setLocalCfg(init)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // SSE
  useEffect(() => {
    const base = (import.meta.env.VITE_API_URL ?? '')
    const es = new EventSource(`${base}/api/v1/stream`)
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.type !== 'alarm_cctv') return
        const ev: AlarmEvent = {
          id: d.evento_id ?? Date.now(),
          camera_id: d.camera_id, camera_nome: d.camera_nome,
          total_pessoas: d.total_pessoas, canais: [],
          detectado_em: d.ts,
          snapshot_url: d.snapshot_url ?? null,
        }
        setLiveAlarm(ev)
        setEvents(p => [ev, ...p].slice(0, 200))
        if (soundRef.current && d.sonoro !== false) playSiren(8, volumeRef.current)
      } catch { /* ignore */ }
    }
    return () => { es.close(); stopSiren() }
  }, [])

  const patch = (id: number, key: keyof AlarmConfig, val: unknown) =>
    setLocalCfg(p => ({ ...p, [id]: { ...(p[id] ?? {}), [key]: val } }))

  const save = async (cam_id: number) => {
    setSavingId(cam_id)
    try { await api.put(`/api/v1/alarm/config/${cam_id}`, localCfg[cam_id] ?? {}); toast('Configuração salva'); load() }
    catch { toast('Erro ao salvar') } finally { setSavingId(null) }
  }

  const activeCount  = configs.filter(c => c.ativo).length
  const alarms24     = configs.reduce((s, c) => s + (c.alarmes_24h || 0), 0)
  const waCount      = configs.filter(c => c.ativo && c.notif_whatsapp).length
  const tgCount      = configs.filter(c => c.ativo && c.notif_telegram).length
  const userNotifCount = configs.filter(c => c.ativo && (c.notif_usuarios ?? []).length > 0).length

  return (
    <div style={{ padding: '24px 28px', width: '100%', boxSizing: 'border-box' }}>
      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateY(-4px) } to { opacity:1; transform:translateY(0) } }
        @keyframes pulseRed { 0%,100%{box-shadow:0 0 0 0 #ef444433} 50%{box-shadow:0 0 0 8px #ef444400} }
        @keyframes spin { to { transform: rotate(360deg) } }
        .alarm-row:hover { background: var(--surface2) !important; }
        .cam-card { transition: border-color .15s, box-shadow .15s; }
        .cam-card:hover { border-color: var(--primary) !important; }
        .cfg-inp:focus { outline: none; border-color: var(--primary) !important; }
        .snap-thumb:hover .snap-overlay { opacity: 1 !important; }
        .ev-card:hover { box-shadow: 0 4px 20px #0002; border-color: #ef444488 !important; }
        .ev-card:hover .card-hover-overlay { background: #00000022 !important; }
        .ev-card:hover .card-zoom-icon { opacity: 1 !important; }
      `}</style>

      <Toast msg={toastMsg} />
      <AlarmBanner event={liveAlarm} onDismiss={() => { stopSiren(); setLiveAlarm(null) }} />

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: 'var(--text)', letterSpacing: '-.01em' }}>Alarme CCTV</h2>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text2)' }}>
            Detecção de pessoas em tempo real · {activeCount} câmera{activeCount !== 1 ? 's' : ''} ativa{activeCount !== 1 ? 's' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>

          {/* ── Painel de áudio ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 10px', borderRadius: 8,
            border: '1px solid var(--border)',
            background: soundOn ? 'rgba(99,102,241,.06)' : 'var(--surface)',
          }}>
            {/* Toggle mudo / ativo */}
            <button
              onClick={() => {
                _ensureAudioUnlocked()
                const next = !soundOn
                setSoundOn(next)
                if (!next) stopSiren()
                else playConfirmBeep(volume)
              }}
              title={soundOn ? 'Silenciar' : 'Ativar som'}
              style={{
                display: 'flex', alignItems: 'center', background: 'none',
                border: 'none', cursor: 'pointer', padding: 2, lineHeight: 0,
                color: soundOn ? '#6366f1' : 'var(--text3)',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {soundOn
                  ? <><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></>
                  : <><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></>}
              </svg>
            </button>

            {/* Slider de volume */}
            <input
              type="range" min={0} max={1} step={0.05}
              value={volume}
              disabled={!soundOn}
              onChange={e => setVolume(parseFloat(e.target.value))}
              title={`Volume: ${Math.round(volume * 100)}%`}
              style={{ width: 72, accentColor: '#6366f1', opacity: soundOn ? 1 : 0.35, cursor: soundOn ? 'pointer' : 'default' }}
            />

            {/* % label */}
            <span style={{ fontSize: 11, color: soundOn ? '#6366f1' : 'var(--text3)', fontWeight: 600, minWidth: 28, textAlign: 'right' }}>
              {Math.round(volume * 100)}%
            </span>

            {/* Divider */}
            <div style={{ width: 1, height: 14, background: 'var(--border)' }} />

            {/* Botão de teste */}
            <button
              onClick={() => {
                if (!soundOn) return
                _ensureAudioUnlocked()
                setTesting(true)
                playSiren(3, volume)
                setTimeout(() => setTesting(false), 3200)
              }}
              disabled={!soundOn || testing}
              title="Testar alarme sonoro"
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)',
                background: 'transparent', cursor: soundOn && !testing ? 'pointer' : 'default',
                fontSize: 11, color: testing ? '#6366f1' : 'var(--text2)', fontWeight: 500,
                opacity: soundOn ? 1 : 0.4, transition: 'color .15s',
              }}
            >
              {testing
                ? <><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6366f1', display: 'inline-block', animation: 'pulseRed 0.8s ease-in-out infinite' }} /> Tocando</>
                : <>▶ Testar</>}
            </button>
          </div>

          <button onClick={load} style={{
            padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)',
            background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text2)',
          }}>
            Atualizar
          </button>
        </div>
      </div>

      {/* ── Stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Ativas',        val: activeCount,     accent: '#6366f1' },
          { label: 'Disparos 24h',  val: alarms24,        accent: '#f59e0b' },
          { label: 'Com WhatsApp',  val: waCount,         accent: '#25D366' },
          { label: 'Com Telegram',  val: tgCount,         accent: '#229ED9' },
          { label: 'Com Usuários',  val: userNotifCount,  accent: '#8b5cf6' },
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

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
        {[
          { key: 'monitor', label: 'Monitor' },
          { key: 'config',  label: 'Configuração' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as typeof tab)} style={{
            padding: '9px 18px', fontWeight: tab === t.key ? 600 : 400, fontSize: 13,
            cursor: 'pointer', background: 'none', border: 'none',
            borderBottom: `2px solid ${tab === t.key ? 'var(--primary)' : 'transparent'}`,
            color: tab === t.key ? 'var(--primary)' : 'var(--text2)',
            marginBottom: -1, transition: 'color .15s, border-color .15s',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <div className="spinner" />
        </div>
      ) : tab === 'monitor' ? (
        <MonitorTab events={events} configs={configs} onRefresh={load} toast={toast} />
      ) : (
        <ConfigTab configs={configs} localCfg={localCfg} patch={patch} save={save} savingId={savingId} />
      )}
    </div>
  )
}

// ── Alarm Timeline Chart ──────────────────────────────────────────────────────

const PERIODOS_TL = ['6h', '24h', '7d', '30d'] as const

function fmtTlTs(ts: string, periodo: string) {
  const d = new Date(ts)
  if (periodo === '30d') return format(d, 'dd/MM')
  return format(d, 'HH:mm')
}

function AlarmTimeline({ cameraId }: { cameraId?: number }) {
  const [periodo, setPeriodo] = useState<string>('24h')
  const [rows, setRows]       = useState<AlarmTimelineRow[]>([])
  const [pico, setPico]       = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const params: Record<string, unknown> = { periodo }
    if (cameraId) params.camera_id = cameraId
    getAlarmTimeline(params)
      .then(r => { setRows(r.data.data); setPico(r.data.pico_global) })
      .finally(() => setLoading(false))
  }, [periodo, cameraId])

  const maxDisparos = Math.max(...rows.map(r => r.disparos), 1)

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d: AlarmTimelineRow = payload[0]?.payload
    return (
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '10px 14px', fontSize: 12,
        boxShadow: '0 4px 20px #0003',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>
          {fmtTlTs(d.ts, periodo)}
        </div>
        <div style={{ color: '#ef4444' }}>🔔 Disparos: <b>{d.disparos}</b></div>
        <div style={{ color: '#f59e0b' }}>👷 Pessoas: <b>{d.total_pessoas}</b></div>
        <div style={{ color: 'var(--text2)' }}>Pico: <b>{d.pico}</b> · Média: <b>{Number(d.media_pessoas).toFixed(1)}</b></div>
        {d.cameras_ativas > 1 && (
          <div style={{ color: 'var(--text3)', marginTop: 3 }}>
            📷 {d.cameras_ativas} câmera{d.cameras_ativas > 1 ? 's' : ''}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1, color: 'var(--text)' }}>
          Fluxo Temporal — Disparos de Alarme
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {PERIODOS_TL.map(p => (
            <button
              key={p}
              onClick={() => setPeriodo(p)}
              style={{
                padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
                cursor: 'pointer', fontSize: 11, fontWeight: periodo === p ? 700 : 400,
                background: periodo === p ? '#ef4444' : 'transparent',
                color: periodo === p ? '#fff' : 'var(--text2)',
                transition: 'all .15s',
              }}
            >{p}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner" />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>
          Sem disparos no período
        </div>
      ) : (
        <ResponsiveContainer width="100%" minWidth={0} height={200}>
          <ComposedChart data={rows} margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="ts"
              tickFormatter={v => fmtTlTs(v, periodo)}
              tick={{ fontSize: 10, fill: 'var(--text2)' }}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10, fill: 'var(--text2)' }}
              allowDecimals={false}
              label={{ value: 'Disparos', angle: -90, position: 'insideLeft', fontSize: 9, fill: 'var(--text3)', dy: 30 }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10, fill: 'var(--text2)' }}
              allowDecimals={false}
              label={{ value: 'Pessoas', angle: 90, position: 'insideRight', fontSize: 9, fill: 'var(--text3)', dy: -30 }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar yAxisId="left" dataKey="disparos" name="Disparos" radius={[4, 4, 0, 0]} maxBarSize={32}>
              {rows.map((r, i) => (
                <Cell
                  key={i}
                  fill={r.disparos >= maxDisparos * 0.7
                    ? '#ef4444'
                    : r.disparos >= maxDisparos * 0.35
                      ? '#f97316'
                      : '#fbbf24'}
                />
              ))}
            </Bar>
            <Line
              yAxisId="right"
              dataKey="total_pessoas"
              name="Pessoas"
              type="monotone"
              stroke="#6366f1"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
        <span>
          <span style={{ display: 'inline-block', width: 10, height: 10, background: '#ef4444', borderRadius: 2, marginRight: 4 }} />
          Alto
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 10, height: 10, background: '#f97316', borderRadius: 2, marginRight: 4 }} />
          Médio
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 10, height: 10, background: '#fbbf24', borderRadius: 2, marginRight: 4 }} />
          Baixo
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 10, height: 3, background: '#6366f1', borderRadius: 1, marginRight: 4, verticalAlign: 'middle' }} />
          Pessoas detectadas
        </span>
        {pico > 0 && (
          <span style={{ marginLeft: 'auto', color: 'var(--text3)' }}>
            Pico: <b style={{ color: '#ef4444' }}>{pico}</b> disparos/h
          </span>
        )}
      </div>
    </div>
  )
}

// ── Monitor Tab ───────────────────────────────────────────────────────────────

function MonitorTab({ events, configs, onRefresh, toast }: {
  events: AlarmEvent[]; configs: AlarmConfig[]
  onRefresh: () => void; toast: (m: string) => void
}) {
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [filterCam, setFilterCam] = useState<string>('')

  const clearHistory = async () => {
    try { await api.delete('/api/v1/alarm/events'); toast('Histórico limpo'); onRefresh() }
    catch { toast('Erro ao limpar') }
  }

  const camOptions = Array.from(new Map(configs.map(c => [c.camera_id, c.camera_nome])).entries())
  const filteredEvents = filterCam ? events.filter(e => e.camera_id === +filterCam) : events

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <AlarmTimeline cameraId={filterCam ? +filterCam : undefined} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 12, alignItems: 'start' }}>

      {/* ── Event log ── */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
            Histórico de Disparos
            {filteredEvents.length > 0 && (
              <span style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 400,
                background: 'var(--surface2)', padding: '1px 7px', borderRadius: 20, border: '1px solid var(--border)' }}>
                {filteredEvents.length}
              </span>
            )}
          </div>
          {camOptions.length > 1 && (
            <select
              value={filterCam}
              onChange={e => setFilterCam(e.target.value)}
              style={{
                fontSize: 11, padding: '3px 8px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface2)',
                color: 'var(--text2)', cursor: 'pointer',
              }}
            >
              <option value="">Todas as câmeras</option>
              {camOptions.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
            </select>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* View toggle */}
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
            {events.length > 0 && (
              <button onClick={clearHistory} style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'transparent',
                cursor: 'pointer', color: '#ef4444',
              }}>Limpar</button>
            )}
          </div>
        </div>

        {filteredEvents.length === 0 ? (
          <div style={{ padding: '52px 0', textAlign: 'center', color: 'var(--text2)' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .3, marginBottom: 10 }}>
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0M12 2v1" />
            </svg>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Nenhum alarme registrado</div>
            <div style={{ fontSize: 11, marginTop: 4, opacity: .6 }}>Ative o alarme nas câmeras para começar</div>
          </div>
        ) : view === 'grid' ? (
          <EventGrid events={filteredEvents} />
        ) : (
          <EventList events={filteredEvents} />
        )}
      </div>

      {/* ── Camera status ── */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Câmeras</div>
        </div>
        <div style={{ maxHeight: 600, overflowY: 'auto' }}>
          {configs.map(c => (
            <div key={c.camera_id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 14px', borderBottom: '1px solid var(--border)',
              opacity: c.ativo ? 1 : .45,
            }}>
              <Dot status={c.status_conexao} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.camera_nome}
                </div>
                {c.ativo && (
                  <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>
                    ≥{c.min_pessoas}p · {c.cooldown_seg}s
                  </div>
                )}
              </div>
              {c.ativo && (
                <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                  {c.notif_sonoro   && <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: '#6366f115', color: '#6366f1', fontWeight: 700 }}>♪</span>}
                  {c.notif_whatsapp && <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: '#25D36615', color: '#25D366', fontWeight: 700 }}>WA</span>}
                  {c.notif_telegram && <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: '#229ED915', color: '#229ED9', fontWeight: 700 }}>TG</span>}
                </div>
              )}
              {(c.alarmes_24h || 0) > 0 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', flexShrink: 0 }}>{c.alarmes_24h}</span>
              )}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  )
}

// ── Alarm Modal ───────────────────────────────────────────────────────────────

function AlarmModal({ ev, onClose }: { ev: AlarmEvent; onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.88)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
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
          <div style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'rgba(239,68,68,.15)', border: '1px solid rgba(239,68,68,.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{ev.camera_nome}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2, display: 'flex', gap: 12 }}>
              <span>📅 {format(new Date(ev.detectado_em), 'dd/MM/yyyy HH:mm:ss')}</span>
              <span>👷 {ev.total_pessoas} pessoa{ev.total_pessoas !== 1 ? 's' : ''} detectada{ev.total_pessoas !== 1 ? 's' : ''}</span>
            </div>
          </div>
          <span style={{
            padding: '4px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13,
            background: 'rgba(239,68,68,.15)', color: '#ef4444',
            border: '1px solid rgba(239,68,68,.3)',
          }}>
            🔔 Alarme Disparado
          </span>
          <button
            onClick={onClose}
            style={{ fontSize: 18, lineHeight: 1, padding: '4px 8px', background: 'none', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', color: 'var(--text2)' }}
          >✕</button>
        </div>

        {/* Conteúdo */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {/* Snapshot */}
          <div style={{ flex: 1, background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {ev.snapshot_url ? (
              <img src={ev.snapshot_url} alt="snapshot alarme" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text3)' }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .2, marginBottom: 10 }}>
                  <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z M12 17a4 4 0 100-8 4 4 0 000 8z" />
                </svg>
                <div style={{ fontSize: 13 }}>Snapshot não disponível</div>
              </div>
            )}
          </div>

          {/* Painel lateral */}
          <div style={{ width: 270, flexShrink: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>

            {/* Detalhes */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 12 }}>
                Detalhes do Alarme
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>Pessoas detectadas</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#ef4444', lineHeight: 1 }}>
                    {ev.total_pessoas}
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginLeft: 6 }}>
                      pessoa{ev.total_pessoas !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text2)' }}>Câmera</span>
                    <b style={{ color: 'var(--text)', textAlign: 'right', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.camera_nome}</b>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text2)' }}>Data</span>
                    <b style={{ color: 'var(--text)' }}>{format(new Date(ev.detectado_em), 'dd/MM/yyyy')}</b>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text2)' }}>Horário</span>
                    <b style={{ color: 'var(--text)' }}>{format(new Date(ev.detectado_em), 'HH:mm:ss')}</b>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                    <span style={{ color: 'var(--text2)' }}>Tempo</span>
                    <b style={{ color: 'var(--text)' }}>{fmtTs(ev.detectado_em)}</b>
                  </div>
                </div>
              </div>
            </div>

            {/* Canais */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 12 }}>
                Canais Notificados
              </div>
              {(ev.canais || []).length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Nenhum canal registrado</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(ev.canais || []).map(c => {
                    const ch = CHANNEL_LABEL[c]
                    if (!ch) return null
                    return (
                      <div key={c} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 12px', borderRadius: 8,
                        background: `${ch.color}10`, border: `1px solid ${ch.color}30`,
                      }}>
                        <span style={{ fontSize: 14, fontWeight: 800, color: ch.color, minWidth: 24, textAlign: 'center' }}>{ch.icon}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>{c}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 10, color: ch.color, fontWeight: 700 }}>Enviado ✓</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Rodapé */}
            <div style={{ padding: '12px 18px', marginTop: 'auto' }}>
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

// ── Event Grid ────────────────────────────────────────────────────────────────

function EventGrid({ events }: { events: AlarmEvent[] }) {
  const [modal, setModal] = useState<AlarmEvent | null>(null)
  return (
    <>
      {modal && <AlarmModal ev={modal} onClose={() => setModal(null)} />}
      <div style={{ padding: 12, maxHeight: 620, overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
          {events.map((ev, i) => (
            <EventCard key={ev.id} ev={ev} isNewest={i === 0} onClick={() => setModal(ev)} />
          ))}
        </div>
      </div>
    </>
  )
}

function EventCard({ ev, isNewest, onClick }: { ev: AlarmEvent; isNewest: boolean; onClick: () => void }) {
  const [imgErr, setImgErr] = useState(false)
  const hasImg = !!ev.snapshot_url && !imgErr

  return (
    <div
      onClick={onClick}
      style={{
        borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
        border: `1px solid ${isNewest ? '#ef444466' : 'var(--border)'}`,
        background: isNewest ? '#ef44440d' : 'var(--surface2)',
        transition: 'border-color .15s, box-shadow .15s',
        boxShadow: isNewest ? '0 0 0 0 rgba(239,68,68,.3)' : 'none',
      }}
      className="ev-card"
      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--primary)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = isNewest ? '0 0 8px rgba(239,68,68,.2)' : 'none')}
    >
      {/* Image — 16:9 */}
      <div style={{ position: 'relative', width: '100%', paddingTop: '56.25%', background: '#0a0a0a' }}>
        {hasImg ? (
          <img
            src={ev.snapshot_url!}
            alt="snapshot"
            onError={() => setImgErr(true)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 6, color: '#ffffff1a',
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z M12 17a4 4 0 100-8 4 4 0 000 8z" />
            </svg>
            <span style={{ fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase' }}>Sem snapshot</span>
          </div>
        )}

        {/* NOVO badge */}
        {isNewest && (
          <div style={{
            position: 'absolute', top: 7, left: 7,
            background: '#ef4444', color: '#fff',
            fontSize: 8, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase',
            padding: '2px 7px', borderRadius: 4,
          }}>● Novo</div>
        )}

        {/* Pessoa count */}
        <div style={{
          position: 'absolute', bottom: 7, right: 7,
          background: 'rgba(0,0,0,.75)', backdropFilter: 'blur(4px)',
          color: '#fff', fontSize: 11, fontWeight: 700,
          padding: '3px 8px', borderRadius: 5,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z"/>
          </svg>
          {ev.total_pessoas}
        </div>

        {/* Hover overlay */}
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background .15s',
        }} className="card-hover-overlay">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0, transition: 'opacity .15s' }} className="card-zoom-icon">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '9px 11px' }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>
          {ev.camera_nome}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 10, color: isNewest ? '#ef4444' : 'var(--text2)' }}>
            {fmtTime(ev.detectado_em)}
            <span style={{ marginLeft: 4, opacity: .6 }}>· {fmtTs(ev.detectado_em)}</span>
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {(ev.canais || []).map(c => {
              const ch = CHANNEL_LABEL[c]
              return ch ? (
                <span key={c} style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4, color: ch.color, background: `${ch.color}18` }}>
                  {ch.icon}
                </span>
              ) : null
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Event List ────────────────────────────────────────────────────────────────

function EventList({ events }: { events: AlarmEvent[] }) {
  const [modal, setModal] = useState<AlarmEvent | null>(null)
  return (
    <>
      {modal && <AlarmModal ev={modal} onClose={() => setModal(null)} />}
      <div style={{ maxHeight: 620, overflowY: 'auto' }}>
        {events.map((ev, i) => (
          <div
            key={ev.id}
            className="alarm-row"
            onClick={() => setModal(ev)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px', cursor: 'pointer',
              borderBottom: i < events.length - 1 ? '1px solid var(--border)' : 'none',
              background: i === 0 ? '#ef44440a' : 'transparent',
              borderLeft: i === 0 ? '3px solid #ef4444' : '3px solid transparent',
              transition: 'background .12s',
            }}
          >
            <div style={{ flexShrink: 0, width: 56, textAlign: 'center' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#ef4444' : 'var(--text)' }}>{fmtTime(ev.detectado_em)}</div>
              <div style={{ fontSize: 9, color: 'var(--text2)', marginTop: 1 }}>{fmtTs(ev.detectado_em)}</div>
            </div>
            <div style={{ width: 1, height: 28, background: 'var(--border)', flexShrink: 0 }} />

            {/* Thumbnail */}
            <div style={{ width: 48, height: 36, borderRadius: 5, flexShrink: 0, overflow: 'hidden', background: 'var(--surface2)', border: '1px solid var(--border)' }}>
              {ev.snapshot_url ? (
                <img src={ev.snapshot_url} alt="snap" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .2 }}>
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z M12 17a4 4 0 100-8 4 4 0 000 8z" />
                  </svg>
                </div>
              )}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.camera_nome}</div>
              <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>
                <span style={{ color: '#ef4444', fontWeight: 600 }}>{ev.total_pessoas}</span> pessoa{ev.total_pessoas !== 1 ? 's' : ''} detectada{ev.total_pessoas !== 1 ? 's' : ''}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              {(ev.canais || []).map(c => {
                const ch = CHANNEL_LABEL[c]
                return ch ? <span key={c} style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4, color: ch.color, background: `${ch.color}18` }}>{ch.icon}</span> : null
              })}
            </div>

            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .3, flexShrink: 0 }}>
              <path d="M9 18l6-6-6-6" />
            </svg>
          </div>
        ))}
      </div>
    </>
  )
}

// ── Schedule Row ──────────────────────────────────────────────────────────────

const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']

function ScheduleRow({ horarioInicio, horarioFim, diasSemana, onChange }: {
  horarioInicio: string | null; horarioFim: string | null
  diasSemana: number[] | null
  onChange: (field: string, val: unknown) => void
}) {
  const hasSchedule = !!(horarioInicio || horarioFim || (diasSemana && diasSemana.length > 0))

  const toggleDay = (d: number) => {
    const current = diasSemana ?? []
    const next = current.includes(d) ? current.filter(x => x !== d) : [...current, d].sort()
    onChange('dias_semana', next.length > 0 ? next : null)
  }

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      border: `1px solid ${hasSchedule ? '#f59e0b44' : 'var(--border)'}`,
      background: hasSchedule ? '#f59e0b08' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: hasSchedule ? 12 : 0 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={hasSchedule ? '#f59e0b' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: hasSchedule ? 1 : .4 }}>
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: hasSchedule ? '#f59e0b' : 'var(--text)', letterSpacing: '.03em' }}>
          Horário de Funcionamento
        </span>
        {hasSchedule && (
          <button onClick={() => { onChange('horario_inicio', null); onChange('horario_fim', null); onChange('dias_semana', null) }}
            style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}>
            Limpar
          </button>
        )}
      </div>

      {hasSchedule && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <label style={lbl}>Início</label>
            <input type="time" value={horarioInicio ?? ''} onChange={e => onChange('horario_inicio', e.target.value || null)}
              className="cfg-inp" style={{ ...smallInp, width: 110 }} />
          </div>
          <div>
            <label style={lbl}>Fim</label>
            <input type="time" value={horarioFim ?? ''} onChange={e => onChange('horario_fim', e.target.value || null)}
              className="cfg-inp" style={{ ...smallInp, width: 110 }} />
          </div>
          <div>
            <label style={lbl}>Dias da semana</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {DAYS.map((d, i) => {
                const active = (diasSemana ?? []).includes(i)
                return (
                  <button key={i} onClick={() => toggleDay(i)} style={{
                    width: 32, height: 28, borderRadius: 5, border: `1px solid ${active ? '#f59e0b' : 'var(--border)'}`,
                    background: active ? '#f59e0b' : 'transparent', color: active ? '#000' : 'var(--text2)',
                    fontSize: 10, fontWeight: active ? 700 : 400, cursor: 'pointer',
                    transition: 'all .15s',
                  }}>{d}</button>
                )
              })}
            </div>
            <div style={hint}>Vazio = todos os dias</div>
          </div>
        </div>
      )}

      {!hasSchedule && (
        <button onClick={() => onChange('horario_inicio', '08:00')}
          style={{ fontSize: 11, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 2 }}>
          + Definir horário de funcionamento
        </button>
      )}
    </div>
  )
}

// ── User Picker ───────────────────────────────────────────────────────────────

function UserPicker({ operators, selected, onChange }: {
  operators: Operador[]
  selected: number[]
  onChange: (ids: number[]) => void
}) {
  if (operators.length === 0) return null

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])
  }

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      border: `1px solid ${selected.length > 0 ? '#6366f130' : 'var(--border)'}`,
      background: selected.length > 0 ? '#6366f108' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={selected.length > 0 ? '#6366f1' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: selected.length > 0 ? 1 : .4 }}>
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: selected.length > 0 ? '#6366f1' : 'var(--text)', letterSpacing: '.03em' }}>
          Usuários Cadastrados
        </span>
        {selected.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text2)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '1px 6px', borderRadius: 10 }}>
            {selected.length} selecionado{selected.length > 1 ? 's' : ''}
          </span>
        )}
        {selected.length > 0 && (
          <button onClick={() => onChange([])} style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}>
            Limpar
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {operators.map(op => {
          const checked = selected.includes(op.id)
          return (
            <label key={op.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${checked ? '#6366f130' : 'transparent'}`,
              background: checked ? '#6366f10a' : 'transparent',
              transition: 'background .12s, border-color .12s',
            }}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(op.id)}
                style={{ accentColor: '#6366f1', width: 14, height: 14, flexShrink: 0, cursor: 'pointer' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: checked ? 600 : 400, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {op.nome}
                </div>
                {op.cargo && (
                  <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>{op.cargo}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {op.whatsapp && (
                  <span title={op.whatsapp} style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4,
                    color: '#25D366', background: '#25D36618', border: '1px solid #25D36630',
                  }}>WA</span>
                )}
                {op.telegram && (
                  <span title={op.telegram} style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4,
                    color: '#229ED9', background: '#229ED918', border: '1px solid #229ED930',
                  }}>TG</span>
                )}
              </div>
            </label>
          )
        })}
      </div>

      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text2)', opacity: .7 }}>
        Usuários selecionados recebem alertas automaticamente pelos canais configurados no perfil (WhatsApp / Telegram).
      </div>
    </div>
  )
}

// ── Config Tab ────────────────────────────────────────────────────────────────

function ConfigTab({ configs, localCfg, patch, save, savingId }: {
  configs: AlarmConfig[]; localCfg: Record<number, Partial<AlarmConfig>>
  patch: (id: number, key: keyof AlarmConfig, val: unknown) => void
  save: (id: number) => void; savingId: number | null
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [operators, setOperators] = useState<Operador[]>([])

  useEffect(() => {
    api.get<Operador[]>('/api/v1/usuarios')
      .then(r => setOperators(r.data.filter(u => u.ativo && (u.whatsapp || u.telegram))))
      .catch(() => { /* admin-only — silently ignore if not admin */ })
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {configs.map(c => {
        const cfg     = { ...c, ...(localCfg[c.camera_id] ?? {}) }
        const dirty   = JSON.stringify(cfg) !== JSON.stringify(c)
        const isExp   = expandedId === c.camera_id
        const saving  = savingId === c.camera_id

        return (
          <div key={c.camera_id} className="cam-card" style={{
            background: 'var(--surface)', border: `1px solid ${dirty ? 'var(--primary)' : 'var(--border)'}`,
            borderRadius: 10, overflow: 'hidden',
            opacity: cfg.ativo ? 1 : .65,
          }}>
            {/* Main row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 52px 60px 44px 44px 44px 110px', gap: 0, alignItems: 'center', padding: '12px 16px' }}>

              {/* Camera name */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Dot status={c.status_conexao} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.camera_nome}
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 3, alignItems: 'center' }}>
                    <Badge label={c.protocolo.toUpperCase()} />
                    {c.camera_local && <span style={{ fontSize: 10, color: 'var(--text2)' }}>{c.camera_local}</span>}
                  </div>
                </div>
              </div>

              {/* Alarme toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Alarme</div>
                <Toggle value={cfg.ativo} onChange={v => patch(c.camera_id, 'ativo', v)} />
              </div>

              {/* Min pessoas */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Mín. pess.</div>
                <input type="number" min={1} max={99}
                  value={cfg.min_pessoas ?? 1}
                  onChange={e => patch(c.camera_id, 'min_pessoas', parseInt(e.target.value) || 1)}
                  className="cfg-inp"
                  style={{ width: 48, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, textAlign: 'center' }}
                />
              </div>

              {/* Som */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Som</div>
                <Toggle size="sm" value={cfg.notif_sonoro} onChange={v => patch(c.camera_id, 'notif_sonoro', v)} />
              </div>

              {/* WA */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: '#25D366', textTransform: 'uppercase', letterSpacing: '.05em' }}>WA</div>
                <Toggle size="sm" value={cfg.notif_whatsapp} onChange={v => patch(c.camera_id, 'notif_whatsapp', v)} />
              </div>

              {/* TG */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: '#229ED9', textTransform: 'uppercase', letterSpacing: '.05em' }}>TG</div>
                <Toggle size="sm" value={cfg.notif_telegram} onChange={v => patch(c.camera_id, 'notif_telegram', v)} />
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                <button
                  onClick={() => setExpandedId(isExp ? null : c.camera_id)}
                  style={{
                    padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)',
                    background: isExp ? 'var(--surface2)' : 'transparent',
                    cursor: 'pointer', fontSize: 11, color: 'var(--text2)', lineHeight: 1,
                  }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={isExp ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
                  </svg>
                </button>
                <button
                  onClick={() => save(c.camera_id)} disabled={saving || !dirty}
                  style={{
                    padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 11,
                    cursor: dirty ? 'pointer' : 'default', fontWeight: 600,
                    background: dirty ? 'var(--primary)' : 'var(--surface2)',
                    color: dirty ? '#fff' : 'var(--text2)',
                    transition: 'all .15s', minWidth: 52,
                  }}>
                  {saving ? '…' : dirty ? 'Salvar' : 'OK'}
                </button>
              </div>
            </div>

            {/* Expanded panel */}
            {isExp && (
              <div style={{
                padding: '14px 16px 16px',
                borderTop: '1px solid var(--border)',
                background: 'var(--surface2)',
                display: 'flex', flexDirection: 'column', gap: 14,
                animation: 'fadeIn .15s ease',
              }}>
                {/* Row 1 */}
                <div style={{ display: 'grid', gridTemplateColumns: '120px 220px 1fr 1fr', gap: 14 }} data-cam={c.camera_id}>
                  <div>
                    <label style={lbl}>Cooldown (seg)</label>
                    <input type="number" min={10} max={3600}
                      value={cfg.cooldown_seg ?? 60}
                      onChange={e => patch(c.camera_id, 'cooldown_seg', parseInt(e.target.value) || 60)}
                      className="cfg-inp"
                      style={smallInp}
                    />
                    <div style={hint}>Intervalo mínimo entre alarmes</div>
                  </div>

                  {/* Anti-falso-positivo */}
                  <div style={{
                    padding: '10px 12px', borderRadius: 8,
                    border: `1px solid ${cfg.verificacao_yolo ? '#6366f130' : 'var(--border)'}`,
                    background: cfg.verificacao_yolo ? '#6366f108' : 'transparent',
                    display: 'flex', flexDirection: 'column', gap: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: cfg.verificacao_yolo ? 'var(--primary)' : 'var(--text)', letterSpacing: '.03em' }}>
                          Verificação YOLO
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>Anti-falso-positivo</div>
                      </div>
                      <Toggle size="sm" value={cfg.verificacao_yolo ?? true} onChange={v => patch(c.camera_id, 'verificacao_yolo', v)} />
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text2)', lineHeight: 1.5 }}>
                      Captura um frame fresco do stream e roda YOLO novamente antes de disparar o alarme.
                      Suprime detecções únicas de sombras ou artefatos visuais.
                    </div>
                  </div>

                  <div>
                    <label style={lbl}>Destinatários WhatsApp</label>
                    <textarea rows={3} placeholder={'5565999990001\n5565999990002'}
                      value={(cfg.destinatarios ?? []).join('\n')}
                      onChange={e => patch(c.camera_id, 'destinatarios', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
                      className="cfg-inp"
                      style={{ ...smallInp, resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }}
                    />
                    <div style={hint}>Um número por linha · Vazio = número global</div>
                  </div>

                  <div>
                    <label style={lbl}>Mensagem personalizada</label>
                    <textarea rows={3} placeholder={'🚨 {camera} detectou {pessoas} pessoa(s) às {hora}'}
                      value={cfg.mensagem_custom ?? ''}
                      onChange={e => patch(c.camera_id, 'mensagem_custom', e.target.value || null)}
                      className="cfg-inp"
                      style={{ ...smallInp, resize: 'vertical', lineHeight: 1.5 }}
                    />
                    <div style={hint}>{'{camera}'} {'{pessoas}'} {'{hora}'} {'{data}'}</div>
                  </div>
                </div>

                {/* Row 2 — Registered Users */}
                {operators.length > 0 && (
                  <UserPicker
                    operators={operators}
                    selected={cfg.notif_usuarios ?? []}
                    onChange={ids => patch(c.camera_id, 'notif_usuarios', ids)}
                  />
                )}

                {/* Row 3 — Schedule */}
                <ScheduleRow
                  horarioInicio={cfg.horario_inicio ?? null}
                  horarioFim={cfg.horario_fim ?? null}
                  diasSemana={cfg.dias_semana ?? null}
                  onChange={(field, val) => patch(c.camera_id, field as keyof AlarmConfig, val)}
                />
              </div>
            )}
          </div>
        )
      })}

      {/* Info strip */}
      <div style={{
        marginTop: 4, padding: '11px 14px',
        border: '1px solid var(--border)', borderRadius: 8,
        fontSize: 11, color: 'var(--text2)', lineHeight: 1.7,
        display: 'flex', gap: 6, alignItems: 'flex-start',
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1, opacity: .5 }}>
          <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
        </svg>
        <span>
          O motor YOLO detecta pessoas nos streams RTSP/RTMP em tempo real. Ao atingir o limiar de pessoas configurado, o alarme dispara e envia notificações pelos canais ativos. Cartões com borda azul possuem alterações não salvas.
        </span>
      </div>
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const lbl: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--text2)',
  textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
}

const hint: React.CSSProperties = {
  fontSize: 10, color: 'var(--text2)', marginTop: 3, opacity: .7,
}

const smallInp: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text)', boxSizing: 'border-box',
}
