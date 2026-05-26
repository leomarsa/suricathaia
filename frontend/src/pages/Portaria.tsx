import { useEffect, useRef, useState, useCallback } from 'react'
import { format } from 'date-fns'
import { QRCodeSVG } from 'qrcode.react'
import api from '../api'
import { formatCpf, validateCpf, normalizeCpf } from '../utils/cpf'
import { useAuth } from '../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

type TipoPessoa = 'funcionario' | 'visitante' | 'prestador'

interface Pessoa {
  id: number; tipo: TipoPessoa; nome: string
  cpf: string | null; rg: string | null; cnh: string | null
  telefone: string | null; empresa: string | null
  departamento: string | null; ramal: string | null; email: string | null
  foto_url: string | null; fotos_documento: string[]
  status_blacklist: boolean; observacoes: string | null; ativo: boolean
}

interface VisitaAtiva {
  id: number; status: string
  data_entrada: string | null; placa_veiculo: string | null
  fotos_veiculo: string[]; motivo: string | null
  duracao_seg: number | null; observacoes: string | null
  pessoa_visitante_id: number; visitante_tipo: TipoPessoa
  visitante_nome: string; visitante_empresa: string | null
  visitante_foto: string | null; visitante_telefone: string | null
  visitante_blacklist: boolean
  visitante_cpf: string | null; visitante_rg: string | null; visitante_cnh: string | null
  visitante_fotos_doc: string[]
  pessoa_visitado_id: number | null
  visitado_nome: string | null; visitado_departamento: string | null
  visitado_ramal: string | null; visitado_email: string | null
}

interface VisitaHistorico extends VisitaAtiva {
  data_saida: string | null; criado_em: string
  empresa: string | null; cpf: string | null; rg: string | null; cnh: string | null
  telefone: string | null; foto_url: string | null; fotos_documento: string[]
  visitado_nome: string | null; departamento: string | null; ramal: string | null
}

interface Resumo { em_visita: number; aguardando: number; agendados: number; saidas_hoje: number }

// ── Constantes ────────────────────────────────────────────────────────────────

