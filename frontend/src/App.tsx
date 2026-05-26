import { useState, useEffect, useRef, useCallback } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import { getTheme, applyTheme, type Theme } from './theme'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Deteccoes from './pages/Deteccoes'
import Cameras from './pages/Cameras'
import Watchlist from './pages/Watchlist'
import Analytics from './pages/Analytics'
import LeituraPessoas from './pages/LeituraPessoas'
import LeituraEPI from './pages/LeituraEPI'
import Sistema from './pages/Sistema'
import Usuarios from './pages/Usuarios'
import Perfil from './pages/Perfil'
import CCTV from './pages/CCTV'
import AlarmeCCTV from './pages/AlarmeCCTV'
import WhatsApp from './pages/WhatsApp'
import Telegram from './pages/Telegram'
import Automacoes from './pages/Automacoes'
import IntelbrasAPI from './pages/IntelbrasAPI'
import HikvisionAPI from './pages/HikvisionAPI'
import Relatorios from './pages/Relatorios'
import Portaria from './pages/Portaria'
import PreCadastro from './pages/PreCadastro'
import VideoTelemetrica from './pages/VideoTelemetrica'
import api from './api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AlertItem {
  id: string; tipo: string; severidade: 'critico' | 'aviso' | 'info'
  titulo: string; mensagem: string
  contexto?: { link?: string; [k: string]: unknown }
  ts: string
}
interface AlertsData {
  total: number; criticos: number; avisos: number; infos?: number
  alertas: AlertItem[]; ts: string
}

interface Toast {
  id: string; color: string; moduleLabel: string; moduleIcon: string
  title: string; body: string; link?: string; ts: number; duration: number
}

// ── Module metadata ───────────────────────────────────────────────────────────

