import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import logoSuricatha from '../assets/logo-suricatha.png'
import { savePermMap, type PermMap } from '../hooks/useAuth'

type Tab = 'usuario' | 'apikey'

const CSS = `
@keyframes scan {
  0%   { top: -2px; opacity: 0; }
  5%   { opacity: 1; }
  95%  { opacity: .6; }
  100% { top: 100%; opacity: 0; }
}
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes pulse-ring {
  0%   { box-shadow: 0 0 0 0 rgba(14,165,233,.45); }
  70%  { box-shadow: 0 0 0 7px rgba(14,165,233,0); }
  100% { box-shadow: 0 0 0 0 rgba(14,165,233,0); }
}
@keyframes drift1 {
  0%,100% { transform: translate(0,0); }
  50%     { transform: translate(40px,-30px); }
}
@keyframes drift2 {
  0%,100% { transform: translate(0,0); }
  50%     { transform: translate(-35px,45px); }
}
@keyframes bracket-in {
  from { opacity:0; transform: scale(.93); }
  to   { opacity:1; transform: scale(1); }
}
@keyframes crosshair-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.l-input {
  width: 100%; box-sizing: border-box;
  background: rgba(14,165,233,.04);
  border: 1px solid rgba(14,165,233,.14);
  border-radius: 9px; padding: 12px 16px;
  font-size: 14px; color: #e2eaf5; outline: none;
  transition: border-color .2s, box-shadow .2s, background .2s;
  font-family: inherit;
}
.l-input::placeholder { color: rgba(148,180,210,.25); }
.l-input:focus {
  border-color: rgba(14,165,233,.55);
  background: rgba(14,165,233,.07);
  box-shadow: 0 0 0 3px rgba(14,165,233,.09);
}
.l-btn {
  width: 100%; height: 46px; border: none; border-radius: 9px;
  background: linear-gradient(135deg, #0369a1 0%, #0891b2 100%);
  color: #e0f2fe; font-size: 14px; font-weight: 700;
  letter-spacing: .3px; cursor: pointer;
  transition: opacity .2s, transform .15s, box-shadow .2s;
  box-shadow: 0 4px 20px rgba(8,145,178,.28);
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: 6px; font-family: inherit;
}
.l-btn:hover:not(:disabled) {
  opacity:.93; transform:translateY(-1px);
  box-shadow: 0 8px 28px rgba(8,145,178,.38);
}
.l-btn:active:not(:disabled) { transform:translateY(0); }
.l-btn:disabled { opacity:.3; cursor:not-allowed; box-shadow:none; }

.l-tab {
  flex:1; padding:8px 0; border:none; cursor:pointer;
  border-radius:7px; font-size:12.5px; font-weight:600;
  transition:all .2s; background:transparent;
  color:rgba(148,180,210,.35); font-family:inherit; letter-spacing:.2px;
}
.l-tab.active {
  background: rgba(14,165,233,.12);
  color: rgba(224,242,254,.85);
  box-shadow: inset 0 0 0 1px rgba(14,165,233,.3);
}
.l-tab:not(.active):hover { color:rgba(148,180,210,.6); }

.feat-row { display:flex; align-items:flex-start; gap:13px; animation: fadeUp .5s ease both; }
`

const FEATURES = [
  {
    icon: 'M15 10l4.553-2.069A1 1 0 0121 8.87V15.13a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z',
    label: 'Ingestão Segura — Edge Computing',
    desc: 'Processamento local sem dependência de nuvem, latência mínima garantida.',
  },
  {
    icon: 'M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z',
    label: 'OCR Double-Check de Alta Precisão',
    desc: 'Validação dupla de placas com confiabilidade acima de 98% em qualquer condição.',
  },
  {
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    label: 'Alertas em Tempo Real',
    desc: 'Notificações críticas via Telegram e WhatsApp com resposta em milissegundos.',
  },
  {
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    label: 'Detecção de EPI / PPE',
    desc: 'IA embarcada para conformidade de capacete e colete em áreas de risco.',
  },
  {
    icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
    label: 'Monitoramento de Fluxo de Pessoas',
    desc: 'Contagem inteligente, detecção de lotação e gestão de perímetros críticos.',
  },
]

function EyeIcon({ open }: { open: boolean }) {
  return open
    ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
}

/* Grade tática de fundo */
function GridCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight }
    resize()
    window.addEventListener('resize', resize)
    const SIZE = 48
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = 'rgba(14,165,233,.055)'
    ctx.lineWidth = .5
    for (let x = 0; x <= canvas.width; x += SIZE) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
    }
    for (let y = 0; y <= canvas.height; y += SIZE) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
    }
    // dot intersections
    ctx.fillStyle = 'rgba(14,165,233,.18)'
    for (let x = 0; x <= canvas.width; x += SIZE)
      for (let y = 0; y <= canvas.height; y += SIZE) {
        ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill()
      }
    return () => window.removeEventListener('resize', resize)
  }, [])
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
}

