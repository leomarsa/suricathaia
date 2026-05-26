import { useState, useEffect, useRef } from 'react'

interface WaConfig {
  url: string; key: string; instance: string; phone: string
  provider: string; configured: boolean
}
interface WaStatus {
  ok: boolean; state: string; instance?: string; phone?: string
  url?: string; error?: string; qrcode?: string | null
}

const BRAND = '#25D366'
const apiKey = () => localStorage.getItem('api_key') || ''
const hdr = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey()}` })

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(path, { ...opts, headers: { ...hdr(), ...(opts?.headers || {}) } })
  if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || JSON.stringify(e)) }
  return r.json()
}

function Ico({ d, size = 15 }: { d: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
}

const STATE: Record<string, { label: string; color: string }> = {
  open:           { label: 'Conectado',      color: '#22c55e' },
  close:          { label: 'Desconectado',   color: '#ef4444' },
  connecting:     { label: 'Conectando…',    color: '#f59e0b' },
  not_configured: { label: 'Não configurado',color: '#94a3b8' },
  error:          { label: 'Erro',           color: '#ef4444' },
  unknown:        { label: 'Desconhecido',   color: '#94a3b8' },
}

export default function WhatsApp() {
  const [cfg, setCfg]         = useState<WaConfig | null>(null)
  const [status, setStatus]   = useState<WaStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [url, setUrl]           = useState('')
  const [key, setKey]           = useState('')
  const [instance, setInstance] = useState('')
  const [phone, setPhone]       = useState('')
  const [provider, setProvider] = useState('evolution')
  const [showKey, setShowKey]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [saveMsg, setSaveMsg]   = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const [testPhone, setTestPhone]   = useState('')
  const [testMsg, setTestMsg]       = useState('✅ SuricathaIA — Teste de conectividade WhatsApp OK!')
  const [testing, setTesting]       = useState(false)
  const [testResult, setTestResult] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const [action, setAction] = useState('')
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    loadAll()
    poll.current = setInterval(refreshStatus, 25_000)
    return () => { if (poll.current) clearInterval(poll.current) }
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [c, s] = await Promise.all([
        apiFetch('/api/v1/whatsapp/config'),
        apiFetch('/api/v1/whatsapp/status').catch(() => ({ ok: false, state: 'error' })),
      ])
      setCfg(c); setStatus(s)
      setUrl(c.url || ''); setInstance(c.instance || '')
      setPhone(c.phone || ''); setProvider(c.provider || 'evolution')
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  async function refreshStatus() {
    setRefreshing(true)
    try { setStatus(await apiFetch('/api/v1/whatsapp/status').catch(() => ({ ok: false, state: 'error' }))) }
    finally { setRefreshing(false) }
  }

  async function saveConfig() {
    if (!url || !instance) { setSaveMsg({ type: 'err', text: 'URL e Instância são obrigatórios' }); return }
    if (!key && !cfg?.configured) { setSaveMsg({ type: 'err', text: 'API Key é obrigatória' }); return }
    setSaving(true); setSaveMsg(null)
    try {
      await apiFetch('/api/v1/whatsapp/config', { method: 'PUT', body: JSON.stringify({ url, key: key || '', instance, phone, provider }) })
      setSaveMsg({ type: 'ok', text: 'Configuração salva' })
      setKey(''); await loadAll()
    } catch (e: unknown) { setSaveMsg({ type: 'err', text: e instanceof Error ? e.message : String(e) }) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(null), 4000) }
  }

  async function instanceAction(act: 'restart' | 'logout') {
    setAction(act)
    try { await apiFetch(`/api/v1/whatsapp/instance/${act}`, { method: 'POST' }); setTimeout(refreshStatus, 2000) }
    catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)) }
    finally { setAction('') }
  }

  async function sendTest() {
    setTesting(true); setTestResult(null)
    try {
      const r = await apiFetch('/api/v1/whatsapp/send-test', { method: 'POST', body: JSON.stringify({ phone: testPhone || undefined, message: testMsg || undefined }) })
      setTestResult({ type: 'ok', text: r.message || 'Mensagem enviada' })
    } catch (e: unknown) { setTestResult({ type: 'err', text: e instanceof Error ? e.message : String(e) }) }
    finally { setTesting(false) }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text2)', fontSize: 13 }}>
      Carregando…
    </div>
  )

  const st = STATE[status?.state || 'unknown'] || STATE.unknown
  const connected = status?.state === 'open'

  return (
    <div style={{ padding: '28px 32px', maxWidth: 680, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
        .cfg-inp { transition: border-color .15s; }
        .cfg-inp:focus { outline: none; border-color: ${BRAND} !important; }
        .cfg-inp:focus + .cfg-inp-line { transform: scaleX(1); }
        .ghost-btn:hover { background: var(--surface2) !important; }
        .ghost-btn-danger:hover { background: #fee2e2 !important; color: #dc2626 !important; border-color: #fca5a5 !important; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: BRAND,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
            <path d="M12 0C5.373 0 0 5.373 0 12c0 2.115.55 4.102 1.516 5.829L0 24l6.335-1.499A11.946 11.946 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.96 0-3.8-.534-5.373-1.462L2 22l1.484-4.532A9.954 9.954 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: 'var(--text)', letterSpacing: '-.01em' }}>
            WhatsApp
          </h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text2)' }}>Evolution API · Notificações em tempo real</p>
        </div>
        {/* Integration active/inactive badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', borderRadius: 20,
          background: cfg?.configured && connected ? '#dcfce7' : '#f1f5f9',
          border: `1px solid ${cfg?.configured && connected ? '#86efac' : 'var(--border)'}`,
          flexShrink: 0,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: cfg?.configured && connected ? '#22c55e' : cfg?.configured ? '#f59e0b' : '#94a3b8',
            boxShadow: cfg?.configured && connected ? '0 0 0 2px #86efac' : undefined,
          }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: cfg?.configured && connected ? '#16a34a' : '#64748b' }}>
            {cfg?.configured && connected ? 'Ativo' : cfg?.configured ? 'Configurado' : 'Inativo'}
          </span>
        </div>
      </div>

      {/* ── Status card ── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, marginBottom: 12, overflow: 'hidden',
      }}>
        {/* accent bar */}
        <div style={{ height: 3, background: connected ? BRAND : status?.state === 'connecting' ? '#f59e0b' : 'var(--border)' }} />

        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: st.color, flexShrink: 0,
                animation: status?.state === 'connecting' ? 'blink 1.2s infinite' : undefined,
                boxShadow: connected ? `0 0 0 3px ${BRAND}22` : undefined,
              }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{st.label}</span>
              {status?.instance && (
                <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 4 }}>· {status.instance}</span>
              )}
              {status?.phone && (
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>· {status.phone}</span>
              )}
            </div>

            <button
              onClick={refreshStatus} disabled={refreshing}
              className="ghost-btn"
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px',
                border: '1px solid var(--border)', borderRadius: 6,
                background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text2)',
              }}
            >
              <span style={{ display: 'inline-block', animation: refreshing ? 'spin .8s linear infinite' : undefined }}>
                <Ico d="M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15" size={12} />
              </span>
              Atualizar
            </button>
          </div>

          {status?.error && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: '#ef4444' }}>{status.error}</p>
          )}

          {/* QR code */}
          {status?.qrcode && (
            <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text2)', textAlign: 'center' }}>
                Escaneie com o WhatsApp do celular monitor
              </p>
              <div style={{ padding: 12, background: '#fff', borderRadius: 10, border: '1px solid var(--border)' }}>
                {status.qrcode.startsWith('data:')
                  ? <img src={status.qrcode} alt="QR Code" style={{ width: 200, height: 200, display: 'block' }} />
                  : <div style={{ fontFamily: 'monospace', fontSize: 9, wordBreak: 'break-all', maxWidth: 200, color: '#111' }}>{status.qrcode}</div>
                }
              </div>
            </div>
          )}

          {/* Instance actions */}
          {cfg?.configured && (
            <div style={{ display: 'flex', gap: 8, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <button
                onClick={() => instanceAction('restart')} disabled={action === 'restart'}
                className="ghost-btn"
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px',
                  border: '1px solid var(--border)', borderRadius: 6, background: 'transparent',
                  cursor: 'pointer', fontSize: 12, color: 'var(--text2)', opacity: action === 'restart' ? .5 : 1,
                }}
              >
                <Ico d="M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15" size={12} />
                {action === 'restart' ? 'Reiniciando…' : 'Reiniciar'}
              </button>
              <button
                onClick={() => instanceAction('logout')} disabled={action === 'logout'}
                className="ghost-btn ghost-btn-danger"
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px',
                  border: '1px solid var(--border)', borderRadius: 6, background: 'transparent',
                  cursor: 'pointer', fontSize: 12, color: 'var(--text2)', opacity: action === 'logout' ? .5 : 1,
                }}
              >
                <Ico d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9" size={12} />
                {action === 'logout' ? 'Desconectando…' : 'Desconectar'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Config form ── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, marginBottom: 12,
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
            Configuração
          </span>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          <Field label="URL da Evolution API">
            <input className="cfg-inp" style={inpStyle} placeholder="https://evolution.example.com"
              value={url} onChange={e => setUrl(e.target.value)} />
          </Field>

          <Field label="API Key">
            <div style={{ position: 'relative' }}>
              <input className="cfg-inp"
                style={{ ...inpStyle, paddingRight: 36 }}
                type={showKey ? 'text' : 'password'}
                placeholder={cfg?.configured ? '(salva — preencha para alterar)' : 'Global API Key'}
                value={key} onChange={e => setKey(e.target.value)}
              />
              <button onClick={() => setShowKey(v => !v)} style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', padding: 2, lineHeight: 0,
              }}>
                <Ico d={showKey
                  ? 'M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94 M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19 M1 1l22 22'
                  : 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 100 6 3 3 0 000-6z'
                } size={14} />
              </button>
            </div>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Nome da Instância">
              <input className="cfg-inp" style={inpStyle} placeholder="suricatha"
                value={instance} onChange={e => setInstance(e.target.value)} />
            </Field>
            <Field label="Telefone padrão (DDI+número)">
              <input className="cfg-inp" style={inpStyle} placeholder="5565999990001"
                value={phone} onChange={e => setPhone(e.target.value)} />
            </Field>
          </div>

          <Field label="Provider">
            <select style={{ ...inpStyle, cursor: 'pointer' }} value={provider} onChange={e => setProvider(e.target.value)}>
              <option value="evolution">Evolution API</option>
              <option value="baileys">Baileys</option>
              <option value="whatsapp-business">WhatsApp Business API</option>
            </select>
          </Field>
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={saveConfig} disabled={saving}
            style={{
              padding: '7px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: saving ? 'var(--text2)' : BRAND, color: '#fff', fontSize: 13,
              fontWeight: 600, opacity: saving ? .6 : 1, transition: 'opacity .15s',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Ico d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z M17 21v-8H7v8 M7 3v5h8" size={13} />
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
          {saveMsg && (
            <span style={{ fontSize: 12, color: saveMsg.type === 'ok' ? '#22c55e' : '#ef4444', display: 'flex', alignItems: 'center', gap: 4 }}>
              {saveMsg.type === 'ok' ? '✓' : '✕'} {saveMsg.text}
            </span>
          )}
        </div>
      </div>

      {/* ── Test ── */}
      {cfg?.configured && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, marginBottom: 12,
        }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
              Teste de envio
            </span>
          </div>
          <div style={{ padding: '16px 20px', display: 'flex', gap: 12 }}>
            <div style={{ flex: '0 0 180px' }}>
              <Field label="Destinatário">
                <input className="cfg-inp" style={inpStyle}
                  placeholder={cfg.phone || '5565999990001'}
                  value={testPhone} onChange={e => setTestPhone(e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Mensagem">
                <input className="cfg-inp" style={inpStyle}
                  value={testMsg} onChange={e => setTestMsg(e.target.value)} />
              </Field>
            </div>
          </div>
          <div style={{ padding: '0 20px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={sendTest} disabled={testing}
              style={{
                padding: '7px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
                background: testing ? 'var(--text2)' : '#16a34a', color: '#fff', fontSize: 13,
                fontWeight: 600, opacity: testing ? .6 : 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <Ico d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" size={13} />
              {testing ? 'Enviando…' : 'Enviar'}
            </button>
            {testResult && (
              <span style={{ fontSize: 12, color: testResult.type === 'ok' ? '#22c55e' : '#ef4444', display: 'flex', alignItems: 'center', gap: 4 }}>
                {testResult.type === 'ok' ? '✓' : '✕'} {testResult.text}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Help ── */}
      <details style={{ borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
        <summary style={{
          padding: '13px 20px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.08em',
          background: 'var(--surface)', listStyle: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          userSelect: 'none',
        }}>
          Como configurar
          <Ico d="M6 9l6 6 6-6" size={13} />
        </summary>
        <div style={{ padding: '12px 20px 16px', background: 'var(--surface)' }}>
          <ol style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--text2)', lineHeight: 2 }}>
            <li>Instale a <strong style={{ color: 'var(--text)' }}>Evolution API</strong> em seu servidor (Docker recomendado)</li>
            <li>Preencha a URL base da API · ex: <code style={codeStyle}>https://api.dominio.com</code></li>
            <li>Cole a API Key gerada nas configurações da Evolution API</li>
            <li>Informe o nome da instância criada · ex: <code style={codeStyle}>suricatha</code></li>
            <li>Salve e escaneie o QR code com o celular monitor</li>
            <li>O status muda para <strong style={{ color: BRAND }}>Conectado</strong> após o pareamento</li>
          </ol>
        </div>
      </details>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text2)', marginBottom: 5, letterSpacing: '.05em', textTransform: 'uppercase' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const inpStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7, fontSize: 13,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', boxSizing: 'border-box',
}

const codeStyle: React.CSSProperties = {
  fontFamily: 'monospace', fontSize: 11, background: 'var(--surface2)',
  padding: '1px 5px', borderRadius: 4, color: 'var(--text)',
}
