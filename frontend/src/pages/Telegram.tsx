import { useState, useEffect } from 'react'

interface TgConfig  { token: string; chat_id: string; parse_mode: string; configured: boolean }
interface BotInfo   { ok: boolean; bot_name?: string; bot_username?: string; error?: string }
interface ChatInfo  { ok: boolean; title?: string; type?: string; error?: string }
interface TgStatus  { ok: boolean; configured: boolean; bot: BotInfo | null; chat: ChatInfo | null }

const BRAND = '#229ED9'
const hdr = () => ({ 'Content-Type': 'application/json', 'X-API-Key': localStorage.getItem('api_key') || '' })

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(path, { ...opts, headers: { ...hdr(), ...(opts?.headers || {}) } })
  if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || JSON.stringify(e)) }
  return r.json()
}

function Ico({ d, size = 15 }: { d: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
}

function Chip({ ok, label }: { ok: boolean | null; label: string }) {
  const c = ok === null ? '#94a3b8' : ok ? '#22c55e' : '#ef4444'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text2)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />
      <span style={{ color: ok ? 'var(--text)' : '#ef4444', fontWeight: ok ? 500 : 400 }}>{label}</span>
    </span>
  )
}

export default function Telegram() {
  const [cfg, setCfg]         = useState<TgConfig | null>(null)
  const [status, setStatus]   = useState<TgStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)

  const [token, setToken]         = useState('')
  const [chatId, setChatId]       = useState('')
  const [parseMode, setParseMode] = useState('Markdown')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving]       = useState(false)
  const [saveMsg, setSaveMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const [testMsg, setTestMsg]       = useState('✅ SuricathaIA — Teste de conectividade Telegram OK!')
  const [testing, setTesting]       = useState(false)
  const [testResult, setTestResult] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [c, s] = await Promise.all([
        apiFetch('/api/v1/telegram/config'),
        apiFetch('/api/v1/telegram/status').catch(() => ({ ok: false, configured: false, bot: null, chat: null })),
      ])
      setCfg(c); setStatus(s)
      setChatId(c.chat_id || ''); setParseMode(c.parse_mode || 'Markdown')
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  async function checkStatus() {
    setChecking(true)
    try { setStatus(await apiFetch('/api/v1/telegram/status').catch(() => ({ ok: false, configured: false, bot: null, chat: null }))) }
    finally { setChecking(false) }
  }

  async function save() {
    if (!token && !cfg?.configured) { setSaveMsg({ type: 'err', text: 'Token é obrigatório' }); return }
    if (!chatId) { setSaveMsg({ type: 'err', text: 'Chat ID é obrigatório' }); return }
    setSaving(true); setSaveMsg(null)
    try {
      await apiFetch('/api/v1/telegram/config', { method: 'PUT', body: JSON.stringify({ token: token || '(unchanged)', chat_id: chatId, parse_mode: parseMode }) })
      setSaveMsg({ type: 'ok', text: 'Configuração salva' })
      setToken(''); await loadAll()
    } catch (e: unknown) { setSaveMsg({ type: 'err', text: e instanceof Error ? e.message : String(e) }) }
    finally { setSaving(false); setTimeout(() => setSaveMsg(null), 4000) }
  }

  async function sendTest() {
    setTesting(true); setTestResult(null)
    try {
      await apiFetch('/api/v1/telegram/send-test', { method: 'POST', body: JSON.stringify({ message: testMsg || undefined }) })
      setTestResult({ type: 'ok', text: 'Mensagem enviada' })
    } catch (e: unknown) { setTestResult({ type: 'err', text: e instanceof Error ? e.message : String(e) }) }
    finally { setTesting(false) }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text2)', fontSize: 13 }}>
      Carregando…
    </div>
  )

  const connected = status?.ok

  return (
    <div style={{ padding: '28px 32px', maxWidth: 680, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        .cfg-inp:focus { outline: none; border-color: ${BRAND} !important; }
        .ghost-btn:hover { background: var(--surface2) !important; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: BRAND,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-1.97 9.289c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.24 14.425l-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.576 2.161z"/>
          </svg>
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: 'var(--text)', letterSpacing: '-.01em' }}>
            Telegram
          </h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text2)' }}>Bot API · Notificações e relatórios</p>
        </div>
      </div>

      {/* ── Status card ── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, marginBottom: 12, overflow: 'hidden',
      }}>
        <div style={{ height: 3, background: connected ? BRAND : 'var(--border)' }} />

        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>

            <div style={{ flex: 1 }}>
              {!status?.configured ? (
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>
                  Sem configuração. Preencha os campos abaixo para ativar.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text2)', marginBottom: 3 }}>Bot</div>
                      <Chip ok={status?.bot?.ok ?? null} label={
                        status?.bot?.ok
                          ? `@${status.bot!.bot_username} · ${status.bot!.bot_name}`
                          : status?.bot?.error || 'Token inválido'
                      } />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text2)', marginBottom: 3 }}>Canal / Chat</div>
                      <Chip ok={status?.chat?.ok ?? null} label={
                        status?.chat?.ok
                          ? `${status.chat!.title} (${status.chat!.type})`
                          : status?.chat?.error || 'Chat ID inválido'
                      } />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={checkStatus} disabled={checking}
              className="ghost-btn"
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', flexShrink: 0,
                border: '1px solid var(--border)', borderRadius: 6,
                background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text2)',
              }}
            >
              <span style={{ display: 'inline-block', animation: checking ? 'spin .8s linear infinite' : undefined }}>
                <Ico d="M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15" size={12} />
              </span>
              Verificar
            </button>
          </div>
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

          <Field label="Token do Bot">
            <div style={{ position: 'relative' }}>
              <input className="cfg-inp"
                style={{ ...inpStyle, paddingRight: 36 }}
                type={showToken ? 'text' : 'password'}
                placeholder={cfg?.configured ? '(salvo — preencha para alterar)' : '123456789:ABC-DEFxxx'}
                value={token} onChange={e => setToken(e.target.value)}
              />
              <button onClick={() => setShowToken(v => !v)} style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', padding: 2, lineHeight: 0,
              }}>
                <Ico d={showToken
                  ? 'M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94 M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19 M1 1l22 22'
                  : 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 100 6 3 3 0 000-6z'
                } size={14} />
              </button>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text2)' }}>
              Crie um bot com o <strong>@BotFather</strong> e cole o token aqui.
            </p>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Chat ID">
              <input className="cfg-inp" style={inpStyle}
                placeholder="-100123456789"
                value={chatId} onChange={e => setChatId(e.target.value)} />
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text2)' }}>
                Grupo, canal ou ID pessoal.
              </p>
            </Field>
            <Field label="Formatação">
              <select className="cfg-inp" style={{ ...inpStyle, cursor: 'pointer' }}
                value={parseMode} onChange={e => setParseMode(e.target.value)}>
                <option value="Markdown">Markdown</option>
                <option value="MarkdownV2">MarkdownV2</option>
                <option value="HTML">HTML</option>
              </select>
            </Field>
          </div>
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={save} disabled={saving}
            style={{
              padding: '7px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: saving ? 'var(--text2)' : BRAND, color: '#fff', fontSize: 13,
              fontWeight: 600, opacity: saving ? .6 : 1,
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
          <div style={{ padding: '16px 20px' }}>
            <Field label="Mensagem">
              <input className="cfg-inp" style={inpStyle}
                value={testMsg} onChange={e => setTestMsg(e.target.value)} />
            </Field>
          </div>
          <div style={{ padding: '0 20px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={sendTest} disabled={testing}
              style={{
                padding: '7px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
                background: testing ? 'var(--text2)' : BRAND, color: '#fff', fontSize: 13,
                fontWeight: 600, opacity: testing ? .6 : 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <Ico d="M22 2L11 13 M22 2L15 22l-4-9-9-4 22-7z" size={13} />
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
            <li>Abra o Telegram e pesquise por <strong style={{ color: 'var(--text)' }}>@BotFather</strong></li>
            <li>Envie <code style={codeStyle}>/newbot</code> e siga as instruções</li>
            <li>Copie o <strong style={{ color: 'var(--text)' }}>token</strong> fornecido e cole acima</li>
            <li>Adicione o bot ao grupo ou canal que receberá os alertas</li>
            <li>Obtenha o Chat ID adicionando <strong style={{ color: 'var(--text)' }}>@userinfobot</strong> ao grupo — canais começam com <code style={codeStyle}>-100</code></li>
            <li>Salve e clique em <em>Verificar</em> para confirmar bot + canal</li>
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