export default function Login() {
  const [tab, setTab]         = useState<Tab>('usuario')
  const [email, setEmail]     = useState('')
  const [senha, setSenha]     = useState('')
  const [apiKey, setApiKey]   = useState('')
  const [err, setErr]         = useState('')
  const [loading, setLoading] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const nav = useNavigate()

  const submitUser = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !senha) return
    setLoading(true); setErr('')
    try {
      const r = await api.post('/api/v1/auth/login', { email, senha })
      localStorage.setItem('api_key', r.data.access_token)
      localStorage.setItem('operador', JSON.stringify(r.data.operador))
      try {
        const p = await api.get('/api/v1/config/permissoes')
        savePermMap(p.data as PermMap)
      } catch { /* mantém defaults locais */ }
      nav('/')
    } catch { setErr('E-mail ou senha incorretos.') }
    finally { setLoading(false) }
  }

  const submitKey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim()) return
    setLoading(true); setErr('')
    try {
      const r = await api.post('/api/v1/token', { api_key: apiKey.trim() })
      localStorage.setItem('api_key', r.data.access_token)
      nav('/')
    } catch { setErr('API Key inválida.') }
    finally { setLoading(false) }
  }

  return (
    <>
      <style>{CSS}</style>
      <div style={{
        minHeight: '100vh', display: 'flex', overflow: 'hidden',
        background: '#070a12',
      }}>

        {/* ══ PAINEL ESQUERDO ══ */}
        <div style={{
          flex: '0 0 54%', position: 'relative',
          display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '48px 64px',
          overflow: 'hidden',
        }}>

          {/* Grade */}
          <GridCanvas />

          {/* Orbs frios */}
          <div style={{
            position: 'absolute', top: '-12%', left: '-8%',
            width: 560, height: 560, borderRadius: '50%', pointerEvents: 'none',
            background: 'radial-gradient(circle, rgba(8,145,178,.09) 0%, transparent 60%)',
            animation: 'drift1 20s ease-in-out infinite',
          }} />
          <div style={{
            position: 'absolute', bottom: '-15%', right: '-5%',
            width: 440, height: 440, borderRadius: '50%', pointerEvents: 'none',
            background: 'radial-gradient(circle, rgba(2,132,199,.07) 0%, transparent 60%)',
            animation: 'drift2 26s ease-in-out infinite',
          }} />

          {/* Scanline */}
          <div style={{
            position: 'absolute', left: 0, right: 0, height: '1px',
            background: 'linear-gradient(90deg, transparent 0%, rgba(14,165,233,.5) 40%, rgba(56,189,248,.7) 50%, rgba(14,165,233,.5) 60%, transparent 100%)',
            animation: 'scan 9s linear infinite',
            pointerEvents: 'none', zIndex: 2,
          }} />

          {/* Separador vertical direito */}
          <div style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 1,
            background: 'linear-gradient(to bottom, transparent 0%, rgba(14,165,233,.18) 30%, rgba(56,189,248,.22) 50%, rgba(14,165,233,.18) 70%, transparent 100%)',
          }} />

          {/* ─ Logo ─ */}
          <div style={{ position: 'relative', zIndex: 3 }}>
            <img src={logoSuricatha} alt="SuricathaIA"
              style={{ height: 68, width: 'auto', objectFit: 'contain', opacity: .93,
                filter: 'brightness(0) invert(1)' }} />
          </div>

          {/* ─ Hero ─ */}
          <div style={{ position: 'relative', zIndex: 3, maxWidth: 480 }}>

            {/* Viewfinder decoration */}
            <div style={{
              position: 'absolute', top: -50, left: -40,
              width: 120, height: 120, pointerEvents: 'none',
              animation: 'bracket-in .8s ease both',
            }}>
              {/* corner brackets */}
              {[
                { top: 0, left: 0, borderTop: '2px solid rgba(14,165,233,.35)', borderLeft: '2px solid rgba(14,165,233,.35)' },
                { top: 0, right: 0, borderTop: '2px solid rgba(14,165,233,.35)', borderRight: '2px solid rgba(14,165,233,.35)' },
                { bottom: 0, left: 0, borderBottom: '2px solid rgba(14,165,233,.35)', borderLeft: '2px solid rgba(14,165,233,.35)' },
                { bottom: 0, right: 0, borderBottom: '2px solid rgba(14,165,233,.35)', borderRight: '2px solid rgba(14,165,233,.35)' },
              ].map((s, i) => (
                <div key={i} style={{ position: 'absolute', width: 18, height: 18, ...s }} />
              ))}
            </div>

            {/* Status chip */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: 'rgba(14,165,233,.07)',
              border: '1px solid rgba(14,165,233,.2)',
              borderRadius: 20, padding: '5px 14px', marginBottom: 30,
            }}>
              <span style={{
                display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                background: '#38bdf8', boxShadow: '0 0 6px #38bdf8',
              }} />
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 1.2,
                textTransform: 'uppercase', color: 'rgba(56,189,248,.8)',
              }}>
                Monitoramento 24 / 7 · Missão Crítica
              </span>
            </div>

            <h1 style={{
              fontSize: 38, fontWeight: 900, lineHeight: 1.1,
              color: '#e8f4fb', marginBottom: 16, letterSpacing: -1.2,
            }}>
              Plataforma{' '}
              <span style={{
                background: 'linear-gradient(90deg, #38bdf8 0%, #7dd3fc 60%, #bae6fd 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>
                Inteligente
              </span>
              <br />de Segurança LPR
            </h1>

            <p style={{
              fontSize: 13, lineHeight: 1.85,
              color: 'rgba(148,180,210,.42)', marginBottom: 44, maxWidth: 400,
            }}>
              LPR, EPI e contagem de pessoas convergindo em uma
              arquitetura de borda robusta, autossuficiente e de alta disponibilidade.
            </p>

            {/* Features */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {FEATURES.map((f, i) => (
                <div key={f.label} className="feat-row" style={{ animationDelay: `${i * .07}s` }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                    background: 'rgba(14,165,233,.07)',
                    border: '1px solid rgba(14,165,233,.18)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="rgba(56,189,248,.8)" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round">
                      <path d={f.icon} />
                    </svg>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(224,242,254,.7)', marginBottom: 2, letterSpacing: .1 }}>
                      {f.label}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(148,180,210,.35)', lineHeight: 1.6 }}>
                      {f.desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ─ Rodapé ─ */}
          <div style={{ position: 'relative', zIndex: 3 }}>
            <div style={{ fontSize: 10.5, color: 'rgba(148,180,210,.28)', marginBottom: 8 }}>
              SuricathaIA © {new Date().getFullYear()} · Todos os direitos reservados
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 10,
              background: 'rgba(14,165,233,.06)',
              border: '1px solid rgba(14,165,233,.18)',
              borderRadius: 10, padding: '8px 14px',
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                background: 'linear-gradient(135deg, rgba(14,165,233,.25) 0%, rgba(56,189,248,.15) 100%)',
                border: '1px solid rgba(56,189,248,.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(56,189,248,.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: .8, textTransform: 'uppercase', color: 'rgba(56,189,248,.5)', marginBottom: 2 }}>
                  Desenvolvido por
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'rgba(224,242,254,.75)', letterSpacing: .2 }}>
                    Vission
                  </span>
                  <span style={{ fontSize: 10.5, color: 'rgba(14,165,233,.35)' }}>·</span>
                  <a href="https://vission.com.br" target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 11, color: 'rgba(56,189,248,.6)', textDecoration: 'none', letterSpacing: .3 }}>
                    vission.com.br
                  </a>
                  <span style={{ fontSize: 10.5, color: 'rgba(14,165,233,.35)' }}>·</span>
                  <span style={{ fontSize: 11.5, color: 'rgba(56,189,248,.6)', letterSpacing: .3 }}>
                    (65) 4042-0466
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ══ PAINEL DIREITO ══ */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '48px 40px', position: 'relative',
          background: 'rgba(5,8,16,.6)',
        }}>

          {/* Glow central */}
          <div style={{
            position: 'absolute', top: '15%', left: '50%', transform: 'translateX(-50%)',
            width: 360, height: 360, borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(8,145,178,.05) 0%, transparent 65%)',
            pointerEvents: 'none',
          }} />

          {/* Crosshair decorativo topo-direito */}
          <div style={{
            position: 'absolute', top: 32, right: 32, width: 40, height: 40,
            opacity: .2, pointerEvents: 'none',
            animation: 'fadeIn 1.5s ease both',
          }}>
            <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: '#38bdf8', transform: 'translateY(-50%)' }} />
            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#38bdf8', transform: 'translateX(-50%)' }} />
            <div style={{ position: 'absolute', inset: 4, borderRadius: '50%', border: '1px solid #38bdf8' }} />
          </div>

          <div style={{
            width: '100%', maxWidth: 360, position: 'relative', zIndex: 1,
            animation: 'fadeUp .55s ease both',
          }}>

            {/* Card principal */}
            <div style={{
              background: 'rgba(14,165,233,.03)',
              border: '1px solid rgba(14,165,233,.11)',
              borderRadius: 18, padding: '36px 32px',
              backdropFilter: 'blur(24px)',
              boxShadow: '0 24px 64px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04)',
            }}>

              {/* Título */}
              <div style={{ marginBottom: 26 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase',
                  color: 'rgba(56,189,248,.5)', marginBottom: 10,
                }}>
                  Acesso Seguro
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#dbeafe', letterSpacing: -.4, lineHeight: 1.2 }}>
                  Identifique-se para<br />continuar
                </div>
              </div>

              {/* Tabs */}
              <div style={{
                display: 'flex', gap: 4,
                background: 'rgba(0,0,0,.35)',
                border: '1px solid rgba(14,165,233,.08)',
                borderRadius: 9, padding: 4, marginBottom: 24,
              }}>
                {(['usuario', 'apikey'] as Tab[]).map(t => (
                  <button key={t} className={`l-tab${tab === t ? ' active' : ''}`}
                    onClick={() => { setTab(t); setErr('') }}>
                    {t === 'usuario' ? 'Usuário' : 'API Key'}
                  </button>
                ))}
              </div>

              {/* Form usuário */}
              {tab === 'usuario' && (
                <form onSubmit={submitUser} style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                  <div>
                    <label style={{
                      display: 'block', fontSize: 10, fontWeight: 700,
                      color: 'rgba(148,180,210,.4)', marginBottom: 7,
                      letterSpacing: 1, textTransform: 'uppercase',
                    }}>E-mail</label>
                    <input className="l-input" type="email"
                      placeholder="operador@empresa.com"
                      value={email} onChange={e => setEmail(e.target.value)} autoFocus />
                  </div>
                  <div>
                    <label style={{
                      display: 'block', fontSize: 10, fontWeight: 700,
                      color: 'rgba(148,180,210,.4)', marginBottom: 7,
                      letterSpacing: 1, textTransform: 'uppercase',
                    }}>Senha</label>
                    <div style={{ position: 'relative' }}>
                      <input className="l-input"
                        type={showPwd ? 'text' : 'password'} placeholder="••••••••"
                        value={senha} onChange={e => setSenha(e.target.value)}
                        style={{ paddingRight: 44 }} />
                      <button type="button" onClick={() => setShowPwd(v => !v)} style={{
                        position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'rgba(148,180,210,.3)', display: 'flex', alignItems: 'center', padding: 0,
                      }}>
                        <EyeIcon open={showPwd} />
                      </button>
                    </div>
                  </div>

                  {err && (
                    <div style={{
                      background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.18)',
                      borderRadius: 8, padding: '10px 14px', color: '#fca5a5', fontSize: 12.5,
                    }}>{err}</div>
                  )}

                  <button className="l-btn" type="submit" disabled={loading || !email || !senha}>
                    {loading ? <span className="spinner" style={{ width: 17, height: 17 }} /> : 'Entrar'}
                  </button>
                </form>
              )}

              {/* Form API Key */}
              {tab === 'apikey' && (
                <form onSubmit={submitKey} style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                  <div>
                    <label style={{
                      display: 'block', fontSize: 10, fontWeight: 700,
                      color: 'rgba(148,180,210,.4)', marginBottom: 7,
                      letterSpacing: 1, textTransform: 'uppercase',
                    }}>API Key</label>
                    <input className="l-input font-mono"
                      type="password" placeholder="Cole sua chave aqui"
                      value={apiKey} onChange={e => setApiKey(e.target.value)} autoFocus
                      style={{ letterSpacing: 1 }} />
                    <div style={{ fontSize: 11, color: 'rgba(148,180,210,.25)', marginTop: 6 }}>
                      Para acesso por integração ou sistemas externos.
                    </div>
                  </div>

                  {err && (
                    <div style={{
                      background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.18)',
                      borderRadius: 8, padding: '10px 14px', color: '#fca5a5', fontSize: 12.5,
                    }}>{err}</div>
                  )}

                  <button className="l-btn" type="submit" disabled={loading || !apiKey.trim()}>
                    {loading ? <span className="spinner" style={{ width: 17, height: 17 }} /> : 'Autenticar'}
                  </button>
                </form>
              )}
            </div>

            {/* Status operacional */}
            <div style={{
              marginTop: 20, display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: 8,
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', background: '#22d3ee',
                animation: 'pulse-ring 2.2s ease-in-out infinite',
              }} />
              <span style={{ fontSize: 11, color: 'rgba(148,180,210,.22)', letterSpacing: .3 }}>
                Sistema operacional
              </span>
            </div>
          </div>
        </div>

      </div>
    </>
  )
}