const MODULE_META: Record<string, { label: string; color: string; icon: string }> = {
  '/deteccoes': { label: 'Leitura LPR',  color: '#3b82f6', icon: 'M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z' },
  '/cameras':   { label: 'Câmeras',      color: '#64748b', icon: 'M23 7l-7 5 7 5V7z M1 5h14a2 2 0 012 2v10a2 2 0 01-2 2H1a2 2 0 01-2-2V7a2 2 0 012-2z' },
  '/alarme':    { label: 'Alarme CCTV',  color: '#ef4444', icon: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0' },
  '/epi':       { label: 'EPI / PPE',    color: '#f59e0b', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  '/pessoas':   { label: 'Contagem',     color: '#f97316', icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z' },
  '/sistema':   { label: 'Sistema',      color: '#8b5cf6', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33' },
  '/whatsapp':  { label: 'WhatsApp',     color: '#25D366', icon: 'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72' },
  '/telegram':  { label: 'Telegram',     color: '#229ED9', icon: 'M22 2L11 13 M22 2L15 22l-4-9-9-4 22-7z' },
  '/portaria':  { label: 'Portaria',     color: '#10b981', icon: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M8 22v-5h8v5' },
  '/telemetria':{ label: 'Telemétrica',  color: '#f59e0b', icon: 'M1 3h4l2.68 13.39a2 2 0 001.97 1.61h9.72a2 2 0 001.97-1.61L23 6H6' },
}

const TIPO_PATH: Record<string, string> = {
  camera_offline: '/cameras',   camera_sem_check: '/cameras',
  watchlist_hit:  '/deteccoes', erro_lpr: '/deteccoes', divergencia_lpr: '/deteccoes',
  alerta_lotacao: '/pessoas',   lotacao: '/pessoas',
  alarme_cctv:    '/alarme',
  epi_violacao:   '/epi',
  sistema:        '/sistema',   disco: '/sistema', disco_cheio: '/sistema', modelo_ia: '/sistema',
  whatsapp_offline:    '/whatsapp',
  telegram_offline:    '/telegram',
  portaria_sugestao:   '/portaria',
  portaria_nao_agendado: '/portaria',
}

// ── Alert icon ────────────────────────────────────────────────────────────────

function AlertIcon({ tipo, sev }: { tipo: string; sev: string }) {
  const color = sev === 'critico' ? '#ef4444' : sev === 'aviso' ? '#f59e0b' : '#94a3b8'
  const paths: Record<string, string> = {
    camera_offline:    'M23 1L1 23 M17 6H3a2 2 0 00-2 2v8a2 2 0 002 2h4m5 0h5a2 2 0 002-2V8a2 2 0 00-.59-1.41',
    camera_sem_check:  'M15 10l4.553-2.07A1 1 0 0121 8.845V15a1 1 0 01-1.445.894L15 14M3 8h12v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z',
    watchlist_hit:     'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4',
    erro_lpr:          'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
    divergencia_lpr:   'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
    alerta_lotacao:    'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
    alarme_cctv:       'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
    epi_violacao:      'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    sistema:           'M22 12h-4l-3 9L9 3l-3 9H2',
    disco:             'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z',
    disco_cheio:       'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z',
    modelo_ia:         'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3M6.343 6.343l-.707-.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
    whatsapp_offline:  'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72',
    telegram_offline:  'M22 2L11 13 M22 2L15 22l-4-9-9-4 22-7z',
  }
  const d = paths[tipo] ?? 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  )
}

function fmtTs(ts: string) {
  try {
    const d = new Date(ts), diffMin = Math.floor((Date.now() - d.getTime()) / 60000)
    if (diffMin < 1)  return 'agora'
    if (diffMin < 60) return `${diffMin}min atrás`
    const h = Math.floor(diffMin / 60)
    if (h < 24) return `${h}h atrás`
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
  } catch { return '' }
}

// ── Toast Stack ───────────────────────────────────────────────────────────────

function ToastCard({ toast, onDismiss, onNavigate }: {
  toast: Toast; onDismiss: () => void; onNavigate: (link: string) => void
}) {
  const [progress, setProgress] = useState(100)
  const [exiting, setExiting] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const dismiss = useCallback(() => {
    setExiting(true)
    setTimeout(onDismiss, 220)
  }, [onDismiss])

  useEffect(() => {
    const step = 100 / (toast.duration / 80)
    intervalRef.current = setInterval(() => {
      setProgress(p => {
        if (p <= step) { clearInterval(intervalRef.current!); dismiss(); return 0 }
        return p - step
      })
    }, 80)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [toast.duration, dismiss])

  const mod = MODULE_META[toast.link ?? ''] ?? { color: toast.color, label: toast.moduleLabel, icon: toast.moduleIcon }

  return (
    <div
      onClick={() => { if (toast.link) { onNavigate(toast.link); dismiss() } }}
      style={{
        width: 316, borderRadius: 10, overflow: 'hidden',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${mod.color}`,
        boxShadow: '0 6px 28px rgba(0,0,0,.18), 0 1px 4px rgba(0,0,0,.08)',
        cursor: toast.link ? 'pointer' : 'default',
        animation: exiting
          ? 'toastOut .22s cubic-bezier(.4,0,1,1) forwards'
          : 'toastIn .28s cubic-bezier(0,0,.2,1)',
        position: 'relative',
        userSelect: 'none',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '9px 10px 0 12px',
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke={mod.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0 }}>
          <path d={mod.icon} />
        </svg>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
          textTransform: 'uppercase', color: mod.color, flex: 1,
        }}>
          {mod.label}
        </span>
        <button
          onClick={e => { e.stopPropagation(); dismiss() }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text3)', padding: '2px 4px', lineHeight: 0,
            borderRadius: 4, display: 'flex', alignItems: 'center',
            opacity: .6,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '6px 12px 10px' }}>
        <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)', lineHeight: 1.35, marginBottom: 2 }}>
          {toast.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.45 }}>
          {toast.body}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 2, background: 'var(--border)' }}>
        <div style={{
          height: '100%', background: mod.color, opacity: .7,
          width: `${progress}%`, transition: 'width .08s linear',
        }} />
      </div>
    </div>
  )
}

function ToastStack({ toasts, onDismiss, onNavigate }: {
  toasts: Toast[]; onDismiss: (id: string) => void; onNavigate: (link: string) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      display: 'flex', flexDirection: 'column-reverse', gap: 8,
      pointerEvents: 'none',
    }}>
      {toasts.slice(-4).map(t => (
        <div key={t.id} style={{ pointerEvents: 'all' }}>
          <ToastCard
            toast={t}
            onDismiss={() => onDismiss(t.id)}
            onNavigate={onNavigate}
          />
        </div>
      ))}
    </div>
  )
}

// ── Notification panel ────────────────────────────────────────────────────────

function NotifPanel({
  data, dismissed, onDismissAll, onDismissOne, onNavigate, onClose,
}: {
  data: AlertsData; dismissed: Set<string>
  onDismissAll: () => void; onDismissOne: (id: string) => void
  onNavigate: (link: string) => void; onClose: () => void
}) {
  const visible = data.alertas.filter(a => !dismissed.has(a.id))
  const critFirst = [...visible].sort((a, b) => {
    const order = { critico: 0, aviso: 1, info: 2 }
    return (order[a.severidade] ?? 3) - (order[b.severidade] ?? 3)
  })

  const sevStyle = (sev: string): React.CSSProperties => ({
    fontSize: 9, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' as const,
    padding: '1px 5px', borderRadius: 4,
    background: sev === 'critico' ? 'rgba(239,68,68,.12)' : sev === 'aviso' ? 'rgba(245,158,11,.10)' : 'rgba(148,163,184,.1)',
    color:      sev === 'critico' ? '#ef4444'              : sev === 'aviso' ? '#f59e0b'              : '#94a3b8',
  })

  return (
    <div style={{
      position: 'fixed', top: 53, right: 16, width: 368,
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,.25), 0 4px 12px rgba(0,0,0,.1)',
      zIndex: 900, overflow: 'hidden',
      animation: 'panelIn .18s cubic-bezier(0,.6,.3,1)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '13px 14px 12px', borderBottom: '1px solid var(--border)',
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text2)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', flex: 1 }}>Notificações</span>
        {data.criticos > 0 && <span style={sevStyle('critico')}>{data.criticos} crítico{data.criticos > 1 ? 's' : ''}</span>}
        {data.avisos > 0 && <span style={sevStyle('aviso')}>{data.avisos} aviso{data.avisos > 1 ? 's' : ''}</span>}
        {visible.length > 0 && (
          <button onClick={onDismissAll} style={{
            fontSize: 10, color: 'var(--text3)', background: 'none', border: 'none',
            cursor: 'pointer', padding: '3px 6px', borderRadius: 5,
            transition: 'color .15s',
          }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text2)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text3)')}
          >
            Limpar tudo
          </button>
        )}
        <button onClick={onClose} style={{
          width: 24, height: 24, borderRadius: 6, background: 'none',
          border: 'none', cursor: 'pointer', color: 'var(--text2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {critFirst.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 24, marginBottom: 10, opacity: .3 }}>✓</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', fontWeight: 500 }}>Nenhum alerta ativo</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>O sistema está funcionando normalmente</div>
          </div>
        ) : critFirst.map(a => {
          const pathLink = a.contexto?.link as string | undefined
          const mod = MODULE_META[pathLink ?? '']
          const accentColor = mod?.color ?? (a.severidade === 'critico' ? '#ef4444' : a.severidade === 'aviso' ? '#f59e0b' : '#94a3b8')
          return (
            <div
              key={a.id}
              onClick={() => { if (pathLink) { onNavigate(pathLink); onClose() } }}
              style={{
                display: 'flex', gap: 11, padding: '11px 14px',
                borderBottom: '1px solid var(--border)',
                borderLeft: `2px solid ${accentColor}`,
                cursor: pathLink ? 'pointer' : 'default',
                transition: 'background .12s',
              }}
              onMouseEnter={e => { if (pathLink) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface2)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              <div style={{ paddingTop: 1 }}>
                <AlertIcon tipo={a.tipo} sev={a.severidade} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)' }}>{a.titulo}</span>
                  <span style={sevStyle(a.severidade)}>
                    {a.severidade === 'critico' ? 'crítico' : a.severidade === 'aviso' ? 'aviso' : 'info'}
                  </span>
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--text2)', lineHeight: 1.5,
                  overflow: 'hidden', display: '-webkit-box',
                  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}>
                  {a.mensagem}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 5 }}>{fmtTs(a.ts)}</div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); onDismissOne(a.id) }}
                style={{
                  flexShrink: 0, alignSelf: 'flex-start', background: 'none', border: 'none',
                  cursor: 'pointer', color: 'var(--text3)', padding: '2px 4px',
                  borderRadius: 4, lineHeight: 0, transition: 'color .15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text2)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text3)')}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>

      {critFirst.length > 0 && (
        <div style={{
          padding: '8px 14px', borderTop: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text3)', textAlign: 'center',
        }}>
          Atualizado a cada 30 s · Clique em um alerta para navegar
        </div>
      )}
    </div>
  )
}

// ── Page meta ─────────────────────────────────────────────────────────────────

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  '/':              { title: 'Dashboard',          subtitle: 'Visão geral do sistema' },
  '/deteccoes':     { title: 'Leitura LPR',        subtitle: 'Detecções de placas por câmeras LPR' },
  '/pessoas':       { title: 'Leitura Pessoas',    subtitle: 'Contagem de pessoas por câmeras' },
  '/epi':           { title: 'Leitura EPI / PPE',  subtitle: 'Análise de uso de equipamentos de proteção' },
  '/cameras':       { title: 'Câmeras',            subtitle: 'Gerenciamento de câmeras' },
  '/watchlist':     { title: 'Watchlist',          subtitle: 'Placas monitoradas' },
  '/analytics':     { title: 'Analytics',          subtitle: 'Resumo por câmera' },
  '/cctv':          { title: 'Play CCTV',          subtitle: 'Visualização ao vivo das câmeras' },
  '/alarme':        { title: 'Alarme CCTV',        subtitle: 'Detecção de pessoas e notificações em tempo real' },
  '/sistema':       { title: 'Sistema',            subtitle: 'Saúde e configurações' },
  '/usuarios':      { title: 'Gestão de Usuários', subtitle: 'Controle de acesso e perfis' },
  '/perfil':        { title: 'Meu Perfil',         subtitle: 'Informações da conta' },
  '/whatsapp':      { title: 'WhatsApp',           subtitle: 'Configuração da Evolution API' },
  '/telegram':      { title: 'Telegram Bot',       subtitle: 'Configuração do bot de notificações' },
  '/automacoes':    { title: 'Automações',         subtitle: 'Regras de alerta automáticas por evento' },
  '/api-intelbras': { title: 'API Intelbras',      subtitle: 'Documentação da API HTTP/CGI das câmeras' },
  '/api-hikvision': { title: 'API Hikvision',      subtitle: 'Documentação da API ISAPI das câmeras Hikvision' },
  '/relatorios':    { title: 'Relatórios',         subtitle: 'Geração de relatórios personalizados com exportação PDF' },
  '/portaria':      { title: 'Gestão de Portaria', subtitle: 'Controle de acesso · visitantes · integração LPR' },
  '/telemetria':    { title: 'Vídeo Telemétrica',  subtitle: 'Fadiga · Celular · Distração — Monitoramento em tempo real' },
}

// ── Topbar ────────────────────────────────────────────────────────────────────

function Topbar({
  path, theme, onToggleTheme,
  alertsData, dismissed, onDismissAll, onDismissOne,
}: {
  path: string; theme: Theme; onToggleTheme: () => void
  alertsData: AlertsData | null; dismissed: Set<string>
  onDismissAll: () => void; onDismissOne: (id: string) => void
}) {
  const nav  = useNavigate()
  const meta = PAGE_META[path] || { title: 'SuricathaIA', subtitle: '' }
  const now  = new Date().toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })

  const [panelOpen, setPanelOpen] = useState(false)
  const [bellRing, setBellRing]   = useState(false)
  const panelRef   = useRef<HTMLDivElement>(null)
  const bellRef    = useRef<HTMLButtonElement>(null)
  const prevBadge  = useRef(0)

  const visibleAlerts = alertsData?.alertas.filter(a => !dismissed.has(a.id)) ?? []
  const critCount  = visibleAlerts.filter(a => a.severidade === 'critico').length
  const warnCount  = visibleAlerts.filter(a => a.severidade === 'aviso').length
  const badgeCount = critCount + warnCount
  const badgeColor = critCount > 0 ? '#ef4444' : '#f59e0b'

  // Animate bell when new alerts arrive
  useEffect(() => {
    if (badgeCount > prevBadge.current && prevBadge.current >= 0) {
      setBellRing(true)
      setTimeout(() => setBellRing(false), 700)
    }
    prevBadge.current = badgeCount
  }, [badgeCount])

  useEffect(() => {
    if (!panelOpen) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        bellRef.current  && !bellRef.current.contains(e.target as Node)
      ) setPanelOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [panelOpen])

  return (
    <header className="topbar">
      <style>{`
        @keyframes toastIn  { from { transform: translateX(110%); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
        @keyframes toastOut { from { transform: translateX(0);    opacity: 1 } to { transform: translateX(110%); opacity: 0 } }
        @keyframes panelIn  { from { transform: translateY(-6px) scale(.97); opacity: 0 } to { transform: none; opacity: 1 } }
        @keyframes bellRing { 0%,100%{transform:rotate(0)} 15%{transform:rotate(-18deg)} 30%{transform:rotate(16deg)} 45%{transform:rotate(-12deg)} 60%{transform:rotate(10deg)} 75%{transform:rotate(-6deg)} }
        @keyframes badgePop { 0%{transform:scale(.5)} 70%{transform:scale(1.25)} 100%{transform:scale(1)} }
      `}</style>

      <div className="topbar-left">
        <div>
          <div className="topbar-title">{meta.title}</div>
          {meta.subtitle && <div className="topbar-subtitle">{meta.subtitle}</div>}
        </div>
      </div>

      <div className="topbar-right">

        {/* Date chip */}
        <div className="topbar-chip" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
          </svg>
          {now}
        </div>

        {/* Online chip */}
        <div className="topbar-chip">
          <span className="live-dot" />
          Online
        </div>

        {/* Theme toggle */}
        <button className="topbar-btn" onClick={onToggleTheme}
          title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}>
          {theme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
            </svg>
          )}
        </button>

        {/* Bell */}
        <div style={{ position: 'relative' }}>
          <button
            ref={bellRef}
            onClick={() => setPanelOpen(v => !v)}
            title="Notificações"
            className={`topbar-btn${panelOpen ? ' active' : ''}`}
            style={{ position: 'relative' }}
          >
            <span style={{
              display: 'inline-flex',
              animation: bellRing ? 'bellRing .7s ease' : undefined,
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0" />
              </svg>
            </span>

            {badgeCount > 0 && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                minWidth: 15, height: 15, borderRadius: 8,
                background: badgeColor, color: '#fff',
                fontSize: 9, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '2px solid var(--surface)', padding: '0 2px',
                lineHeight: 1,
                animation: 'badgePop .35s cubic-bezier(0,0,.2,1.5)',
              }}>
                {badgeCount > 9 ? '9+' : badgeCount}
              </span>
            )}
          </button>

          {panelOpen && alertsData && (
            <div ref={panelRef}>
              <NotifPanel
                data={alertsData}
                dismissed={dismissed}
                onDismissAll={onDismissAll}
                onDismissOne={onDismissOne}
                onNavigate={nav}
                onClose={() => setPanelOpen(false)}
              />
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

// ── Guard ─────────────────────────────────────────────────────────────────────

function Guard({ children, path, theme, onToggleTheme }: {
  children: React.ReactNode; path: string
  theme: Theme; onToggleTheme: () => void
}) {
  const nav = useNavigate()
  if (!localStorage.getItem('api_key')) return <Navigate to="/login" replace />

  const [alertsData, setAlertsData] = useState<AlertsData | null>(null)
  const [dismissed, setDismissed]   = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dismissed_alerts') ?? '[]')) }
    catch { return new Set() }
  })
  const [toasts, setToasts] = useState<Toast[]>([])

  // ── Fetch alerts ─────────────────────────────────────────────────────────
  const fetchAlerts = useCallback(async () => {
    if (!localStorage.getItem('api_key')) return
    try {
      const r = await api.get<AlertsData>('/api/v1/alerts')
      setAlertsData(r.data)
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetchAlerts()
    const t = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(t)
  }, [fetchAlerts])

  // ── SSE toasts ───────────────────────────────────────────────────────────
  const addToast = useCallback((t: Omit<Toast, 'id' | 'ts' | 'duration'>) => {
    const id = `toast_${Date.now()}_${Math.random()}`
    setToasts(prev => [...prev.slice(-3), { ...t, id, ts: Date.now(), duration: 6000 }])
  }, [])

  useEffect(() => {
    if (!localStorage.getItem('api_key')) return
    const base = (import.meta.env.VITE_API_URL ?? '')
    const es = new EventSource(`${base}/api/v1/stream`)
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.type === 'alarm_cctv') {
          addToast({
            color: '#ef4444', moduleLabel: 'Alarme CCTV',
            moduleIcon: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
            title: `${d.total_pessoas} pessoa${d.total_pessoas !== 1 ? 's' : ''} detectada${d.total_pessoas !== 1 ? 's' : ''}`,
            body: d.camera_nome ?? 'Câmera desconhecida',
            link: '/alarme',
          })
        } else if (d.type === 'nova_leitura' && d.watchlist_hit) {
          addToast({
            color: '#ef4444', moduleLabel: 'Watchlist',
            moduleIcon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4',
            title: `Placa monitorada detectada`,
            body: `${d.placa ?? '—'} · ${d.camera ?? 'câmera desconhecida'}`,
            link: '/deteccoes',
          })
        } else if (d.type === 'nova_leitura' && d.divergencia) {
          addToast({
            color: '#f59e0b', moduleLabel: 'Leitura LPR',
            moduleIcon: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
            title: 'Divergência detectada',
            body: `${d.placa ?? '—'} · ${d.camera ?? 'câmera desconhecida'}`,
            link: '/deteccoes',
          })
        }
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [addToast])

  // ── Nav badges ────────────────────────────────────────────────────────────
  const navBadges: Record<string, string> = {}
  for (const alert of (alertsData?.alertas ?? [])) {
    if (dismissed.has(alert.id) || alert.severidade === 'info') continue
    const p = TIPO_PATH[alert.tipo]
    if (!p) continue
    if (!navBadges[p] || alert.severidade === 'critico') {
      navBadges[p] = alert.severidade === 'critico' ? '#ef4444' : '#f59e0b'
    }
  }

  // ── Dismiss helpers ───────────────────────────────────────────────────────
  const dismissAll = () => {
    const all = new Set([...dismissed, ...(alertsData?.alertas.map(a => a.id) ?? [])])
    setDismissed(all)
    localStorage.setItem('dismissed_alerts', JSON.stringify([...all]))
  }
  const dismissOne = (id: string) => {
    const next = new Set([...dismissed, id])
    setDismissed(next)
    localStorage.setItem('dismissed_alerts', JSON.stringify([...next]))
  }
  const dismissToast = (id: string) => setToasts(p => p.filter(t => t.id !== id))

  return (
    <div className="layout">
      <Sidebar theme={theme} onToggleTheme={onToggleTheme} navBadges={navBadges} />
      <div className="main">
        <Topbar
          path={path} theme={theme} onToggleTheme={onToggleTheme}
          alertsData={alertsData} dismissed={dismissed}
          onDismissAll={dismissAll} onDismissOne={dismissOne}
        />
        {children}
        <footer style={{
          padding: '12px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          fontSize: 11, color: 'var(--text2)', lineHeight: 1.5,
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .5 }}>
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/>
          </svg>
          <span style={{ opacity: .55 }}>Desenvolvido por</span>
          <strong style={{ fontWeight: 700, opacity: .85 }}>Vission</strong>
          <span style={{ opacity: .3 }}>·</span>
          <a href="https://vission.com.br" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none', opacity: .65 }}>
            vission.com.br
          </a>
          <span style={{ opacity: .3 }}>·</span>
          <span style={{ opacity: .65 }}>(65) 4042-0466</span>
        </footer>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismissToast} onNavigate={(link) => { nav(link); dismissToast('') }} />
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [, setTick] = useState(0)

  useEffect(() => {
    const handler = () => setTick(t => t + 1)
    window.addEventListener('operador-updated', handler)
    return () => window.removeEventListener('operador-updated', handler)
  }, [])

  useEffect(() => {
    if (!localStorage.getItem('api_key')) return
    api.get('/api/v1/auth/me').then(r => {
      const d = r.data
      const stored = JSON.parse(localStorage.getItem('operador') || '{}')
      const updated = { ...stored, nome: d.nome, email: d.email, perfil: d.perfil, avatar: d.avatar ?? null }
      localStorage.setItem('operador', JSON.stringify(updated))
      setTick(t => t + 1)
    }).catch(() => {})
  }, [])

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setThemeState(next)
  }

  const G = ({ children, path }: { children: React.ReactNode; path: string }) => (
    <Guard path={path} theme={theme} onToggleTheme={toggleTheme}>{children}</Guard>
  )

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"         element={<Login />} />
        <Route path="/pre-cadastro"  element={<PreCadastro />} />
        <Route path="/"              element={<G path="/"><Dashboard /></G>} />
        <Route path="/deteccoes"     element={<G path="/deteccoes"><Deteccoes /></G>} />
        <Route path="/pessoas"       element={<G path="/pessoas"><LeituraPessoas /></G>} />
        <Route path="/epi"           element={<G path="/epi"><LeituraEPI /></G>} />
        <Route path="/cameras"       element={<G path="/cameras"><Cameras /></G>} />
        <Route path="/watchlist"     element={<G path="/watchlist"><Watchlist /></G>} />
        <Route path="/analytics"     element={<G path="/analytics"><Analytics /></G>} />
        <Route path="/cctv"          element={<G path="/cctv"><CCTV /></G>} />
        <Route path="/alarme"        element={<G path="/alarme"><AlarmeCCTV /></G>} />
        <Route path="/sistema"       element={<G path="/sistema"><Sistema /></G>} />
        <Route path="/usuarios"      element={<G path="/usuarios"><Usuarios /></G>} />
        <Route path="/perfil"        element={<G path="/perfil"><Perfil /></G>} />
        <Route path="/whatsapp"      element={<G path="/whatsapp"><WhatsApp /></G>} />
        <Route path="/telegram"      element={<G path="/telegram"><Telegram /></G>} />
        <Route path="/automacoes"    element={<G path="/automacoes"><Automacoes /></G>} />
        <Route path="/api-intelbras" element={<G path="/api-intelbras"><IntelbrasAPI /></G>} />
        <Route path="/api-hikvision" element={<G path="/api-hikvision"><HikvisionAPI /></G>} />
        <Route path="/relatorios"    element={<G path="/relatorios"><Relatorios /></G>} />
        <Route path="/portaria"      element={<G path="/portaria"><Portaria /></G>} />
        <Route path="/telemetria"    element={<G path="/telemetria"><VideoTelemetrica /></G>} />
        <Route path="*"              element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