const TIPO_LABEL: Record<TipoPessoa, string> = {
  funcionario: 'Funcionário', visitante: 'Visitante', prestador: 'Prestador',
}
const TIPO_COLOR: Record<TipoPessoa, string> = {
  funcionario: '#3b82f6', visitante: '#10b981', prestador: '#f59e0b',
}
const STATUS_COLOR: Record<string, string> = {
  em_visita: '#22c55e', aguardando: '#f59e0b', agendado: '#6366f1',
  saiu: '#64748b', cancelado: '#ef4444',
}
const STATUS_LABEL: Record<string, string> = {
  em_visita: 'Em Visita', aguardando: 'Aguardando', agendado: 'Agendado',
  saiu: 'Saiu', cancelado: 'Cancelado',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTel(t: string | null) {
  if (!t) return null
  const d = t.replace(/\D/g, '')
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`
  return t
}

function fmtHora(ts: string | null) {
  if (!ts) return '—'
  try { return format(new Date(ts), 'HH:mm') } catch { return '—' }
}

function initials(nome: string) {
  return nome.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase() || '?'
}

// ── Estilos base ──────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border)', background: 'var(--surface2)',
  color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
}
const btnPrimary: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 8, border: 'none',
  background: 'var(--primary)', color: '#fff', fontSize: 13,
  fontWeight: 600, cursor: 'pointer',
}
const btnSecondary: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text2)', cursor: 'pointer',
}
const label11: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: 'var(--text2)', letterSpacing: '.06em',
  textTransform: 'uppercase', display: 'block', marginBottom: 5,
}
const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 12, overflow: 'hidden',
}

// ── Átomo: Lightbox ───────────────────────────────────────────────────────────

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: '#000d',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <img src={src} alt="" onClick={e => e.stopPropagation()} style={{
        maxWidth: '90vw', maxHeight: '88vh', borderRadius: 12,
        boxShadow: '0 24px 80px #000c',
      }} />
    </div>
  )
}

// ── Átomo: Avatar ─────────────────────────────────────────────────────────────

function Avatar({ nome, url, size = 38, tipo }: {
  nome: string; url?: string | null; size?: number; tipo?: TipoPessoa
}) {
  const [err, setErr] = useState(false)
  const color = tipo ? TIPO_COLOR[tipo] : '#6366f1'
  if (url && !err) return (
    <img src={url} alt={nome} onError={() => setErr(true)} style={{
      width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
    }} />
  )
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `${color}22`, border: `1.5px solid ${color}44`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.33, fontWeight: 700, color,
    }}>
      {initials(nome)}
    </div>
  )
}

// ── Átomo: TipoBadge ──────────────────────────────────────────────────────────

function TipoBadge({ tipo }: { tipo: TipoPessoa }) {
  const c = TIPO_COLOR[tipo]
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
      background: `${c}18`, color: c, letterSpacing: '.05em', whiteSpace: 'nowrap',
    }}>
      {TIPO_LABEL[tipo].toUpperCase()}
    </span>
  )
}

// ── Átomo: PlacaBadge ─────────────────────────────────────────────────────────

function PlacaBadge({ placa }: { placa: string }) {
  return (
    <span style={{
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
      padding: '2px 8px', borderRadius: 5, letterSpacing: '.1em',
      background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
    }}>{placa}</span>
  )
}

// ── Átomo: BlacklistBadge ─────────────────────────────────────────────────────

function BlacklistBadge() {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4,
      background: '#ef444420', color: '#ef4444', letterSpacing: '.04em',
    }}>BLOQUEADO</span>
  )
}

// ── Átomo: Spinner ────────────────────────────────────────────────────────────

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `2px solid var(--border)`, borderTopColor: 'var(--primary)',
      animation: 'spin .7s linear infinite', flexShrink: 0,
    }} />
  )
}

// ── Galeria de Fotos ──────────────────────────────────────────────────────────

function FotoGaleria({ fotos, onUpload, onDelete, max = 4, uploading, uploadError }: {
  fotos: string[]; onUpload: (f: File) => void; onDelete?: (url: string) => void
  max?: number; uploading?: boolean; uploadError?: string
}) {
  const [lb, setLb] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div>
      {lb && <Lightbox src={lb} onClose={() => setLb(null)} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {fotos.map((url, i) => (
          <div key={i} style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
            <img src={url} alt="" onClick={() => setLb(url)} style={{
              width: 72, height: 72, objectFit: 'cover', borderRadius: 8,
              cursor: 'zoom-in', border: '1px solid var(--border)',
            }} />
            {onDelete && (
              <button onClick={() => onDelete(url)} style={{
                position: 'absolute', top: -5, right: -5,
                width: 18, height: 18, borderRadius: '50%',
                background: '#ef4444', border: '2px solid var(--surface)',
                color: '#fff', fontSize: 11, fontWeight: 700,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
              }}>×</button>
            )}
          </div>
        ))}
        {fotos.length < max && (
          <button onClick={() => ref.current?.click()} disabled={uploading} style={{
            width: 72, height: 72, borderRadius: 8, border: '2px dashed var(--border)',
            background: 'var(--surface2)', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 3, color: 'var(--text3)', flexShrink: 0,
          }}>
            {uploading ? <Spinner size={18} /> : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                </svg>
                <span style={{ fontSize: 9, fontWeight: 600 }}>{fotos.length}/{max}</span>
              </>
            )}
          </button>
        )}
      </div>
      {uploadError && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{uploadError}</div>}
      <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { onUpload(f); e.target.value = '' } }} />
    </div>
  )
}

// ── Foto Rosto ────────────────────────────────────────────────────────────────

function FotoRosto({ pessoaId, fotoUrl, nome, tipo, onUpdate, size = 72 }: {
  pessoaId: number; fotoUrl: string | null; nome: string; tipo?: TipoPessoa
  onUpdate: (url: string | null) => void; size?: number
}) {
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')
  const [lb, setLb] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setUploading(true); setErr('')
    try {
      const form = new FormData()
      form.append('foto', file)
      const r = await api.post<{ foto_url: string }>(`/api/v1/portaria/upload/foto-rosto/${pessoaId}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      onUpdate(r.data.foto_url)
    } catch { setErr('Erro no upload') } finally { setUploading(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {lb && fotoUrl && <Lightbox src={fotoUrl} onClose={() => setLb(false)} />}
      <div style={{ position: 'relative', width: size, height: size }}>
        <div onClick={() => fotoUrl ? setLb(true) : ref.current?.click()}
          style={{
            width: size, height: size, borderRadius: '50%', overflow: 'hidden',
            cursor: 'pointer', border: '2px dashed var(--border)',
            background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          {fotoUrl
            ? <img src={fotoUrl} alt={nome} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : uploading ? <Spinner size={20} />
            : <Avatar nome={nome} url={null} size={size - 8} tipo={tipo} />
          }
        </div>
        <button onClick={() => ref.current?.click()} disabled={uploading}
          style={{
            position: 'absolute', bottom: -2, right: -2, width: 22, height: 22,
            borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--surface)',
            color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
          }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z M12 17a4 4 0 100-8 4 4 0 000 8z"/>
          </svg>
        </button>
        {fotoUrl && (
          <button onClick={async () => { try { await api.delete(`/api/v1/portaria/upload/foto-rosto/${pessoaId}`); onUpdate(null) } catch {} }}
            style={{
              position: 'absolute', top: -2, right: -2, width: 18, height: 18,
              borderRadius: '50%', background: '#ef4444', border: '2px solid var(--surface)',
              color: '#fff', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}>×</button>
        )}
      </div>
      <span style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Foto</span>
      {err && <span style={{ fontSize: 10, color: '#ef4444' }}>{err}</span>}
      <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { upload(f); e.target.value = '' } }} />
    </div>
  )
}

// ── PessoaSearch ──────────────────────────────────────────────────────────────

function PessoaSearch({ tipo, placeholder, onSelect }: {
  tipo?: TipoPessoa | TipoPessoa[]; placeholder?: string; onSelect: (p: Pessoa) => void
}) {
  const [q, setQ] = useState('')
  const [opts, setOpts] = useState<Pessoa[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (q.length < 1) { setOpts([]); return }
    const t = setTimeout(async () => {
      try {
        const tipos = Array.isArray(tipo) ? tipo : tipo ? [tipo] : []
        const params: Record<string, string> = { q, limit: '10' }
        if (tipos.length === 1) params.tipo = tipos[0]
        const r = await api.get<{ data: Pessoa[] }>('/api/v1/portaria/pessoas', { params })
        const data = tipos.length > 1 ? r.data.data.filter(p => tipos.includes(p.tipo)) : r.data.data
        setOpts(data); setOpen(true)
      } catch {}
    }, 250)
    return () => clearTimeout(t)
  }, [q, tipo])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input value={q} onChange={e => { setQ(e.target.value); setOpen(true) }}
        placeholder={placeholder ?? 'Buscar por nome, documento ou telefone…'}
        style={inp} />
      {open && opts.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 300,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, marginTop: 4, boxShadow: '0 8px 32px #0004',
          maxHeight: 260, overflowY: 'auto',
        }}>
          {opts.map(p => (
            <button key={p.id} onClick={() => { onSelect(p); setQ(''); setOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--border)',
                background: 'transparent', cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <Avatar nome={p.nome} url={p.foto_url} size={34} tipo={p.tipo} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: p.status_blacklist ? '#ef4444' : 'var(--text)' }}>
                    {p.nome}
                  </span>
                  <TipoBadge tipo={p.tipo} />
                  {p.status_blacklist && <BlacklistBadge />}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 1 }}>
                  {p.cpf ? `CPF ${p.cpf}` : p.rg ? `RG ${p.rg}` : ''}
                  {p.departamento ? ` · ${p.departamento}` : p.empresa ? ` · ${p.empresa}` : ''}
                  {p.telefone ? ` · ${fmtTel(p.telefone)}` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── NovaPessoa Form ───────────────────────────────────────────────────────────

function NovaPessoaForm({ tipoDefault = 'visitante', onCreate, onCancel }: {
  tipoDefault?: TipoPessoa; onCreate: (p: Pessoa) => void; onCancel?: () => void
}) {
  const [f, setF] = useState({
    tipo: tipoDefault as TipoPessoa,
    nome: '', cpf: '', rg: '', cnh: '',
    telefone: '', empresa: '',
    departamento: '', ramal: '', email: '', observacoes: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [created, setCreated] = useState<Pessoa | null>(null)
  const [fotoRosto, setFotoRosto] = useState<string | null>(null)
  const [fotosDoc, setFotosDoc] = useState<string[]>([])
  const [uploadingD, setUploadingD] = useState(false)
  const [uploadErrD, setUploadErrD] = useState('')
  const [cpfStatus, setCpfStatus] = useState<'idle'|'checking'|'ok'|'invalid'|'duplicate'>('idle')
  const [cpfDupNome, setCpfDupNome] = useState('')
  const cpfTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const set = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF(p => ({ ...p, [k]: e.target.value }))

  const onCpfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fmt = formatCpf(e.target.value)
    setF(p => ({ ...p, cpf: fmt }))
    setCpfStatus('idle'); setCpfDupNome('')
    if (cpfTimer.current) clearTimeout(cpfTimer.current)
    const raw = normalizeCpf(fmt)
    if (raw.length < 11) return
    if (!validateCpf(raw)) { setCpfStatus('invalid'); return }
    setCpfStatus('checking')
    cpfTimer.current = setTimeout(async () => {
      try {
        const r = await api.get<{ valido: boolean; duplicado: boolean; nome_existente?: string }>(
          '/api/v1/portaria/pessoas/check-cpf', { params: { cpf: raw } }
        )
        if (!r.data.valido) { setCpfStatus('invalid'); return }
        if (r.data.duplicado) { setCpfStatus('duplicate'); setCpfDupNome(r.data.nome_existente || ''); return }
        setCpfStatus('ok')
      } catch { setCpfStatus('idle') }
    }, 600)
  }

  const submit = async () => {
    if (!f.nome.trim())     { setErr('Nome é obrigatório'); return }
    if (!f.telefone.trim()) { setErr('Telefone é obrigatório'); return }
    if (!f.rg.trim())       { setErr('RG é obrigatório'); return }
    if (!f.cpf.trim())      { setErr('CPF é obrigatório'); return }
    if (cpfStatus === 'invalid')   { setErr('CPF inválido'); return }
    if (cpfStatus === 'duplicate') { setErr(`CPF já cadastrado para: ${cpfDupNome}`); return }
    if (cpfStatus === 'checking')  { setErr('Aguarde a verificação do CPF'); return }
    setSaving(true); setErr('')
    try {
      const r = await api.post<Pessoa>('/api/v1/portaria/pessoas', {
        tipo: f.tipo, nome: f.nome.trim(),
        cpf:          normalizeCpf(f.cpf) || null,
        rg:           f.rg.trim().toUpperCase() || null,
        cnh:          f.cnh.trim() || null,
        telefone:     f.telefone.trim() || null,
        empresa:      f.empresa.trim() || null,
        departamento: f.departamento.trim() || null,
        ramal:        f.ramal.trim() || null,
        email:        f.email.trim() || null,
        observacoes:  f.observacoes.trim() || null,
      })
      setCreated(r.data)
    } catch (e: unknown) {
      const ax = e as { response?: { data?: { detail?: string } } }
      setErr(ax.response?.data?.detail || 'Erro ao cadastrar')
    } finally { setSaving(false) }
  }

  const uploadDoc = async (file: File) => {
    if (!created) return
    setUploadingD(true); setUploadErrD('')
    try {
      const form = new FormData(); form.append('foto', file)
      const r = await api.post<{ fotos: string[] }>(`/api/v1/portaria/upload/documento/${created.id}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setFotosDoc(r.data.fotos)
    } catch { setUploadErrD('Erro no upload') } finally { setUploadingD(false) }
  }

  const deleteDoc = async (url: string) => {
    if (!created) return
    try {
      const r = await api.delete<{ fotos: string[] }>(`/api/v1/portaria/upload/documento/${created.id}`, { params: { url } })
      setFotosDoc(r.data.fotos)
    } catch {}
  }

  // Passo 2: fotos após criação
  if (created) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Banner sucesso */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderRadius: 10, background: 'rgba(34,197,94,.07)', border: '1px solid rgba(34,197,94,.25)',
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%', background: '#22c55e',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '.04em' }}>Cadastrado com sucesso</div>
          <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{created.nome}</div>
        </div>
        <TipoBadge tipo={created.tipo} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: -4 }}>
        Fotos — opcional
      </div>

      {/* Foto facial */}
      <div style={{
        padding: '14px 16px', borderRadius: 12,
        background: 'var(--surface2)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/>
          </svg>
          Foto Facial
          <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>· usada para identificação e avatar</span>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <FotoRosto pessoaId={created.id} fotoUrl={fotoRosto} nome={created.nome} tipo={created.tipo}
            onUpdate={setFotoRosto} size={80} />
          <div style={{ flex: 1, fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
            {fotoRosto
              ? <span style={{ color: '#22c55e', fontWeight: 600 }}>✓ Foto adicionada. Clique no avatar para trocar.</span>
              : <>Clique no círculo ao lado para tirar uma foto ou selecionar da galeria.<br/>Recomendamos uma foto nítida do rosto com boa iluminação.</>
            }
          </div>
        </div>
      </div>

      {/* Fotos de documento */}
      <div style={{
        padding: '14px 16px', borderRadius: 12,
        background: 'var(--surface2)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8"/>
          </svg>
          Fotos de Documento
          <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>· RG, CPF, CNH, Passaporte (máx. 4)</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>
          {fotosDoc.length === 0
            ? 'Nenhuma foto adicionada. Fotografe frente e verso dos documentos.'
            : `${fotosDoc.length} foto${fotosDoc.length > 1 ? 's' : ''} adicionada${fotosDoc.length > 1 ? 's' : ''}.`
          }
        </div>
        <FotoGaleria fotos={fotosDoc} onUpload={uploadDoc} onDelete={deleteDoc}
          max={4} uploading={uploadingD} uploadError={uploadErrD} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onCreate({ ...created, foto_url: fotoRosto, fotos_documento: fotosDoc })}
          style={{ ...btnPrimary, flex: 1 }}>
          {fotoRosto || fotosDoc.length > 0 ? 'Concluir cadastro →' : 'Pular fotos e usar cadastro →'}
        </button>
        {onCancel && (
          <button onClick={onCancel} style={btnSecondary}>Cancelar</button>
        )}
      </div>
    </div>
  )

  const ehFuncionario = f.tipo === 'funcionario'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {err && (
        <div style={{ padding: '8px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
          background: 'rgba(239,68,68,.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,.2)' }}>
          {err}
        </div>
      )}

      {/* Tipo */}
      <div>
        <label style={label11}>Tipo de Pessoa *</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['visitante', 'funcionario', 'prestador'] as TipoPessoa[]).map(t => (
            <button key={t} onClick={() => setF(p => ({ ...p, tipo: t }))} style={{
              flex: 1, padding: '8px 6px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: `1.5px solid ${f.tipo === t ? TIPO_COLOR[t] : 'var(--border)'}`,
              background: f.tipo === t ? `${TIPO_COLOR[t]}18` : 'var(--surface2)',
              color: f.tipo === t ? TIPO_COLOR[t] : 'var(--text2)', cursor: 'pointer',
            }}>
              {TIPO_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Nome */}
      <div>
        <label style={label11}>Nome Completo *</label>
        <input value={f.nome} onChange={set('nome')} placeholder="Nome Sobrenome" style={inp} />
      </div>

      {/* CPF + RG */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={label11}>
            CPF *
            {cpfStatus === 'checking' && <span style={{ marginLeft: 5, color: '#94a3b8', fontSize: 10 }}>verificando…</span>}
            {cpfStatus === 'ok'       && <span style={{ marginLeft: 5, color: '#22c55e', fontSize: 10 }}>✓ disponível</span>}
            {cpfStatus === 'invalid'  && <span style={{ marginLeft: 5, color: '#ef4444', fontSize: 10 }}>✗ inválido</span>}
            {cpfStatus === 'duplicate'&& <span style={{ marginLeft: 5, color: '#ef4444', fontSize: 10 }}>✗ já cadastrado</span>}
          </label>
          <input
            value={f.cpf}
            onChange={onCpfChange}
            placeholder="000.000.000-00"
            inputMode="numeric"
            style={{
              ...inp,
              borderColor: cpfStatus === 'ok' ? '#22c55e' : cpfStatus === 'invalid' || cpfStatus === 'duplicate' ? '#ef4444' : undefined,
              boxShadow: cpfStatus === 'ok' ? '0 0 0 2px #22c55e22' : cpfStatus === 'invalid' || cpfStatus === 'duplicate' ? '0 0 0 2px #ef444422' : undefined,
            }}
          />
          {cpfStatus === 'duplicate' && cpfDupNome && (
            <div style={{ fontSize: 10, color: '#ef4444', marginTop: 3 }}>
              Cadastrado como: {cpfDupNome}
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <label style={label11}>RG *</label>
          <input value={f.rg} onChange={set('rg')} placeholder="00.000.000-0" style={inp} />
        </div>
      </div>

      {/* CNH + Telefone */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={label11}>CNH</label>
          <input value={f.cnh} onChange={set('cnh')} placeholder="00000000000" style={inp} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label11}>Telefone *</label>
          <input value={f.telefone} onChange={set('telefone')} placeholder="(65) 99999-0000" style={inp} />
        </div>
      </div>

      {/* Campos por tipo */}
      {ehFuncionario ? (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 2 }}>
              <label style={label11}>Departamento</label>
              <input value={f.departamento} onChange={set('departamento')} placeholder="ex: Recursos Humanos" style={inp} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label11}>Ramal</label>
              <input value={f.ramal} onChange={set('ramal')} placeholder="201" style={inp} />
            </div>
          </div>
          <div>
            <label style={label11}>E-mail</label>
            <input value={f.email} onChange={set('email')} placeholder="nome@empresa.com" style={inp} />
          </div>
        </>
      ) : (
        <div>
          <label style={label11}>Empresa / Organização</label>
          <input value={f.empresa} onChange={set('empresa')} placeholder="Nome da empresa" style={inp} />
        </div>
      )}

      {/* Observações */}
      <div>
        <label style={label11}>Observações</label>
        <textarea value={f.observacoes} onChange={set('observacoes')} rows={2}
          placeholder="Informações adicionais…"
          style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={saving || !f.nome.trim()}
          style={{ ...btnPrimary, flex: 1, opacity: saving || !f.nome.trim() ? .5 : 1 }}>
          {saving ? 'Cadastrando…' : 'Cadastrar Pessoa'}
        </button>
        {onCancel && (
          <button onClick={onCancel} style={btnSecondary}>Cancelar</button>
        )}
      </div>
    </div>
  )
}

// ── PessoaSelector (busca + novo) ─────────────────────────────────────────────

function PessoaSelector({ tipo, label, value, onSelect, onClear }: {
  tipo?: TipoPessoa | TipoPessoa[]; label: string
  value: Pessoa | null; onSelect: (p: Pessoa) => void; onClear: () => void
}) {
  const [mode, setMode] = useState<'search' | 'new'>('search')
  const tipos = Array.isArray(tipo) ? tipo : tipo ? [tipo] : ['visitante', 'prestador'] as TipoPessoa[]
  const tipoDefault = tipos[0] as TipoPessoa

  if (value) return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
      borderRadius: 10, border: '1.5px solid var(--primary)', background: 'var(--surface2)',
    }}>
      <Avatar nome={value.nome} url={value.foto_url} size={42} tipo={value.tipo} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{value.nome}</span>
          <TipoBadge tipo={value.tipo} />
          {value.status_blacklist && <BlacklistBadge />}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {value.cpf && <span>CPF {value.cpf}</span>}
          {value.rg && <span>RG {value.rg}</span>}
          {value.departamento && <span>{value.departamento}{value.ramal ? ` · Ramal ${value.ramal}` : ''}</span>}
          {value.empresa && <span>{value.empresa}</span>}
          {value.telefone && <span>{fmtTel(value.telefone)}</span>}
        </div>
      </div>
      <button onClick={onClear} style={{ ...btnSecondary, padding: '4px 10px', fontSize: 12 }}>Trocar</button>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        <button onClick={() => setMode('search')} style={{
          fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
          border: 'none', cursor: 'pointer',
          background: mode === 'search' ? 'var(--primary)' : 'var(--surface2)',
          color: mode === 'search' ? '#fff' : 'var(--text2)',
        }}>Buscar existente</button>
        <button onClick={() => setMode('new')} style={{
          fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
          border: 'none', cursor: 'pointer',
          background: mode === 'new' ? TIPO_COLOR[tipoDefault] : 'var(--surface2)',
          color: mode === 'new' ? '#fff' : 'var(--text2)',
        }}>+ Cadastrar novo</button>
      </div>

      {mode === 'search'
        ? <PessoaSearch tipo={tipos as TipoPessoa[]} onSelect={onSelect}
            placeholder={`Buscar ${label.toLowerCase()} por nome, documento…`} />
        : <NovaPessoaForm tipoDefault={tipoDefault} onCreate={p => { onSelect(p); setMode('search') }}
            onCancel={() => setMode('search')} />
      }
    </div>
  )
}

// ── Formulário de Nova Visita ─────────────────────────────────────────────────

// ── Wizard: Registrar Entrada ─────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4

const WIZARD_STEPS = ['Visitante', 'Visitado', 'Detalhes', 'Confirmação']

function StepIndicator({ step, modo }: { step: WizardStep; modo: 'entrada' | 'agendar' }) {
  if (step === 4) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 22 }}>
      {WIZARD_STEPS.slice(0, 3).map((label, i) => {
        const n = (i + 1) as WizardStep
        const done   = step > n
        const active = step === n
        const clr    = done ? '#22c55e' : active ? 'var(--primary)' : 'var(--border)'
        return (
          <div key={n} style={{ display: 'flex', alignItems: 'center', flex: n < 3 ? 1 : undefined }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', display: 'flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                background: done ? '#22c55e' : active ? 'var(--primary)' : 'var(--surface2)',
                color: done || active ? '#fff' : 'var(--text3)',
                border: `2px solid ${clr}`, flexShrink: 0,
                transition: 'all .2s',
              }}>
                {done ? '✓' : n}
              </div>
              <span style={{
                fontSize: 9, fontWeight: active ? 700 : 400, letterSpacing: '.04em',
                color: active ? 'var(--primary)' : done ? '#22c55e' : 'var(--text3)',
                whiteSpace: 'nowrap', textTransform: 'uppercase',
              }}>{label}</span>
            </div>
            {n < 3 && (
              <div style={{
                flex: 1, height: 2, margin: '0 6px', marginBottom: 18,
                background: done ? '#22c55e' : 'var(--border)', borderRadius: 2,
                transition: 'background .3s',
              }} />
            )}
          </div>
        )
      })}
      <div style={{ marginLeft: 16, fontSize: 11, color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap', marginBottom: 18 }}>
        {modo === 'entrada' ? '→ Entrada' : '📅 Agendamento'}
      </div>
    </div>
  )
}

function VeiculoFotoPicker({ files, previews, onAdd, onRemove }: {
  files: File[]; previews: string[]
  onAdd: (f: FileList | null) => void; onRemove: (i: number) => void
}) {
  return (
    <div>
      <label style={label11}>Fotos do Veículo <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(até 6 · opcional)</span></label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {previews.map((src, i) => (
          <div key={i} style={{ position: 'relative', width: 76, height: 58 }}>
            <img src={src} alt="" style={{
              width: '100%', height: '100%', objectFit: 'cover',
              borderRadius: 7, border: '1px solid var(--border)',
            }} />
            <button onClick={() => onRemove(i)} style={{
              position: 'absolute', top: -7, right: -7, width: 20, height: 20,
              borderRadius: '50%', background: '#ef4444', color: '#fff',
              border: '2px solid var(--surface)', cursor: 'pointer',
              fontSize: 12, lineHeight: 1, padding: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>×</button>
          </div>
        ))}
        {files.length < 6 && (
          <label style={{
            width: 76, height: 58, borderRadius: 7, border: '1.5px dashed var(--border)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--text3)', fontSize: 10, gap: 3,
            background: 'var(--surface2)',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/>
              <path d="M21 15l-5-5L5 21"/>
            </svg>
            <span>Adicionar</span>
            <input type="file" accept="image/*" multiple style={{ display: 'none' }}
              onChange={e => onAdd(e.target.files)} />
          </label>
        )}
      </div>
    </div>
  )
}

function NovaVisitaForm({ onSuccess }: { onSuccess: (visitaId: number) => void }) {
  const [step, setStep]           = useState<WizardStep>(1)
  const [modo, setModo]           = useState<'entrada' | 'agendar'>('entrada')
  const [visitante, setVisitante] = useState<Pessoa | null>(null)
  const [visitado, setVisitado]   = useState<Pessoa | null>(null)
  const [placa, setPlaca]         = useState('')
  const [motivo, setMotivo]       = useState('')
  const [fotoFiles, setFotoFiles] = useState<File[]>([])
  const [fotoPreviews, setFotoPreviews] = useState<string[]>([])
  const [saving, setSaving]       = useState(false)
  const [errMsg, setErrMsg]       = useState('')
  const [visitaId, setVisitaId]   = useState<number | null>(null)
  const [lprVinc, setLprVinc]     = useState(false)
  const [fotosVUrl, setFotosVUrl] = useState<string[]>([])

  const addFotos = (files: FileList | null) => {
    if (!files) return
    const arr = Array.from(files).slice(0, 6 - fotoFiles.length)
    setFotoFiles(p => [...p, ...arr])
    setFotoPreviews(p => [...p, ...arr.map(f => URL.createObjectURL(f))])
  }

  const removeFoto = (i: number) => {
    URL.revokeObjectURL(fotoPreviews[i])
    setFotoFiles(p => p.filter((_, idx) => idx !== i))
    setFotoPreviews(p => p.filter((_, idx) => idx !== i))
  }

  const submit = async () => {
    if (!visitante) return
    setSaving(true); setErrMsg('')
    try {
      const endpoint = modo === 'entrada'
        ? '/api/v1/portaria/visitas/entrada'
        : '/api/v1/portaria/visitas/agendar'
      const r = await api.post<{ visita_id: number; lpr_vinculado: boolean }>(endpoint, {
        pessoa_visitante_id: visitante.id,
        pessoa_visitado_id:  visitado?.id ?? null,
        placa_veiculo: placa.trim().toUpperCase() || null,
        motivo: motivo.trim() || null,
        status: modo === 'entrada' ? 'em_visita' : 'agendado',
      })
      const vid = r.data.visita_id
      setVisitaId(vid); setLprVinc(r.data.lpr_vinculado)

      // Upload vehicle photos sequentially
      const uploaded: string[] = []
      for (const file of fotoFiles) {
        try {
          const form = new FormData()
          form.append('visita_id', String(vid))
          form.append('foto', file)
          const ur = await api.post<{ fotos: string[] }>('/api/v1/portaria/upload/veiculo', form, {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
          if (ur.data.fotos.length > uploaded.length) uploaded.push(...ur.data.fotos.slice(uploaded.length))
        } catch {}
      }
      setFotosVUrl(uploaded)
      setStep(4)
    } catch (e: unknown) {
      const ax = e as { response?: { data?: { detail?: string } } }
      setErrMsg(ax.response?.data?.detail || 'Erro ao registrar')
    } finally { setSaving(false) }
  }

  const reset = () => {
    fotoPreviews.forEach(p => URL.revokeObjectURL(p))
    setStep(1); setModo('entrada')
    setVisitante(null); setVisitado(null)
    setPlaca(''); setMotivo('')
    setFotoFiles([]); setFotoPreviews([])
    setVisitaId(null); setFotosVUrl([]); setErrMsg('')
    onSuccess(visitaId ?? 0)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      <StepIndicator step={step} modo={modo} />

      {/* Error banner */}
      {errMsg && (
        <div style={{
          padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, marginBottom: 14,
          background: 'rgba(239,68,68,.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,.3)',
        }}>{errMsg}</div>
      )}

      {/* ── Step 1: Identificar visitante ── */}
      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Modo: entrada vs agendamento */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            {(['entrada', 'agendar'] as const).map(m => (
              <button key={m} onClick={() => setModo(m)} style={{
                padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                border: `1.5px solid ${modo === m ? 'var(--primary)' : 'var(--border)'}`,
                background: modo === m ? 'var(--primary)' : 'transparent',
                color: modo === m ? '#fff' : 'var(--text2)', cursor: 'pointer',
              }}>
                {m === 'entrada' ? '→ Entrada imediata' : '📅 Agendar visita'}
              </button>
            ))}
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ ...label11, marginBottom: 0 }}>
                {modo === 'entrada' ? 'Quem está chegando?' : 'Quem vai visitar?'}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>visitante ou prestador</span>
            </div>
            <PessoaSelector
              tipo={['visitante', 'prestador']}
              label="Buscar visitante ou prestador"
              value={visitante}
              onSelect={setVisitante}
              onClear={() => setVisitante(null)}
            />
          </div>

          {visitante && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: `${TIPO_COLOR[visitante.tipo]}10`,
              border: `1px solid ${TIPO_COLOR[visitante.tipo]}30`,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <Avatar nome={visitante.nome} url={visitante.foto_url} size={42} tipo={visitante.tipo} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{visitante.nome}</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
                  {TIPO_LABEL[visitante.tipo]}
                  {visitante.empresa ? ` · ${visitante.empresa}` : ''}
                  {visitante.cpf ? ` · CPF ${visitante.cpf}` : visitante.rg ? ` · RG ${visitante.rg}` : ''}
                </div>
              </div>
              <TipoBadge tipo={visitante.tipo} />
            </div>
          )}

          <button onClick={() => setStep(2)} disabled={!visitante} style={{
            ...btnPrimary, opacity: !visitante ? .4 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
            Próximo
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
      )}

      {/* ── Step 2: Identificar visitado ── */}
      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ ...label11, marginBottom: 0 }}>Quem será visitado?</span>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>funcionário · opcional</span>
            </div>
            <PessoaSelector
              tipo="funcionario"
              label="Buscar funcionário"
              value={visitado}
              onSelect={setVisitado}
              onClear={() => setVisitado(null)}
            />
          </div>

          {visitado ? (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: `${TIPO_COLOR.funcionario}10`,
              border: `1px solid ${TIPO_COLOR.funcionario}30`,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <Avatar nome={visitado.nome} url={visitado.foto_url} size={42} tipo="funcionario" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{visitado.nome}</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
                  {visitado.departamento ?? 'Funcionário'}
                  {visitado.ramal ? ` · Ramal ${visitado.ramal}` : ''}
                  {visitado.email ? ` · ${visitado.email}` : ''}
                </div>
              </div>
            </div>
          ) : (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface2)', border: '1px dashed var(--border)',
              fontSize: 12, color: 'var(--text3)', textAlign: 'center',
            }}>
              Nenhum funcionário selecionado — você pode prosseguir sem informar
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setStep(1)} style={{ ...btnSecondary, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
              Voltar
            </button>
            <button onClick={() => setStep(3)} style={{ ...btnPrimary, flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              Próximo
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Detalhes da visita ── */}
      {step === 3 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={label11}>Placa do Veículo</label>
              <input value={placa} onChange={e => setPlaca(e.target.value.toUpperCase())}
                placeholder="ABC1D23" maxLength={8}
                style={{ ...inp, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '.1em', fontSize: 14 }} />
            </div>
            <div style={{ flex: 2 }}>
              <label style={label11}>Motivo da Visita</label>
              <input value={motivo} onChange={e => setMotivo(e.target.value)}
                placeholder="Reunião, entrega, manutenção…" style={inp} />
            </div>
          </div>

          <VeiculoFotoPicker
            files={fotoFiles} previews={fotoPreviews}
            onAdd={addFotos} onRemove={removeFoto}
          />

          {/* Resumo */}
          <div style={{
            padding: '10px 14px', borderRadius: 10, background: 'var(--surface2)',
            border: '1px solid var(--border)', fontSize: 12,
          }}>
            <div style={{ fontWeight: 700, color: 'var(--text2)', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 8 }}>
              Resumo
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: visitado ? 8 : 0 }}>
              <Avatar nome={visitante!.nome} url={visitante!.foto_url} size={32} tipo={visitante!.tipo} />
              <div>
                <span style={{ fontWeight: 700, color: 'var(--text)' }}>{visitante!.nome}</span>
                <span style={{ color: 'var(--text2)' }}> · {TIPO_LABEL[visitante!.tipo]}</span>
                {visitante!.empresa && <span style={{ color: 'var(--text3)' }}> · {visitante!.empresa}</span>}
              </div>
            </div>
            {visitado && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 2 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>{visitado.nome}</span>
                {visitado.departamento && <span style={{ color: 'var(--text2)' }}>{visitado.departamento}</span>}
              </div>
            )}
            {(placa || fotoFiles.length > 0) && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', alignItems: 'center' }}>
                {placa && <PlacaBadge placa={placa} />}
                {fotoFiles.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                    🚗 {fotoFiles.length} foto{fotoFiles.length > 1 ? 's' : ''} selecionada{fotoFiles.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setStep(2)} style={{ ...btnSecondary, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
              Voltar
            </button>
            <button onClick={submit} disabled={saving} style={{
              ...btnPrimary, flex: 2, opacity: saving ? .6 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            }}>
              {saving ? (
                <><Spinner size={14} />Registrando…</>
              ) : modo === 'entrada' ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                  Registrar Entrada
                </>
              ) : (
                <>📅 Agendar Visita</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Confirmação ── */}
      {step === 4 && visitaId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Success header */}
          <div style={{
            textAlign: 'center', padding: '18px 16px 14px',
            borderRadius: 12, background: modo === 'entrada' ? 'rgba(34,197,94,.08)' : 'rgba(99,102,241,.08)',
            border: `1px solid ${modo === 'entrada' ? 'rgba(34,197,94,.2)' : 'rgba(99,102,241,.2)'}`,
          }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>
              {modo === 'entrada' ? '✅' : '📅'}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>
              {modo === 'entrada' ? 'Entrada Registrada!' : 'Visita Agendada!'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text2)' }}>
              Visita <strong>#{visitaId}</strong>
              {lprVinc && <span style={{ color: '#22c55e', marginLeft: 8 }}>· Placa vinculada ao LPR ✓</span>}
            </div>
          </div>

          {/* Cartão resumo */}
          <div style={{ ...card, overflow: 'visible' }}>
            <div style={{ padding: '14px 16px', display: 'flex', gap: 10, alignItems: 'center' }}>
              <Avatar nome={visitante!.nome} url={visitante!.foto_url} size={48} tipo={visitante!.tipo} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{visitante!.nome}</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
                  {TIPO_LABEL[visitante!.tipo]}
                  {visitante!.empresa ? ` · ${visitante!.empresa}` : ''}
                </div>
                {(placa || motivo) && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                    {placa && <PlacaBadge placa={placa} />}
                    {motivo && <span style={{ fontSize: 11, color: 'var(--text2)' }}>{motivo}</span>}
                  </div>
                )}
              </div>
            </div>

            {visitado && (
              <div style={{
                padding: '10px 16px', borderTop: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                <Avatar nome={visitado.nome} url={visitado.foto_url} size={28} tipo="funcionario" />
                <div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{visitado.nome}</span>
                  {visitado.departamento && (
                    <span style={{ fontSize: 11, color: 'var(--text2)' }}> · {visitado.departamento}</span>
                  )}
                  {visitado.ramal && (
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}> · Ramal {visitado.ramal}</span>
                  )}
                </div>
              </div>
            )}

            {fotosVUrl.length > 0 && (
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 7 }}>
                  🚗 {fotosVUrl.length} foto{fotosVUrl.length > 1 ? 's' : ''} do veículo
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {fotosVUrl.map((src, i) => (
                    <img key={i} src={src} alt="" style={{
                      width: 64, height: 48, objectFit: 'cover', borderRadius: 5,
                      border: '1px solid var(--border)',
                    }} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <button onClick={reset} style={{
            ...btnPrimary, background: '#22c55e',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
            Nova Entrada
          </button>
        </div>
      )}
    </div>
  )
}

// ── Modal QR Code pré-cadastro ────────────────────────────────────────────────

function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
  document.body.appendChild(ta)
  ta.focus(); ta.select()
  try { document.execCommand('copy'); done() } catch (_) {}
  document.body.removeChild(ta)
}

function QRModal({ url, onClose }: { url: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const [copied, setCopied] = useState(false)
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2500) }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done))
    } else {
      fallbackCopy(url, done)
    }
  }

  const download = () => {
    const svgEl = ref.current?.querySelector('svg')
    if (!svgEl) return
    const svgData = new XMLSerializer().serializeToString(svgEl)
    const canvas = document.createElement('canvas')
    canvas.width = 400; canvas.height = 400
    const ctx = canvas.getContext('2d')!
    const img = new Image()
    img.onload = () => {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 400, 400)
      ctx.drawImage(img, 0, 0, 400, 400)
      const a = document.createElement('a')
      a.download = 'qrcode-pre-cadastro.png'
      a.href = canvas.toDataURL('image/png')
      a.click()
    }
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div ref={ref} style={{
        background: 'var(--surface)', borderRadius: 20,
        boxShadow: '0 24px 80px rgba(0,0,0,.3)',
        width: '100%', maxWidth: 420, overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>Pré-cadastro de Visitantes</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3 }}>
              Compartilhe o QR Code para visitantes se cadastrarem antes de chegar
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: '50%', border: 'none',
            background: 'var(--surface2)', color: 'var(--text2)',
            cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>×</button>
        </div>

        {/* QR Code */}
        <div style={{
          padding: '28px 24px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
        }}>
          <div style={{
            padding: 20, background: '#fff', borderRadius: 16,
            boxShadow: '0 4px 24px rgba(0,0,0,.1)',
            border: '1px solid #e2e8f0',
          }}>
            <QRCodeSVG
              value={url}
              size={220}
              level="H"
              includeMargin={false}
              imageSettings={{
                src: '',
                x: undefined, y: undefined,
                height: 0, width: 0, excavate: false,
              }}
            />
          </div>

          {/* URL */}
          <div style={{
            width: '100%', padding: '10px 14px', borderRadius: 10,
            background: 'var(--surface2)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{
              flex: 1, fontSize: 12, color: 'var(--text2)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontFamily: 'JetBrains Mono, monospace',
            }}>{url}</span>
            <button onClick={copy} style={{
              padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: copied ? '#10b981' : 'var(--primary)',
              color: '#fff', fontSize: 11, fontWeight: 700, flexShrink: 0,
              transition: 'background .2s',
            }}>
              {copied ? '✓ Copiado' : 'Copiar'}
            </button>
          </div>

          {/* Instruções de uso */}
          <div style={{
            width: '100%', padding: '12px 14px', borderRadius: 10,
            background: 'rgba(99,102,241,.06)', border: '1px solid rgba(99,102,241,.2)',
            fontSize: 12, color: 'var(--text2)', lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, color: '#6366f1', marginBottom: 4 }}>Como usar</div>
            <div>📱 Imprima ou exiba a tela para o visitante escanear</div>
            <div>📋 O visitante preenche os dados e recebe um código</div>
            <div>✅ Na chegada, confirme a entrada com um clique</div>
          </div>

          {/* Ações */}
          <div style={{ width: '100%', display: 'flex', gap: 10 }}>
            <button onClick={download} style={{
              flex: 1, padding: '10px', borderRadius: 10,
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text2)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              Baixar PNG
            </button>
            <button onClick={() => window.open(url, '_blank')} style={{
              flex: 1, padding: '10px', borderRadius: 10,
              border: 'none', background: 'var(--primary)',
              color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/>
              </svg>
              Abrir página
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Live duration timer ────────────────────────────────────────────────────────

function LiveTimer({ dataEntrada }: { dataEntrada: string | null }) {
  const [sec, setSec] = useState(() => dataEntrada ? Math.floor((Date.now() - new Date(dataEntrada).getTime()) / 1000) : 0)
  useEffect(() => {
    if (!dataEntrada) return
    const t = setInterval(() => setSec(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [dataEntrada])
  if (!dataEntrada || sec < 0) return <span style={{ color: 'var(--text3)' }}>—</span>
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  if (h > 0) return <span>{h}h {String(m).padStart(2,'0')}min</span>
  return <span>{String(m).padStart(2,'0')}:{String(s).padStart(2,'0')}</span>
}

// ── Cartão de Visita Ativa ────────────────────────────────────────────────────

function VisitaCard({ v, onSaida }: { v: VisitaAtiva; onSaida: (id: number) => void }) {
  const [confirmando, setConfirmando] = useState(false)
  const [lb, setLb] = useState<string | null>(null)
  const { can } = useAuth()
  const cor   = STATUS_COLOR[v.status] ?? '#94a3b8'
  const ativo = v.status === 'em_visita'

  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${v.visitante_blacklist ? 'rgba(239,68,68,.4)' : 'var(--border)'}`,
      boxShadow: v.visitante_blacklist ? '0 0 0 1px rgba(239,68,68,.2)' : ativo ? '0 2px 12px rgba(34,197,94,.08)' : 'none',
    }}>
      {lb && <Lightbox src={lb} onClose={() => setLb(null)} />}

      {/* Status strip */}
      <div style={{
        height: 4,
        background: `linear-gradient(90deg, ${cor}, ${cor}88)`,
      }} />

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Visitor header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <Avatar nome={v.visitante_nome} url={v.visitante_foto} size={52} tipo={v.visitante_tipo} />
            {ativo && (
              <span style={{
                position: 'absolute', bottom: -1, right: -1,
                width: 12, height: 12, borderRadius: '50%',
                background: '#22c55e', border: '2px solid var(--surface)',
                boxShadow: '0 0 0 0 rgba(34,197,94,.5)',
                animation: 'pulse-green 2s ease-in-out infinite',
              }} />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: v.visitante_blacklist ? '#ef4444' : 'var(--text)', letterSpacing: '-.01em' }}>
                {v.visitante_nome}
              </span>
              <TipoBadge tipo={v.visitante_tipo} />
              {v.visitante_blacklist && <BlacklistBadge />}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--text2)' }}>
              {v.visitante_empresa && <span style={{ fontWeight: 500 }}>{v.visitante_empresa}</span>}
              {v.visitante_telefone && <span>{fmtTel(v.visitante_telefone)}</span>}
              {v.visitante_cpf && <span style={{ color: 'var(--text3)', fontSize: 11 }}>CPF {v.visitante_cpf}</span>}
              {v.visitante_rg && <span style={{ color: 'var(--text3)', fontSize: 11 }}>RG {v.visitante_rg}</span>}
            </div>
          </div>

          {/* Time + status */}
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
              borderRadius: 20, background: `${cor}18`, border: `1px solid ${cor}40`,
              fontSize: 11, fontWeight: 700, color: cor, marginBottom: 5,
            }}>
              {STATUS_LABEL[v.status]}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              {v.data_entrada ? fmtHora(v.data_entrada) : '—'}
            </div>
            {ativo && (
              <div style={{ fontSize: 13, fontWeight: 800, color: '#22c55e', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                <LiveTimer dataEntrada={v.data_entrada} />
              </div>
            )}
          </div>
        </div>

        {/* Host (visitado) */}
        {v.visitado_nome && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', borderRadius: 10,
            background: `${TIPO_COLOR.funcionario}0d`,
            border: `1px solid ${TIPO_COLOR.funcionario}25`,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
              background: `${TIPO_COLOR.funcionario}20`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={TIPO_COLOR.funcionario} strokeWidth="2" strokeLinecap="round">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 11a4 4 0 100-8 4 4 0 000 8z"/>
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{v.visitado_nome}</div>
              {(v.visitado_departamento || v.visitado_ramal) && (
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {v.visitado_departamento}{v.visitado_ramal ? ` · Ramal ${v.visitado_ramal}` : ''}
                </div>
              )}
            </div>
            {v.visitado_email && (
              <span style={{ fontSize: 10, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                {v.visitado_email}
              </span>
            )}
          </div>
        )}

        {/* Placa + motivo + fotos */}
        {(v.placa_veiculo || v.motivo || (v.fotos_veiculo?.length ?? 0) > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {v.placa_veiculo && <PlacaBadge placa={v.placa_veiculo} />}
            {v.motivo && (
              <span style={{
                fontSize: 11, color: 'var(--text2)', background: 'var(--surface2)',
                padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)',
              }}>{v.motivo}</span>
            )}
            {(v.fotos_veiculo?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {v.fotos_veiculo.slice(0, 3).map((u, i) => (
                  <img key={i} src={u} alt="" onClick={() => setLb(u)}
                    style={{ width: 36, height: 28, objectFit: 'cover', borderRadius: 5, cursor: 'zoom-in', border: '1px solid var(--border)' }} />
                ))}
                {v.fotos_veiculo.length > 3 && (
                  <div style={{ width: 36, height: 28, borderRadius: 5, background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--text3)', cursor: 'pointer', border: '1px solid var(--border)' }}
                    onClick={() => setLb(v.fotos_veiculo[3])}>
                    +{v.fotos_veiculo.length - 3}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Action */}
        {can.portaria.write && v.status !== 'saiu' && v.status !== 'cancelado' && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {confirmando ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <div style={{
                  flex: 1, fontSize: 12, color: 'var(--text2)',
                  padding: '7px 12px', borderRadius: 8, background: 'rgba(239,68,68,.06)',
                  border: '1px solid rgba(239,68,68,.2)',
                }}>
                  Confirmar saída de <strong>{v.visitante_nome.split(' ')[0]}</strong>?
                </div>
                <button onClick={() => { onSaida(v.id); setConfirmando(false) }} style={{
                  padding: '7px 16px', borderRadius: 8, border: 'none',
                  background: '#ef4444', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}>Confirmar</button>
                <button onClick={() => setConfirmando(false)} style={{
                  padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--text2)', fontSize: 12, cursor: 'pointer',
                }}>Cancelar</button>
              </div>
            ) : (
              <button onClick={() => setConfirmando(true)} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 16px', borderRadius: 8,
                border: '1px solid rgba(239,68,68,.4)',
                background: 'rgba(239,68,68,.06)',
                color: '#ef4444', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9"/>
                </svg>
                Registrar Saída
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pré-cadastro Card ─────────────────────────────────────────────────────────

interface PreCadastradoItem {
  id: number; visitante_nome: string; visitante_tipo: TipoPessoa
  visitante_empresa: string | null; visitante_foto: string | null
  visitante_telefone: string | null; visitante_blacklist: boolean
  visitante_cpf: string | null; visitante_rg: string | null; visitante_cnh: string | null
  visitado_nome: string | null; visitado_departamento: string | null
  motivo: string | null; visitado_texto: string | null
  pessoa_visitante_id: number; pessoa_visitado_id: number | null
  status: string
}

function PreCadastradoCard({ v, onConfirmar }: {
  v: PreCadastradoItem; onConfirmar: (pessoaId: number) => void
}) {
  const [loading, setLoading] = useState(false)
  const { can } = useAuth()

  const confirmar = async () => {
    setLoading(true)
    try { await onConfirmar(v.pessoa_visitante_id) } finally { setLoading(false) }
  }

  const destino = v.visitado_nome
    ? `${v.visitado_nome}${v.visitado_departamento ? ` · ${v.visitado_departamento}` : ''}`
    : v.visitado_texto || null

  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 14, overflow: 'hidden',
      border: '1.5px dashed rgba(99,102,241,.4)',
      boxShadow: '0 2px 12px rgba(99,102,241,.08)',
    }}>
      <div style={{ height: 3, background: 'linear-gradient(90deg,#6366f1,#8b5cf6)' }} />
      <div style={{ padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' }}>

        <div style={{ position: 'relative', flexShrink: 0 }}>
          <Avatar nome={v.visitante_nome} url={v.visitante_foto} size={46} tipo={v.visitante_tipo} />
          <span style={{
            position: 'absolute', bottom: -2, right: -2,
            background: '#6366f1', borderRadius: '50%', border: '2px solid var(--surface)',
            width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round">
              <path d="M12 2v20M2 12h20"/>
            </svg>
          </span>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{v.visitante_nome}</span>
            <TipoBadge tipo={v.visitante_tipo} />
            <span style={{
              fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
              background: 'rgba(99,102,241,.15)', color: '#6366f1', letterSpacing: '.05em',
            }}>PRÉ-CADASTRO</span>
            {v.visitante_blacklist && <BlacklistBadge />}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {v.visitante_empresa && <span>{v.visitante_empresa}</span>}
            {destino && <span style={{ color: '#6366f1' }}>→ {destino}</span>}
            {v.motivo && <span style={{ color: 'var(--text3)' }}>· {v.motivo}</span>}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 3 }}>
            {v.visitante_cpf && <span>CPF {v.visitante_cpf}</span>}
            {v.visitante_rg && <span>RG {v.visitante_rg}</span>}
            {v.visitante_cnh && <span>CNH {v.visitante_cnh}</span>}
            {v.visitante_telefone && <span>{v.visitante_telefone}</span>}
          </div>
        </div>

        {can.portaria.write && (
          <button onClick={confirmar} disabled={loading} style={{
            flexShrink: 0, padding: '8px 16px', borderRadius: 10, border: 'none',
            background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
            color: '#fff', fontSize: 12, fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? .7 : 1, display: 'flex', alignItems: 'center', gap: 6,
            boxShadow: '0 3px 12px rgba(99,102,241,.35)',
          }}>
            {loading ? <Spinner size={12} /> : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
                Confirmar Entrada
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Painel (tab principal) ────────────────────────────────────────────────────

function PainelTab() {
  const [resumo, setResumo]       = useState<Resumo>({ em_visita: 0, aguardando: 0, agendados: 0, saidas_hoje: 0 })
  const [visitas, setVisitas]     = useState<VisitaAtiva[]>([])
  const [preCadastros, setPreCad] = useState<PreCadastradoItem[]>([])
  const [loading, setLoading]     = useState(true)
  const [showQR, setShowQR]       = useState(false)
  const { can } = useAuth()

  const preCadURL = `${window.location.origin}/pre-cadastro`

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ resumo: Resumo; visitas: VisitaAtiva[] }>('/api/v1/portaria/status')
      setResumo(r.data.resumo)
      setVisitas(r.data.visitas.filter((v: VisitaAtiva & { pre_cadastro?: boolean }) => !v.pre_cadastro))
      const pre = (r.data.visitas as unknown as (VisitaAtiva & { pre_cadastro?: boolean })[])
        .filter(v => v.pre_cadastro && v.status === 'agendado')
      setPreCad(pre as unknown as PreCadastradoItem[])
    } catch {} finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { const t = setInterval(refresh, 15000); return () => clearInterval(t) }, [refresh])

  const handleSaida = async (visitaId: number) => {
    try { await api.post(`/api/v1/portaria/visitas/saida/${visitaId}`, {}); refresh() } catch {}
  }

  const handleConfirmarChegada = async (pessoaId: number) => {
    try {
      await api.post('/api/v1/portaria/visitas/entrada', { pessoa_visitante_id: pessoaId, status: 'em_visita' })
      refresh()
    } catch {}
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {showQR && <QRModal url={preCadURL} onClose={() => setShowQR(false)} />}

      {/* ── Stats strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          { label: 'Em Visita',   value: resumo.em_visita,   color: '#22c55e', bg: 'rgba(34,197,94,.08)',   icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z', pulse: resumo.em_visita > 0 },
          { label: 'Aguardando',  value: resumo.aguardando,  color: '#f59e0b', bg: 'rgba(245,158,11,.08)',  icon: 'M12 2a10 10 0 110 20A10 10 0 0112 2z M12 6v6l4 2', pulse: false },
          { label: 'Agendados',   value: resumo.agendados,   color: '#6366f1', bg: 'rgba(99,102,241,.08)',  icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', pulse: false },
          { label: 'Saídas Hoje', value: resumo.saidas_hoje, color: '#64748b', bg: 'rgba(100,116,139,.08)', icon: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9', pulse: false },
        ].map(s => (
          <div key={s.label} style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 14, padding: '16px 18px', overflow: 'hidden', position: 'relative',
            transition: 'box-shadow .2s',
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${s.color},${s.color}50)` }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 30, fontWeight: 900, color: s.color, lineHeight: 1, letterSpacing: '-.03em', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {s.value}
                  {s.pulse && s.value > 0 && (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block', animation: 'pulse-green 1.8s ease-in-out infinite' }} />
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 5, fontWeight: 600, letterSpacing: '.01em' }}>{s.label}</div>
              </div>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={s.color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d={s.icon} />
                </svg>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Main two-column grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: can.portaria.write ? '400px 1fr' : '1fr', gap: 20, alignItems: 'start' }}>

        {/* ── LEFT: Entry form panel (operador/admin only) ── */}
        {can.portaria.write && <div style={{
          background: 'var(--surface)', borderRadius: 16,
          border: '1px solid var(--border)',
          overflow: 'hidden',
          position: 'sticky', top: 24,
        }}>
          {/* Panel header */}
          <div style={{
            padding: '14px 18px',
            background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#fff', letterSpacing: '-.01em' }}>
                Registrar Entrada
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.65)', marginTop: 2 }}>
                Entrada imediata ou agendamento
              </div>
            </div>
            <button
              onClick={() => setShowQR(true)}
              title="QR Code pré-cadastro"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 8,
                border: '1px solid rgba(255,255,255,.3)',
                background: 'rgba(255,255,255,.12)',
                color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                transition: 'background .15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.22)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,.12)')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="3" height="3"/>
                <rect x="18" y="14" width="3" height="3"/><rect x="14" y="18" width="3" height="3"/>
                <rect x="18" y="18" width="3" height="3"/>
              </svg>
              QR Code
            </button>
          </div>
          <div style={{ padding: '18px' }}>
            <NovaVisitaForm onSuccess={refresh} />
          </div>
        </div>}

        {/* ── RIGHT: Activity feed ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Section header with refresh */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', letterSpacing: '-.01em' }}>
                Atividade em Tempo Real
              </div>
              {(resumo.em_visita + preCadastros.length) > 0 && (
                <span style={{
                  fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 20,
                  background: 'rgba(34,197,94,.12)', color: '#22c55e',
                  border: '1px solid rgba(34,197,94,.25)',
                }}>
                  {resumo.em_visita + preCadastros.length} ativos
                </span>
              )}
            </div>
            <button onClick={refresh} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--surface2)',
              color: 'var(--text2)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              transition: 'all .15s',
            }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--primary)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
              Atualizar
            </button>
          </div>

          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 60 }}>
              <Spinner size={32} />
            </div>
          ) : (visitas.length === 0 && preCadastros.length === 0) ? (
            <div style={{
              padding: '60px 20px', textAlign: 'center',
              background: 'var(--surface)', border: '1px dashed var(--border)',
              borderRadius: 16,
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%', background: 'var(--surface2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z"/>
                </svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text2)', marginBottom: 6 }}>
                Nenhuma visita ativa
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                As entradas registradas aparecerão aqui em tempo real
              </div>
            </div>
          ) : (
            <>
              {/* Pré-cadastros aguardando */}
              {preCadastros.length > 0 && (
                <div style={{
                  background: 'var(--surface)', borderRadius: 14,
                  border: '1px solid var(--border)', overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '10px 16px',
                    background: 'linear-gradient(90deg,rgba(99,102,241,.08),transparent)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%', background: '#6366f1', display: 'block',
                      animation: 'pulse-green 2s ease-in-out infinite',
                      boxShadow: '0 0 0 0 rgba(99,102,241,.5)',
                    }} />
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#6366f1', letterSpacing: '.04em', textTransform: 'uppercase' }}>
                      Aguardando Confirmação
                    </span>
                    <span style={{
                      marginLeft: 'auto', fontSize: 11, fontWeight: 800,
                      padding: '2px 8px', borderRadius: 10,
                      background: 'rgba(99,102,241,.15)', color: '#6366f1',
                    }}>{preCadastros.length}</span>
                  </div>
                  <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {preCadastros.map(v => (
                      <PreCadastradoCard key={v.id} v={v} onConfirmar={handleConfirmarChegada} />
                    ))}
                  </div>
                </div>
              )}

              {/* Visitas ativas */}
              {visitas.length > 0 && (
                <div style={{
                  background: 'var(--surface)', borderRadius: 14,
                  border: '1px solid var(--border)', overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '10px 16px',
                    background: 'linear-gradient(90deg,rgba(34,197,94,.06),transparent)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'block',
                      animation: 'pulse-green 1.8s ease-in-out infinite',
                    }} />
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#22c55e', letterSpacing: '.04em', textTransform: 'uppercase' }}>
                      Visitas Ativas
                    </span>
                    <span style={{
                      marginLeft: 'auto', fontSize: 11, fontWeight: 800,
                      padding: '2px 8px', borderRadius: 10,
                      background: 'rgba(34,197,94,.12)', color: '#22c55e',
                    }}>{visitas.length}</span>
                  </div>
                  <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {visitas.map(v => (
                      <VisitaCard key={v.id} v={v} onSaida={handleSaida} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse-green {
          0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,.5); }
          50%       { box-shadow: 0 0 0 6px rgba(34,197,94,0); }
        }
      `}</style>
    </div>
  )
}

// ── Pessoas (tab) ─────────────────────────────────────────────────────────────

function PessoasTab() {
  const [tipo, setTipo]       = useState('')
  const [q, setQ]             = useState('')
  const [pessoas, setPessoas] = useState<Pessoa[]>([])
  const [total, setTotal]     = useState(0)
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Pessoa | null>(null)
  const { can } = useAuth()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get<{ total: number; data: Pessoa[] }>('/api/v1/portaria/pessoas', {
        params: { tipo, q, limit: 50 },
      })
      setPessoas(r.data.data); setTotal(r.data.total)
    } catch {} finally { setLoading(false) }
  }, [tipo, q])

  useEffect(() => { const t = setTimeout(load, 280); return () => clearTimeout(t) }, [load])

  const tipoFiltros = [
    { value: '', label: 'Todos' },
    { value: 'funcionario', label: 'Funcionários', color: TIPO_COLOR.funcionario },
    { value: 'visitante', label: 'Visitantes', color: TIPO_COLOR.visitante },
    { value: 'prestador', label: 'Prestadores', color: TIPO_COLOR.prestador },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface2)', borderRadius: 10, padding: 4 }}>
          {tipoFiltros.map(t => (
            <button key={t.value} onClick={() => setTipo(t.value)} style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: 'none',
              background: tipo === t.value ? 'var(--surface)' : 'transparent',
              color: tipo === t.value ? (t.color ?? 'var(--primary)') : 'var(--text2)',
              boxShadow: tipo === t.value ? '0 1px 4px rgba(0,0,0,.15)' : 'none',
              transition: 'all .15s',
            }}>{t.label}</button>
          ))}
        </div>
        <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Buscar por nome, documento, telefone…"
            style={{ ...inp, paddingLeft: 32 }} />
        </div>
        {can.portaria.write && (
          <button onClick={() => { setShowForm(true); setEditing(null) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 18px', borderRadius: 10, border: 'none',
              background: 'var(--primary)', color: '#fff',
              fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
              boxShadow: '0 3px 12px rgba(99,102,241,.3)',
            }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Nova Pessoa
          </button>
        )}
      </div>

      {/* Inline form */}
      {can.portaria.write && (showForm || editing) && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 16, padding: '20px', borderTop: '3px solid var(--primary)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 16, color: 'var(--text)' }}>
            {editing ? `Editar: ${editing.nome}` : 'Cadastrar Nova Pessoa'}
          </div>
          <NovaPessoaForm
            tipoDefault={editing?.tipo ?? 'visitante'}
            onCreate={_p => { setShowForm(false); setEditing(null); load(); }}
            onCancel={() => { setShowForm(false); setEditing(null) }}
          />
        </div>
      )}

      {/* Count */}
      <div style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 500 }}>
        {loading ? 'Carregando…' : `${total} pessoa${total !== 1 ? 's' : ''} encontrada${total !== 1 ? 's' : ''}`}
      </div>

      {/* Grid de pessoas */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 12,
      }}>
        {pessoas.map(p => (
          <PessoaCard key={p.id} pessoa={p} onEdit={setEditing} onUpdate={load} />
        ))}
        {!loading && pessoas.length === 0 && (
          <div style={{
            gridColumn: '1/-1', padding: '60px 20px', textAlign: 'center',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
          }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>👤</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)' }}>Nenhuma pessoa encontrada</div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── PessoaCard ────────────────────────────────────────────────────────────────

function PessoaCard({ pessoa: p, onEdit, onUpdate }: {
  pessoa: Pessoa; onEdit: (p: Pessoa) => void; onUpdate: () => void
}) {
  const [expanded, setExpanded]     = useState(false)
  const [fotoRosto, setFotoRosto]   = useState<string | null>(p.foto_url)
  const [fotosDoc, setFotosDoc]     = useState<string[]>(p.fotos_documento)
  const [uploadingD, setUploadingD] = useState(false)
  const [uploadErrD, setUploadErrD] = useState('')
  const [lb, setLb]                 = useState<string | null>(null)
  const tCor = TIPO_COLOR[p.tipo]

  const uploadDoc = async (file: File) => {
    setUploadingD(true); setUploadErrD('')
    try {
      const form = new FormData(); form.append('foto', file)
      const r = await api.post<{ fotos: string[] }>(`/api/v1/portaria/upload/documento/${p.id}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setFotosDoc(r.data.fotos)
    } catch { setUploadErrD('Erro no upload') } finally { setUploadingD(false) }
  }

  const deleteDoc = async (url: string) => {
    try {
      const r = await api.delete<{ fotos: string[] }>(`/api/v1/portaria/upload/documento/${p.id}`, { params: { url } })
      setFotosDoc(r.data.fotos)
    } catch {}
  }

  const toggleBlacklist = async () => {
    try {
      await api.patch(`/api/v1/portaria/pessoas/${p.id}`, { status_blacklist: !p.status_blacklist })
      onUpdate()
    } catch {}
  }

  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${p.status_blacklist ? 'rgba(239,68,68,.35)' : 'var(--border)'}`,
      boxShadow: p.status_blacklist ? '0 0 0 1px rgba(239,68,68,.15)' : 'none',
      transition: 'box-shadow .2s',
    }}>
      {lb && <Lightbox src={lb} onClose={() => setLb(null)} />}

      {/* Type color strip */}
      <div style={{ height: 4, background: `linear-gradient(90deg, ${tCor}, ${tCor}60)` }} />

      {/* Main row — clickable */}
      <div
        style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start' }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <Avatar nome={p.nome} url={fotoRosto} size={48} tipo={p.tipo} />
          {!p.ativo && (
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.8)" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>
              </svg>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{
              fontSize: 14, fontWeight: 800, color: p.status_blacklist ? '#ef4444' : 'var(--text)',
              letterSpacing: '-.01em',
            }}>
              {p.nome}
            </span>
            <TipoBadge tipo={p.tipo} />
            {p.status_blacklist && <BlacklistBadge />}
            {!p.ativo && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4,
                background: 'var(--surface2)', color: 'var(--text3)', letterSpacing: '.04em',
              }}>INATIVO</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {p.empresa && <span style={{ fontWeight: 500 }}>{p.empresa}</span>}
            {p.departamento && <span>{p.departamento}{p.ramal ? ` · R.${p.ramal}` : ''}</span>}
            {p.cpf && <span style={{ color: 'var(--text3)' }}>CPF {p.cpf}</span>}
            {p.rg && <span style={{ color: 'var(--text3)' }}>RG {p.rg}</span>}
            {p.cnh && <span style={{ color: 'var(--text3)' }}>CNH {p.cnh}</span>}
            {p.telefone && <span>{fmtTel(p.telefone)}</span>}
            {p.email && <span style={{ color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{p.email}</span>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={e => { e.stopPropagation(); onEdit(p) }}
            style={{
              padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text2)',
            }}
          >
            Editar
          </button>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </div>
      </div>

      {/* Expanded section */}
      {expanded && (
        <div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 12 }}>
            <FotoRosto pessoaId={p.id} fotoUrl={fotoRosto} nome={p.nome} tipo={p.tipo}
              onUpdate={setFotoRosto} size={72} />
            <div style={{ flex: 1 }}>
              <label style={label11}>Documentos (RG, CNH, Passaporte)</label>
              <FotoGaleria fotos={fotosDoc} onUpload={uploadDoc} onDelete={deleteDoc}
                max={4} uploading={uploadingD} uploadError={uploadErrD} />
            </div>
          </div>

          {p.observacoes && (
            <div style={{
              marginBottom: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--border)',
              fontSize: 12, color: 'var(--text2)', fontStyle: 'italic',
            }}>
              {p.observacoes}
            </div>
          )}

          <button onClick={toggleBlacklist} style={{
            padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            border: `1px solid ${p.status_blacklist ? 'rgba(34,197,94,.4)' : 'rgba(239,68,68,.4)'}`,
            background: p.status_blacklist ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
            color: p.status_blacklist ? '#22c55e' : '#ef4444',
          }}>
            {p.status_blacklist ? '✓ Remover bloqueio' : '⛔ Bloquear pessoa'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Histórico (tab) ───────────────────────────────────────────────────────────

function HistoricoTab() {
  const [q, setQ]             = useState('')
  const [status, setStatus]   = useState('')
  const [data, setData]       = useState<VisitaHistorico[]>([])
  const [total, setTotal]     = useState(0)
  const [loading, setLoading] = useState(false)
  const [offset, setOffset]   = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [lb, setLb]           = useState<string | null>(null)
  const PAGE = 30

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get<{ total: number; data: VisitaHistorico[] }>('/api/v1/portaria/visitas', {
        params: { q, status, limit: PAGE, offset },
      })
      setData(r.data.data); setTotal(r.data.total)
    } catch {} finally { setLoading(false) }
  }, [q, status, offset])

  useEffect(() => { const t = setTimeout(load, 280); return () => clearTimeout(t) }, [load])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {lb && <Lightbox src={lb} onClose={() => setLb(null)} />}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 300 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input value={q} onChange={e => { setQ(e.target.value); setOffset(0) }}
            placeholder="Buscar por nome, documento…" style={{ ...inp, paddingLeft: 32 }} />
        </div>
        <select value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }}
          style={{ ...inp, width: 'auto', minWidth: 160 }}>
          <option value="">Todos os status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 'auto' }}>
          {loading ? 'Carregando…' : `${total} visita${total !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.map(v => {
          const open = expanded === v.id
          const cor  = STATUS_COLOR[v.status] ?? '#94a3b8'
          return (
            <div key={v.id} style={{
              background: 'var(--surface)', borderRadius: 12, overflow: 'hidden',
              border: '1px solid var(--border)',
              borderLeft: `4px solid ${cor}`,
              transition: 'box-shadow .15s',
            }}>

              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer' }}
                onClick={() => setExpanded(open ? null : v.id)}
              >
                <Avatar nome={v.visitante_nome} url={v.foto_url} size={40} tipo={v.visitante_tipo} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{v.visitante_nome}</span>
                    <TipoBadge tipo={v.visitante_tipo} />
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                      background: `${cor}18`, color: cor, letterSpacing: '.04em',
                    }}>
                      {STATUS_LABEL[v.status]}
                    </span>
                    {v.visitante_blacklist && <BlacklistBadge />}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {v.visitado_nome && <span style={{ color: 'var(--primary)' }}>→ {v.visitado_nome}</span>}
                    {v.empresa && <span>{v.empresa}</span>}
                    {v.motivo && <span style={{ color: 'var(--text3)' }}>{v.motivo}</span>}
                  </div>
                </div>

                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>
                    {v.data_entrada ? format(new Date(v.data_entrada), 'dd/MM HH:mm') : '—'}
                  </div>
                  {v.data_saida && (
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                      saída {fmtHora(v.data_saida)}
                    </div>
                  )}
                  {v.placa_veiculo && <PlacaBadge placa={v.placa_veiculo} />}
                </div>

                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"
                  style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }}>
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </div>

              {open && (
                <div style={{ padding: '0 14px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
                    {(v.fotos_veiculo?.length ?? 0) > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 6 }}>Fotos do Veículo</div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {v.fotos_veiculo.map((u, i) => (
                            <img key={i} src={u} alt="" onClick={() => setLb(u)} style={{
                              width: 72, height: 54, objectFit: 'cover', borderRadius: 7,
                              cursor: 'zoom-in', border: '1px solid var(--border)',
                            }} />
                          ))}
                        </div>
                      </div>
                    )}
                    {(v.fotos_documento?.length ?? 0) > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 6 }}>Documentos</div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {v.fotos_documento.map((u, i) => (
                            <img key={i} src={u} alt="" onClick={() => setLb(u)} style={{
                              width: 72, height: 54, objectFit: 'cover', borderRadius: 7,
                              cursor: 'zoom-in', border: '1px solid var(--border)',
                            }} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)' }}>
                    {v.cpf && <span>CPF {v.cpf}</span>}
                    {v.rg && <span>RG {v.rg}</span>}
                    {v.cnh && <span>CNH {v.cnh}</span>}
                    {v.observacoes && <span>Obs: {v.observacoes}</span>}
                    <span style={{ marginLeft: 'auto' }}>Criado: {format(new Date(v.criado_em), "dd/MM/yyyy 'às' HH:mm")}</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {total > PAGE && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 4, alignItems: 'center' }}>
          <button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0}
            style={{ ...btnSecondary, opacity: offset === 0 ? .4 : 1, fontSize: 12, padding: '7px 16px' }}>
            ← Anterior
          </button>
          <span style={{ fontSize: 12, color: 'var(--text2)', padding: '0 8px', fontWeight: 500 }}>
            {Math.floor(offset / PAGE) + 1} / {Math.ceil(total / PAGE)} · {total} registros
          </span>
          <button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total}
            style={{ ...btnSecondary, opacity: offset + PAGE >= total ? .4 : 1, fontSize: 12, padding: '7px 16px' }}>
            Próxima →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Página Principal ──────────────────────────────────────────────────────────

export default function Portaria() {
  const [tab, setTab] = useState<'painel' | 'pessoas' | 'historico'>('painel')
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])

  const tabs = [
    { key: 'painel',    label: 'Painel Operacional',  icon: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z' },
    { key: 'pessoas',   label: 'Cadastro de Pessoas', icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75' },
    { key: 'historico', label: 'Histórico',           icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  ] as const

  const fmtTime = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const fmtDate = (d: Date) => d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>

      {/* ── Page header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '0 0 20px',
        borderBottom: '1px solid var(--border)',
        marginBottom: 0,
      }}>
        {/* Icon + title */}
        <div style={{
          width: 44, height: 44, borderRadius: 12, flexShrink: 0,
          background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(99,102,241,.35)',
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text)', letterSpacing: '-.02em', lineHeight: 1 }}>
            Gestão de Portaria
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
            Controle de acesso e gestão de visitantes
          </div>
        </div>
        {/* Live status + clock */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{
              fontSize: 22, fontWeight: 800, color: 'var(--text)',
              fontFamily: 'JetBrains Mono, monospace', letterSpacing: '.04em', lineHeight: 1,
            }}>
              {fmtTime(now)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3, textTransform: 'capitalize' }}>
              {fmtDate(now)}
            </div>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: 20,
            background: 'rgba(34,197,94,.1)', border: '1px solid rgba(34,197,94,.25)',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', background: '#22c55e',
              animation: 'pulse-green 2s ease-in-out infinite', display: 'block',
            }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', letterSpacing: '.04em' }}>SISTEMA ATIVO</span>
          </div>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div style={{
        display: 'flex', gap: 4, padding: '16px 0 0',
        borderBottom: '1px solid var(--border)',
        marginBottom: 24,
      }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px',
            border: 'none', borderRadius: '10px 10px 0 0',
            background: tab === t.key ? 'var(--surface)' : 'transparent',
            cursor: 'pointer', fontSize: 13, fontWeight: 700,
            color: tab === t.key ? 'var(--primary)' : 'var(--text2)',
            borderBottom: tab === t.key ? '2px solid var(--primary)' : '2px solid transparent',
            marginBottom: -1, transition: 'all .15s',
            boxShadow: tab === t.key ? '0 -2px 12px rgba(0,0,0,.06)' : 'none',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d={t.icon} />
            </svg>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'painel'    && <PainelTab />}
      {tab === 'pessoas'   && <PessoasTab />}
      {tab === 'historico' && <HistoricoTab />}
    </div>
  )
}
