import { stopSiren } from '../hooks/useModuleAlerts'
import type { ModuleAlert } from '../hooks/useModuleAlerts'

interface Props {
  alert: ModuleAlert | null
  soundEnabled: boolean
  visualEnabled: boolean
  onToggleSound: () => void
  onToggleVisual: () => void
  onDismiss: () => void
  accentColor?: string
}

const STYLE_TAG = `
@keyframes bannerIn {
  from { opacity: 0; transform: translateY(-12px); }
  to   { opacity: 1; transform: translateY(0); }
}
`

function IconBell() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 01-3.46 0"/>
      <line x1="12" y1="2" x2="12" y2="3"/>
    </svg>
  )
}

function IconVolume({ muted }: { muted: boolean }) {
  return muted ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M19.07 4.93a10 10 0 010 14.14"/>
      <path d="M15.54 8.46a5 5 0 010 7.07"/>
    </svg>
  )
}

function IconEye({ hidden }: { hidden: boolean }) {
  return hidden ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )
}

export default function ModuleAlertBanner({
  alert,
  soundEnabled,
  visualEnabled,
  onToggleSound,
  onToggleVisual,
  onDismiss,
  accentColor = '#ef4444',
}: Props) {
  if (!alert) {
    return (
      <>
        <style>{STYLE_TAG}</style>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
          <button
            onClick={onToggleSound}
            title={soundEnabled ? 'Silenciar alertas sonoros' : 'Ativar alertas sonoros'}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 6,
              background: soundEnabled ? 'var(--surface2)' : 'var(--surface)',
              border: '1px solid var(--border)',
              color: soundEnabled ? 'var(--text)' : 'var(--text3)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              opacity: soundEnabled ? 1 : 0.6,
            }}
          >
            <IconVolume muted={!soundEnabled} />
            Som
          </button>
          <button
            onClick={onToggleVisual}
            title={visualEnabled ? 'Ocultar alertas visuais' : 'Mostrar alertas visuais'}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 6,
              background: visualEnabled ? 'var(--surface2)' : 'var(--surface)',
              border: '1px solid var(--border)',
              color: visualEnabled ? 'var(--text)' : 'var(--text3)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              opacity: visualEnabled ? 1 : 0.6,
            }}
          >
            <IconEye hidden={!visualEnabled} />
            Visual
          </button>
        </div>
      </>
    )
  }

  const fmtTs = (ts: string) => {
    try {
      const d = new Date(ts)
      const diff = Math.floor((Date.now() - d.getTime()) / 1000)
      if (diff < 60) return `${diff}s atrás`
      if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    } catch { return '' }
  }

  return (
    <>
      <style>{STYLE_TAG}</style>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', borderRadius: 10,
        background: 'var(--surface)',
        border: `1px solid ${accentColor}44`,
        borderLeft: `3px solid ${accentColor}`,
        boxShadow: `0 0 16px ${accentColor}22`,
        animation: 'bannerIn .25s ease',
      }}>
        <span style={{ color: accentColor, flexShrink: 0 }}><IconBell /></span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {alert.message}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>
            {alert.camera && <span>{alert.camera} · </span>}
            {fmtTs(alert.ts)}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            onClick={onToggleSound}
            title={soundEnabled ? 'Silenciar' : 'Ativar som'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--surface2)', border: '1px solid var(--border)',
              color: soundEnabled ? 'var(--text)' : 'var(--text3)',
              cursor: 'pointer',
            }}
          >
            <IconVolume muted={!soundEnabled} />
          </button>
          <button
            onClick={onToggleVisual}
            title={visualEnabled ? 'Ocultar visual' : 'Mostrar visual'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--surface2)', border: '1px solid var(--border)',
              color: visualEnabled ? 'var(--text)' : 'var(--text3)',
              cursor: 'pointer',
            }}
          >
            <IconEye hidden={!visualEnabled} />
          </button>
          <button
            onClick={() => { stopSiren(); onDismiss() }}
            title="Dispensar alerta"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--surface2)', border: '1px solid var(--border)',
              color: 'var(--text2)', cursor: 'pointer', fontSize: 15,
            }}
          >×</button>
        </div>
      </div>
    </>
  )
}
