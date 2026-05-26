import { useState, useEffect, useRef } from 'react'
import api from '../api'
import { useAuth } from '../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MeData {
  id:           number
  nome:         string
  email:        string
  perfil:       string
  ultimo_login: string | null
  whatsapp:     string | null
  telegram:     string | null
  cargo:        string | null
  departamento: string | null
  avatar:       string | null
}

// ── Static config ─────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = {
  admin    : 'Administrador',
  operador : 'Operador',
  viewer   : 'Visualizador',
}

const ROLE_COLOR: Record<string, string> = {
  admin    : 'var(--danger)',
  operador : 'var(--primary)',
  viewer   : 'var(--text2)',
}

const ROLE_BG: Record<string, string> = {
  admin    : 'rgba(239,68,68,.1)',
  operador : 'rgba(99,102,241,.12)',
  viewer   : 'rgba(148,163,184,.1)',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string) {
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
}

type MsgState = { type: 'ok' | 'err'; text: string } | null

// ── Sub-components ────────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width: '100%', padding: '9px 13px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface2)',
  color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label style={{
      display: 'block', fontSize: 11, fontWeight: 700,
      letterSpacing: '.05em', textTransform: 'uppercase',
      color: 'var(--text2)', marginBottom: 6,
    }}>{children}</label>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 13, fontWeight: 700,
      marginBottom: 20, paddingBottom: 12,
      borderBottom: '1px solid var(--border)',
    }}>{children}</div>
  )
}

function Msg({ state }: { state: MsgState }) {
  if (!state) return null
  return (
    <div style={{
      padding: '9px 14px', borderRadius: 8, fontSize: 12,
      background: state.type === 'ok' ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)',
      border: `1px solid ${state.type === 'ok' ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.25)'}`,
      color: state.type === 'ok' ? 'var(--success)' : 'var(--danger)',
    }}>{state.text}</div>
  )
}

function ContactLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{
      fontSize: 11, color: 'var(--primary)', textDecoration: 'none',
      display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4,
    }}>{children}</a>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Perfil() {
  const { op } = useAuth()
  const [me, setMe]           = useState<MeData | null>(null)
  const [loading, setLoading] = useState(true)

  // Dados pessoais
  const [nome, setNome]               = useState('')
  const [cargo, setCargo]             = useState('')
  const [departamento, setDepartamento] = useState('')
  const [savingInfo, setSavingInfo]   = useState(false)
  const [infoMsg, setInfoMsg]         = useState<MsgState>(null)

  // Contato
  const [whatsapp, setWhatsapp] = useState('')
  const [telegram, setTelegram] = useState('')
  const [savingContato, setSavingContato] = useState(false)
  const [contatoMsg, setContatoMsg]       = useState<MsgState>(null)

  // Avatar
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarHover, setAvatarHover]     = useState(false)
  const [savingAvatar, setSavingAvatar]   = useState(false)
  const [avatarMsg, setAvatarMsg]         = useState<MsgState>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Senha
  const [senhaAtual, setSenhaAtual] = useState('')
  const [novaSenha, setNovaSenha]   = useState('')
  const [confirma, setConfirma]     = useState('')
  const [savingSenha, setSavingSenha] = useState(false)
  const [senhaMsg, setSenhaMsg]       = useState<MsgState>(null)

  useEffect(() => {
    api.get('/api/v1/auth/me')
      .then(r => {
        const d: MeData = r.data
        setMe(d)
        setNome(d.nome || '')
        setCargo(d.cargo || '')
        setDepartamento(d.departamento || '')
        setWhatsapp(d.whatsapp || '')
        setTelegram(d.telegram || '')
        setAvatarPreview(d.avatar || null)
      })
      .catch(() => {
        if (op) {
          const fallback: MeData = { id: 0, nome: op.nome, email: op.email, perfil: 'operador', ultimo_login: null, whatsapp: null, telegram: null, cargo: null, departamento: null, avatar: null }
          setMe(fallback); setNome(op.nome)
        }
      })
      .finally(() => setLoading(false))
  }, [])

  // ── Avatar handlers ───────────────────────────────────────────────────────

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setAvatarMsg({ type: 'err', text: 'Imagem deve ter menos de 2 MB' }); return }
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      setAvatarMsg(null)
      setSavingAvatar(true)
      try {
        await api.put('/api/v1/auth/me/avatar', { avatar: dataUrl })
        setAvatarPreview(dataUrl)
        // Sync localStorage so sidebar updates immediately
        const stored = JSON.parse(localStorage.getItem('operador') || '{}')
        stored.avatar = dataUrl
        localStorage.setItem('operador', JSON.stringify(stored))
        window.dispatchEvent(new CustomEvent('operador-updated'))
        setAvatarMsg({ type: 'ok', text: 'Foto atualizada' })
      } catch {
        setAvatarMsg({ type: 'err', text: 'Erro ao salvar foto' })
      } finally {
        setSavingAvatar(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    }
    reader.readAsDataURL(file)
  }

  const removeAvatar = async () => {
    setSavingAvatar(true)
    setAvatarMsg(null)
    try {
      await api.put('/api/v1/auth/me/avatar', { avatar: null })
      setAvatarPreview(null)
      const stored = JSON.parse(localStorage.getItem('operador') || '{}')
      stored.avatar = null
      localStorage.setItem('operador', JSON.stringify(stored))
      window.dispatchEvent(new CustomEvent('operador-updated'))
      setAvatarMsg({ type: 'ok', text: 'Foto removida' })
    } catch {
      setAvatarMsg({ type: 'err', text: 'Erro ao remover foto' })
    } finally { setSavingAvatar(false) }
  }

  // ── Save handlers ─────────────────────────────────────────────────────────

  const saveInfo = async () => {
    setInfoMsg(null)
    const n = nome.trim()
    if (!n || n.length < 2) { setInfoMsg({ type: 'err', text: 'Nome deve ter ao menos 2 caracteres' }); return }
    setSavingInfo(true)
    try {
      const r = await api.patch('/api/v1/auth/me', {
        nome: n,
        cargo: cargo.trim() || '',
        departamento: departamento.trim() || '',
      })
      const stored = JSON.parse(localStorage.getItem('operador') || '{}')
      stored.nome = r.data.nome
      localStorage.setItem('operador', JSON.stringify(stored))
      setMe(prev => prev ? { ...prev, ...r.data } : prev)
      setInfoMsg({ type: 'ok', text: 'Dados atualizados com sucesso' })
    } catch (e: unknown) {
      setInfoMsg({ type: 'err', text: (e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Erro ao salvar' })
    } finally { setSavingInfo(false) }
  }

  const saveContato = async () => {
    setContatoMsg(null)
    setSavingContato(true)
    try {
      const r = await api.patch('/api/v1/auth/me', {
        whatsapp: whatsapp.trim() || '',
        telegram: telegram.trim() || '',
      })
      setMe(prev => prev ? { ...prev, ...r.data } : prev)
      setContatoMsg({ type: 'ok', text: 'Contatos atualizados com sucesso' })
    } catch (e: unknown) {
      setContatoMsg({ type: 'err', text: (e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Erro ao salvar' })
    } finally { setSavingContato(false) }
  }

  const saveSenha = async () => {
    setSenhaMsg(null)
    if (!senhaAtual)            { setSenhaMsg({ type: 'err', text: 'Informe a senha atual' }); return }
    if (!novaSenha)             { setSenhaMsg({ type: 'err', text: 'Informe a nova senha' }); return }
    if (novaSenha.length < 6)   { setSenhaMsg({ type: 'err', text: 'Nova senha deve ter ao menos 6 caracteres' }); return }
    if (novaSenha !== confirma) { setSenhaMsg({ type: 'err', text: 'As senhas não coincidem' }); return }
    setSavingSenha(true)
    try {
      await api.patch('/api/v1/auth/me', { senha_atual: senhaAtual, nova_senha: novaSenha })
      setSenhaAtual(''); setNovaSenha(''); setConfirma('')
      setSenhaMsg({ type: 'ok', text: 'Senha alterada com sucesso' })
    } catch (e: unknown) {
      setSenhaMsg({ type: 'err', text: (e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Senha atual incorreta' })
    } finally { setSavingSenha(false) }
  }

  if (loading) {
    return <div className="page"><div className="empty-state"><div className="spinner" /></div></div>
  }

  const roleLabel = ROLE_LABEL[me?.perfil ?? ''] ?? (me?.perfil || '—')
  const roleColor = ROLE_COLOR[me?.perfil ?? ''] ?? 'var(--text2)'
  const roleBg    = ROLE_BG[me?.perfil ?? '']    ?? 'rgba(148,163,184,.1)'
  const lastLogin = me?.ultimo_login
    ? new Date(me.ultimo_login).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : '—'

  // Format whatsapp for link (strip non-digits)
  const waNumber = (me?.whatsapp || '').replace(/\D/g, '')
  const tgHandle = (me?.telegram || '').replace(/^@/, '')

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Meu Perfil</div>
          <div className="page-subtitle">Gerencie suas informações de conta</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'start' }}>

        {/* ── Card lateral ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>

            {/* Avatar upload */}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <div
                onClick={() => !savingAvatar && fileRef.current?.click()}
                onMouseEnter={() => setAvatarHover(true)}
                onMouseLeave={() => setAvatarHover(false)}
                style={{
                  width: 88, height: 88, borderRadius: 22,
                  background: avatarPreview ? 'transparent' : 'linear-gradient(135deg, var(--primary) 0%, #6366f1 100%)',
                  color: '#fff', overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 30, fontWeight: 700,
                  cursor: savingAvatar ? 'wait' : 'pointer',
                  position: 'relative',
                  boxShadow: '0 4px 20px rgba(0,0,0,.18)',
                  border: '3px solid var(--border)',
                  transition: 'border-color .15s',
                  ...(avatarHover ? { borderColor: 'var(--primary)' } : {}),
                }}
              >
                {avatarPreview
                  ? <img src={avatarPreview} alt="avatar"
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  : getInitials(me?.nome || op?.nome || '?')}

                {/* Overlay on hover */}
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'rgba(0,0,0,.52)',
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 4,
                  opacity: avatarHover && !savingAvatar ? 1 : 0,
                  transition: 'opacity .18s',
                }}>
                  {savingAvatar
                    ? <div className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.3)', width: 20, height: 20 }} />
                    : <>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z M12 17a4 4 0 100-8 4 4 0 000 8z"/>
                        </svg>
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#fff', letterSpacing: '.06em', textTransform: 'uppercase' }}>Alterar</span>
                      </>
                  }
                </div>
              </div>
            </div>

            {/* Avatar actions */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={savingAvatar}
                className="btn btn-ghost btn-sm"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8l-5-5-5 5 M12 3v12"/>
                </svg>
                {avatarPreview ? 'Trocar' : 'Enviar foto'}
              </button>
              {avatarPreview && (
                <button
                  onClick={removeAvatar}
                  disabled={savingAvatar}
                  className="btn btn-danger btn-sm"
                >
                  Remover
                </button>
              )}
            </div>
            {avatarMsg && <Msg state={avatarMsg} />}

            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{me?.nome}</div>
              {me?.cargo && (
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{me.cargo}</div>
              )}
              {me?.departamento && (
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>{me.departamento}</div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>{me?.email}</div>
            </div>

            {/* Role badge */}
            <span style={{
              padding: '4px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: roleBg, color: roleColor,
            }}>
              {roleLabel}
            </span>

            {/* Contact links */}
            {(me?.whatsapp || me?.telegram) && (
              <div style={{ width: '100%', borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {me.whatsapp && waNumber && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* WhatsApp icon */}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                    </svg>
                    <ContactLink href={`https://wa.me/${waNumber}`}>
                      {me.whatsapp}
                    </ContactLink>
                  </div>
                )}
                {me.telegram && tgHandle && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* Telegram icon */}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
                    </svg>
                    <ContactLink href={`https://t.me/${tgHandle}`}>
                      @{tgHandle}
                    </ContactLink>
                  </div>
                )}
              </div>
            )}

            {/* Meta info */}
            <div style={{ width: '100%', borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: 'var(--text2)' }}>Perfil</span>
                <span style={{ fontWeight: 600, color: roleColor }}>{roleLabel}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: 'var(--text2)' }}>Último acesso</span>
                <span style={{ fontWeight: 600 }}>{lastLogin}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Formulários ──────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Dados pessoais */}
          <div className="card" style={{ padding: 24 }}>
            <SectionTitle>Dados pessoais</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <Label>Nome completo</Label>
                  <input style={inputBase} value={nome}
                    onChange={e => setNome(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveInfo()}
                    placeholder="Seu nome completo" />
                </div>
                <div>
                  <Label>
                    E-mail{' '}
                    <span style={{ color: 'var(--text2)', fontWeight: 400, textTransform: 'none' }}>(não alterável)</span>
                  </Label>
                  <input style={{ ...inputBase, opacity: .5, cursor: 'not-allowed' }}
                    value={me?.email || ''} readOnly />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <Label>Cargo</Label>
                  <input style={inputBase} value={cargo}
                    onChange={e => setCargo(e.target.value)}
                    placeholder="Ex: Analista de Segurança" />
                </div>
                <div>
                  <Label>Departamento</Label>
                  <input style={inputBase} value={departamento}
                    onChange={e => setDepartamento(e.target.value)}
                    placeholder="Ex: Segurança Patrimonial" />
                </div>
              </div>

              <Msg state={infoMsg} />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={saveInfo} disabled={savingInfo} className="btn btn-primary" style={{ minWidth: 160 }}>
                  {savingInfo ? 'Salvando...' : 'Salvar dados'}
                </button>
              </div>
            </div>
          </div>

          {/* Contato */}
          <div className="card" style={{ padding: 24 }}>
            <SectionTitle>Contato e Notificações</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

                {/* WhatsApp */}
                <div>
                  <Label>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                      </svg>
                      WhatsApp
                    </span>
                  </Label>
                  <input style={inputBase} value={whatsapp}
                    onChange={e => setWhatsapp(e.target.value)}
                    placeholder="+55 65 99999-9999" />
                  <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 5, lineHeight: 1.4 }}>
                    Número com DDI e DDD para receber alertas.
                  </div>
                </div>

                {/* Telegram */}
                <div>
                  <Label>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
                      </svg>
                      Telegram
                    </span>
                  </Label>
                  <input style={inputBase} value={telegram}
                    onChange={e => setTelegram(e.target.value)}
                    placeholder="@usuario ou ID numérico" />
                  <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 5, lineHeight: 1.4 }}>
                    Username (@) ou ID para receber alertas.
                  </div>
                </div>
              </div>

              <Msg state={contatoMsg} />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={saveContato} disabled={savingContato} className="btn btn-primary" style={{ minWidth: 160 }}>
                  {savingContato ? 'Salvando...' : 'Salvar contatos'}
                </button>
              </div>
            </div>
          </div>

          {/* Alterar senha */}
          <div className="card" style={{ padding: 24 }}>
            <SectionTitle>Alterar senha</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              <div>
                <Label>Senha atual</Label>
                <input style={inputBase} type="password" value={senhaAtual}
                  onChange={e => setSenhaAtual(e.target.value)}
                  placeholder="Digite sua senha atual"
                  autoComplete="current-password" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <Label>Nova senha</Label>
                  <input style={inputBase} type="password" value={novaSenha}
                    onChange={e => setNovaSenha(e.target.value)}
                    placeholder="Mínimo 6 caracteres"
                    autoComplete="new-password" />
                </div>
                <div>
                  <Label>Confirmar nova senha</Label>
                  <input style={inputBase} type="password" value={confirma}
                    onChange={e => setConfirma(e.target.value)}
                    placeholder="Repita a nova senha"
                    autoComplete="new-password" />
                </div>
              </div>

              {novaSenha && confirma && novaSenha !== confirma && (
                <div style={{ fontSize: 11, color: 'var(--danger)' }}>As senhas não coincidem</div>
              )}

              <Msg state={senhaMsg} />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={saveSenha} disabled={savingSenha} className="btn btn-primary" style={{ minWidth: 160 }}>
                  {savingSenha ? 'Alterando...' : 'Alterar senha'}
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
