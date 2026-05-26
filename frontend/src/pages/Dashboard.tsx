import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getDashboardResumo, getAnalyticsResumo,
  type DashboardResumo, type AnalyticsResumo, type UpdateCheck,
} from '../api'
import { format, formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'

function storageUrl(caminho: string | null): string | null {
  if (!caminho) return null
  return caminho.replace(/^\/opt\/suricatha/, '')
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface LiveEvent {
  id: number
  camera_id: number
  placa: string | null
  confianca: number
  validado: boolean
  watchlist_hit: boolean
  divergencia: boolean
  caminho_storage: string | null
  crop_url: string | null
  camera: string
  detectado_em: string
  _new?: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

function pct(n: number, d: number) { return d ? Math.round(n / d * 100) : 0 }

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  return now
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, color, icon, onClick,
}: {
  label: string; value: string | number; sub?: string
  color: string; icon: React.ReactNode; onClick?: () => void
}) {
  return (
    <div className="card stat-card" onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', transition: 'box-shadow .15s' }}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 20px rgba(0,0,0,.12)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '' }}>
      <div className="stat-card-icon" style={{ background: `${color}18`, color }}>{icon}</div>
      <div className="stat-value" style={{ color }}>{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function ModuleCard({
  title, icon, color, children, onClick,
}: {
  title: string; icon: React.ReactNode; color: string
  children: React.ReactNode; onClick?: () => void
}) {
  return (
    <div className="card" style={{
      borderTop: `3px solid ${color}`, cursor: onClick ? 'pointer' : 'default',
      transition: 'box-shadow .15s',
    }}
      onClick={onClick}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 20px rgba(0,0,0,.1)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color }}>
        {icon}
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  )
}

function MetaRow({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 6 }}>
      <span style={{ color: 'var(--text2)' }}>{label}</span>
      <span style={{ fontWeight: 700, color: valueColor ?? 'var(--text)' }}>{value}</span>
    </div>
  )
}

function HealthDot({ ok }: { ok: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: ok ? 'var(--success)' : 'var(--danger)',
      marginRight: 5,
    }} />
  )
}

// ── Update card ───────────────────────────────────────────────────────────────

function UpdateCard({ data, onCheck, checking }: {
  data: Partial<UpdateCheck>
  onCheck: () => void
  checking: boolean
}) {
  if (!data?.saude_geral) return null

  const updates = data as UpdateCheck

  return (
    <div className="card" style={{ marginTop: 0 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:14 }}>Check de Atualização</div>
          <div style={{ fontSize:11, color:'var(--text2)', marginTop:2 }}>
            Último check: {format(new Date(updates.timestamp), 'dd/MM/yyyy HH:mm:ss')}
            {updates.elapsed_s != null && ` · ${updates.elapsed_s}s`}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{
            fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:20,
            background: updates.saude_geral === 'ok' ? 'rgba(34,197,94,.12)' : updates.saude_geral === 'aviso' ? 'rgba(234,179,8,.12)' : 'rgba(239,68,68,.12)',
            color: updates.saude_geral === 'ok' ? 'var(--success)' : updates.saude_geral === 'aviso' ? 'var(--warning)' : 'var(--danger)',
            border: `1px solid ${updates.saude_geral === 'ok' ? 'rgba(34,197,94,.3)' : updates.saude_geral === 'aviso' ? 'rgba(234,179,8,.3)' : 'rgba(239,68,68,.3)'}`,
          }}>
            {updates.saude_geral.toUpperCase()}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onCheck} disabled={checking}>
            {checking ? <span className="spinner" style={{width:12,height:12}}/> : '↻ Verificar agora'}
          </button>
        </div>
      </div>

      {/* Mini-cards de componentes */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:10, marginBottom:14 }}>
        {[
          {
            label: 'Versão Atual', valor: updates.versao.versao_atual,
            ok: updates.versao.atualizado,
            sub: updates.versao.atualizado ? 'Atualizado' : `Nova: ${updates.versao.versao_disponivel}`,
          },
          {
            label: 'Watchdog', valor: updates.watchdog.ok ? 'Rodando' : 'Parado',
            ok: updates.watchdog.ok,
            sub: updates.watchdog.mensagem.substring(0, 40),
          },
          {
            label: 'SFTP Pendentes',
            valor: String((updates.sftp_pendentes.detalhes?.total_pendentes as number) ?? 0),
            ok: updates.sftp_pendentes.ok,
            sub: updates.sftp_pendentes.mensagem.substring(0, 40),
          },
          {
            label: 'Disco',
            valor: `${(updates.disco.detalhes?.pct as number) ?? 0}%`,
            ok: updates.disco.ok,
            sub: updates.disco.mensagem.substring(0, 40),
          },
          {
            label: 'Banco',
            valor: updates.banco.ok ? 'Conectado' : 'Falha',
            ok: updates.banco.ok,
            sub: updates.banco.mensagem.substring(0, 40),
          },
          {
            label: 'Modelos IA',
            valor: updates.modelos.ok ? 'OK' : 'Problema',
            ok: updates.modelos.ok,
            sub: updates.modelos.mensagem.substring(0, 40),
          },
        ].map(item => (
          <div key={item.label} style={{
            background:'var(--surface2)', border:'1px solid var(--border)',
            borderRadius:10, padding:'10px 14px', minWidth:130, flex:1,
          }}>
            <div style={{ fontSize:10, color:'var(--text2)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.05em', marginBottom:4 }}>
              {item.label}
            </div>
            <div style={{ fontSize:18, fontWeight:700, color: item.ok ? 'var(--success)' : 'var(--danger)' }}>
              {item.valor}
            </div>
            <div style={{ fontSize:10, color:'var(--text2)', marginTop:3 }}>{item.sub}</div>
          </div>
        ))}
      </div>

      {/* Alertas */}
      {updates.alertas.length > 0 && (
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {updates.alertas.map((a, i) => (
            <div key={i} style={{
              display:'flex', alignItems:'center', gap:8,
              background:'rgba(234,179,8,.07)', border:'1px solid rgba(234,179,8,.2)',
              borderRadius:8, padding:'8px 12px', fontSize:12, color:'var(--warning)',
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/>
              </svg>
              {a}
            </div>
          ))}
        </div>
      )}

      {updates.alertas.length === 0 && (
        <div style={{ fontSize:12, color:'var(--success)', display:'flex', alignItems:'center', gap:6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          Tudo atualizado e funcionando normalmente
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const nav = useNavigate()
  const { op } = useAuth()
  const now = useClock()

  const [resumo, setResumo]         = useState<DashboardResumo | null>(null)
  const [analytics, setAnalytics]   = useState<AnalyticsResumo[]>([])
  const [live, setLive]             = useState<LiveEvent[]>([])
  const [liveStatus, setLiveStatus] = useState<'connecting'|'live'|'offline'>('connecting')
  const [checking, setChecking]     = useState(false)
  const [newIds, setNewIds]         = useState<Set<number>>(new Set())
  const [muteBeep, setMuteBeep]     = useState(() => localStorage.getItem('lpr_beep_muted') === '1')
  const muteRef                     = useRef(muteBeep)
  muteRef.current                   = muteBeep
  const audioRef                    = useRef<AudioContext | null>(null)

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([getDashboardResumo(), getAnalyticsResumo()])
      setResumo(r.data); setAnalytics(a.data)
    } catch { /* silencioso */ }
  }, [])

  const playAlert = useCallback(() => {
    try {
      if (!audioRef.current) audioRef.current = new AudioContext()
      const ctx = audioRef.current
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.frequency.setValueAtTime(880, ctx.currentTime)
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1)
      gain.gain.setValueAtTime(0.3, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
      osc.start(); osc.stop(ctx.currentTime + 0.4)
    } catch { /* audio não disponível */ }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)

    const base = (import.meta.env.VITE_API_URL ?? '') as string
    const es   = new EventSource(`${base}/api/v1/stream`)
    es.onopen    = () => setLiveStatus('live')
    es.onerror   = () => setLiveStatus('offline')
    es.onmessage = e => {
      try {
        const ev = JSON.parse(e.data)
        if (ev.type === 'connected') { setLiveStatus('live'); return }
        if (ev.type === 'nova_leitura') {
          const entry: LiveEvent = { ...ev, _new: true }
          setLive(prev => [entry, ...prev].slice(0, 50))
          setNewIds(prev => new Set([...prev, ev.id]))
          if (!muteRef.current && (ev.watchlist_hit || ev.beep_lpr)) playAlert()
          setTimeout(() => setNewIds(prev => { const s = new Set(prev); s.delete(ev.id); return s }), 2000)
        }
      } catch { /* skip */ }
    }
    return () => { clearInterval(t); es.close() }
  }, [load, playAlert])

  const triggerCheck = async () => {
    setChecking(true)
    try {
      const { triggerUpdateCheck } = await import('../api')
      const r = await triggerUpdateCheck()
      setResumo(prev => prev ? { ...prev, updates: r.data } : prev)
    } finally { setChecking(false) }
  }

  // ── Date/time formatting ─────────────────────────────────────────────────

  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const dateStr = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
  const dateStrShort = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })

  const lpr   = resumo?.lpr
  const cams  = resumo?.cameras
  const pess  = resumo?.pessoas
  const epi   = resumo?.epi
  const sis   = resumo?.sistema
  const wl    = resumo?.watchlist
  const upd   = (resumo?.updates ?? {}) as Partial<UpdateCheck>

  const hour = now.getHours()
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'
  const firstName = (op?.nome || '').split(' ')[0] || 'Operador'

  return (
    <div className="page">

      {/* ── Cabeçalho com data/hora ────────────────────────────────────────── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        marginBottom: 24, gap: 16,
      }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 2 }}>
            {greeting}, <span style={{ fontWeight: 700, color: 'var(--text)' }}>{firstName}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'capitalize' }}>{dateStr}</div>
        </div>

        {/* Relógio */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '10px 20px',
        }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'monospace', letterSpacing: '.05em', lineHeight: 1 }}>
              {timeStr}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>{dateStrShort}</div>
          </div>
          <div style={{ color: 'var(--primary)', opacity: .7 }}>
            <Icon d="M12 2a10 10 0 100 20A10 10 0 0012 2z M12 6v6l4 2" size={22} />
          </div>
        </div>
      </div>

      {/* ── Cards LPR principais ──────────────────────────────────────────── */}
      <div className="grid-4 mb-24">
        <StatCard
          label="Leituras LPR 24h"
          value={lpr?.total_24h ?? '—'}
          sub={`${lpr?.total_1h ?? 0} na última hora`}
          color="var(--primary)"
          icon={<Icon d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />}
          onClick={() => nav('/deteccoes')}
        />
        <StatCard
          label="Validadas 24h"
          value={lpr?.validadas_24h ?? '—'}
          sub={`${pct(lpr?.validadas_24h ?? 0, lpr?.total_24h ?? 0)}% de aproveitamento`}
          color="var(--success)"
          icon={<Icon d="M9 12l2 2 4-4M22 12A10 10 0 112 12a10 10 0 0120 0z" />}
          onClick={() => nav('/deteccoes')}
        />
        <StatCard
          label="Alertas Watchlist"
          value={lpr?.alertas_24h ?? '—'}
          sub={`${wl?.total ?? 0} placas monitoradas`}
          color={(lpr?.alertas_24h ?? 0) > 0 ? 'var(--danger)' : 'var(--text2)'}
          icon={<Icon d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01" />}
          onClick={() => nav('/watchlist')}
        />
        <StatCard
          label="Tempo Médio OCR"
          value={lpr?.tempo_medio_ms != null ? `${lpr.tempo_medio_ms}ms` : '—'}
          sub="Processamento de placa"
          color="var(--info, #06b6d4)"
          icon={<Icon d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />}
        />
      </div>

      {/* ── Cards de módulos ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>

        {/* Câmeras */}
        <ModuleCard title="Câmeras" color="var(--primary)"
          icon={<Icon d="M23 7l-7 5 7 5V7z M1 5h14a2 2 0 012 2v10a2 2 0 01-2 2H1a2 2 0 01-2-2V7a2 2 0 012-2z" size={15} />}
          onClick={() => nav('/cameras')}>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--primary)', lineHeight: 1, marginBottom: 10 }}>
            {cams?.total_ativas ?? '—'}
          </div>
          <MetaRow label="Online"
            value={<><HealthDot ok={true} />{cams?.online ?? 0}</>}
            valueColor="var(--success)" />
          <MetaRow label="Offline"
            value={cams?.offline ?? 0}
            valueColor={(cams?.offline ?? 0) > 0 ? 'var(--danger)' : 'var(--text2)'} />
          <MetaRow label="Sem verificação" value={cams?.desconhecidas ?? 0} />
        </ModuleCard>

        {/* Pessoas */}
        <ModuleCard title="Contagem de Pessoas" color="var(--info, #06b6d4)"
          icon={<Icon d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75" size={15} />}
          onClick={() => nav('/pessoas')}>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--info, #06b6d4)', lineHeight: 1, marginBottom: 10 }}>
            {pess?.total_pessoas_24h ?? '—'}
          </div>
          <MetaRow label="Frames analisados" value={pess?.frames_24h ?? 0} />
          <MetaRow label="Pico 24h" value={`${pess?.pico_24h ?? 0} pessoas`} />
          <MetaRow label="Alertas de lotação"
            value={pess?.alertas_24h ?? 0}
            valueColor={(pess?.alertas_24h ?? 0) > 0 ? 'var(--danger)' : 'var(--text2)'} />
        </ModuleCard>

        {/* EPI */}
        <ModuleCard title="EPI / PPE" color="var(--warning, #f59e0b)"
          icon={<Icon d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" size={15} />}
          onClick={() => nav('/epi')}>
          <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, marginBottom: 10,
            color: (epi?.conformidade_media ?? 100) >= 80 ? 'var(--success)' : 'var(--danger)' }}>
            {epi?.eventos_24h ? `${epi.conformidade_media}%` : '—'}
          </div>
          <MetaRow label="Conformidade média" value={`${epi?.conformidade_media ?? 0}%`} />
          <MetaRow label="Eventos analisados" value={epi?.eventos_24h ?? 0} />
          <MetaRow label="Violações 24h"
            value={epi?.violacoes_24h ?? 0}
            valueColor={(epi?.violacoes_24h ?? 0) > 0 ? 'var(--danger)' : 'var(--success)'} />
        </ModuleCard>

        {/* Sistema */}
        <ModuleCard title="Sistema" color="var(--text2)"
          icon={<Icon d="M12 2a10 10 0 100 20A10 10 0 0012 2z M12 8v4l3 3" size={15} />}
          onClick={() => nav('/sistema')}>
          <div style={{ marginBottom: 10 }}>
            {/* Disco progress bar */}
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
              <span>Disco</span>
              <span style={{ fontWeight: 700, color: (sis?.disco_uso_pct ?? 0) > 85 ? 'var(--danger)' : 'var(--text)' }}>
                {sis?.disco_uso_pct ?? '—'}%
              </span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 3,
                width: `${Math.min(sis?.disco_uso_pct ?? 0, 100)}%`,
                background: (sis?.disco_uso_pct ?? 0) > 85 ? 'var(--danger)' : 'var(--primary)',
                transition: 'width .5s',
              }} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 3 }}>
              {sis?.disco_livre_gb ?? '—'} GB livres de {sis?.disco_total_gb ?? '—'} GB
            </div>
          </div>
          <MetaRow label="Alertas Telegram"
            value={sis?.alertas_telegram ? 'Ativo' : 'Inativo'}
            valueColor={sis?.alertas_telegram ? 'var(--success)' : 'var(--text2)'} />
          <MetaRow label="Alertas WhatsApp"
            value={sis?.alertas_whatsapp ? 'Ativo' : 'Inativo'}
            valueColor={sis?.alertas_whatsapp ? 'var(--success)' : 'var(--text2)'} />
        </ModuleCard>
      </div>

      {/* ── Check de atualizações (full width) ───────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <UpdateCard data={upd} onCheck={triggerCheck} checking={checking} />
      </div>

      {/* ── Live + Analytics ─────────────────────────────────────────────── */}
      <div className="grid-2">

        {/* Live Feed */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: liveStatus === 'live' ? '#22c55e' : liveStatus === 'offline' ? '#ef4444' : '#818cf8',
              boxShadow: liveStatus === 'live' ? '0 0 0 0 rgba(34,197,94,.6)' : 'none',
              animation: liveStatus === 'live' ? 'pulse-dot 1.8s ease-in-out infinite' : 'none',
            }} />
            <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Leituras em Tempo Real</span>
            <button
              title={muteBeep ? 'Som desativado — clique para ativar' : 'Som ativado — clique para silenciar'}
              onClick={() => {
                const next = !muteBeep
                setMuteBeep(next)
                localStorage.setItem('lpr_beep_muted', next ? '1' : '0')
                if (!next) playAlert()
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '3px 10px', borderRadius: 20, border: '1px solid var(--border)',
                background: muteBeep ? 'var(--surface2)' : 'rgba(34,197,94,.1)',
                color: muteBeep ? 'var(--text3)' : '#22c55e',
                cursor: 'pointer', fontSize: 11, fontWeight: 600,
                transition: 'all .2s',
              }}
            >
              {muteBeep
                ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg> Mudo</>
                : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg> Som LPR</>
              }
            </button>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: liveStatus === 'live' ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
              color: liveStatus === 'live' ? '#22c55e' : '#ef4444',
              border: `1px solid ${liveStatus === 'live' ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
            }}>
              {liveStatus === 'live' ? '● AO VIVO' : liveStatus === 'offline' ? '✕ OFFLINE' : '○ CONECTANDO'}
            </span>
            {live.length > 0 && (
              <span style={{
                fontSize: 10, color: 'var(--text3)',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 20, padding: '2px 8px',
              }}>
                {live.length} leituras
              </span>
            )}
          </div>

          {live.length === 0 ? (
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 10,
              color: 'var(--text3)', padding: '32px 0',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".4">
                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                <path d="M10 10h.01M14 10h.01M10 7h4"/>
              </svg>
              <div style={{ fontSize: 12 }}>
                {liveStatus === 'live' ? 'Aguardando novas leituras…' : 'Reconectando ao servidor…'}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', margin: '0 -4px' }}>
              {live.slice(0, 20).map((ev) => {
                const imgUrl   = storageUrl(ev.crop_url) ?? storageUrl(ev.caminho_storage)
                const isNew    = newIds.has(ev.id)
                const hasPlaca = !!ev.placa
                const conf     = ev.confianca ?? 0
                const confColor = conf > .85 ? '#22c55e' : conf > .6 ? '#f59e0b' : '#6b7280'

                return (
                  <div
                    key={ev.id}
                    onClick={() => nav('/deteccoes')}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '7px 4px', borderRadius: 8,
                      background: isNew
                        ? ev.watchlist_hit ? 'rgba(239,68,68,.08)' : 'rgba(99,102,241,.07)'
                        : 'transparent',
                      borderLeft: `3px solid ${ev.watchlist_hit ? '#ef4444' : isNew ? 'var(--primary)' : 'transparent'}`,
                      cursor: 'pointer', transition: 'background .6s',
                      animation: isNew ? 'slideIn .3s ease-out' : 'none',
                    }}
                  >
                    {/* Thumbnail */}
                    <div style={{
                      width: 56, height: 38, borderRadius: 6, flexShrink: 0,
                      background: '#0a0a0a', overflow: 'hidden', position: 'relative',
                    }}>
                      {imgUrl ? (
                        <img src={imgUrl} alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="1.5">
                            <rect x="2" y="3" width="20" height="14" rx="2"/>
                          </svg>
                        </div>
                      )}
                    </div>

                    {/* Placa */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          fontFamily: 'monospace', fontSize: 15, fontWeight: 800,
                          letterSpacing: 2, color: hasPlaca ? 'var(--text)' : 'var(--text3)',
                        }}>
                          {ev.placa || 'SEM PLACA'}
                        </span>
                        {ev.watchlist_hit && (
                          <span style={{
                            background: '#ef4444', color: '#fff',
                            borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 800,
                            letterSpacing: '.05em',
                          }}>⚠ ALERTA</span>
                        )}
                        {ev.divergencia && (
                          <span style={{
                            background: 'rgba(245,158,11,.2)', color: '#f59e0b',
                            borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 700,
                          }}>DIV</span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ev.camera}
                      </div>
                    </div>

                    {/* Confiança */}
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: confColor }}>
                        {conf > 0 ? `${(conf * 100).toFixed(0)}%` : '—'}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                        {ev.detectado_em
                          ? formatDistanceToNow(new Date(ev.detectado_em), { locale: ptBR, addSuffix: true })
                          : ''}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Footer */}
          <div style={{
            marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>
              Últimas 20 leituras · todas as câmeras
            </span>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 11 }}
              onClick={() => nav('/deteccoes')}
            >
              Ver todas →
            </button>
          </div>
        </div>

        {/* Analytics por câmera */}
        <div className="card">
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            Analytics por Câmera
            <span style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 400 }}>últimas 24h</span>
          </div>

          {analytics.length === 0 ? (
            <div className="empty-state" style={{ padding: '28px 16px' }}>
              <div style={{ color: 'var(--text2)', fontSize: 12 }}>Nenhuma câmera ativa</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Câmera</th><th style={{ textAlign: 'center' }}>LPR</th><th style={{ textAlign: 'center' }}>Pessoas</th><th style={{ textAlign: 'center' }}>EPI</th></tr>
                </thead>
                <tbody>
                  {analytics.map(r => (
                    <tr key={r.camera_id}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 12 }}>{r.camera_nome}</div>
                        <div style={{ fontSize: 10, color: 'var(--text2)' }}>{r.camera_local}</div>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{r.lpr_deteccoes_24h}</div>
                        {r.lpr_alertas_24h > 0 &&
                          <div style={{ color: 'var(--danger)', fontSize: 10 }}>{r.lpr_alertas_24h} alerta(s)</div>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {r.rec_contagem_pessoas
                          ? <><div style={{ fontWeight: 700, fontSize: 13 }}>{r.pessoas_total_24h}</div>
                              <div style={{ fontSize: 10, color: 'var(--text2)' }}>pico: {r.pessoas_pico_24h}</div></>
                          : <span className="badge badge-gray" style={{ fontSize: 10 }}>OFF</span>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {r.rec_epi
                          ? <span className={`badge ${r.epi_violacoes_24h > 0 ? 'badge-red' : 'badge-green'}`} style={{ fontSize: 10 }}>
                              {r.epi_conformidade_media.toFixed(0)}%
                            </span>
                          : <span className="badge badge-gray" style={{ fontSize: 10 }}>OFF</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

    </div>
  )
}
