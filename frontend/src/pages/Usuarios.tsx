import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import { useAuth, savePermMap, type PermMap } from '../hooks/useAuth'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Usuario {
  id:           number
  uuid:         string
  nome:         string
  email:        string
  perfil:       'admin' | 'gerente' | 'operador' | 'viewer'
  ativo:        boolean
  ultimo_login: string | null
  criado_em:    string
  whatsapp:     string | null
  telegram:     string | null
  cargo:        string | null
  departamento: string | null
  avatar:       string | null
}

type ModalMode = 'create' | 'edit' | 'reset' | null

const EMPTY_FORM = {
  nome: '', email: '', senha: '', perfil: 'operador' as string,
  ativo: true, whatsapp: '', telegram: '', cargo: '', departamento: '',
}

// ── Perfis ────────────────────────────────────────────────────────────────────

const PERFIS = [
  {
    key:   'admin',
    label: 'Administrador',
    color: '#ef4444',
    bg:    'rgba(239,68,68,.08)',
    desc:  'Acesso total — câmeras, watchlist, sistema e gestão de usuários.',
  },
  {
    key:   'gerente',
    label: 'Gerente',
    color: '#f59e0b',
    bg:    'rgba(245,158,11,.08)',
    desc:  'Gestão de frota e telemétrica — acesso ao módulo Vídeo Telemétrica.',
  },
  {
    key:   'operador',
    label: 'Operador',
    color: '#6366f1',
    bg:    'rgba(99,102,241,.08)',
    desc:  'Operação completa — testa câmeras, gerencia watchlist e acessa sistema.',
  },
  {
    key:   'viewer',
    label: 'Visualizador',
    color: '#94a3b8',
    bg:    'rgba(148,163,184,.08)',
    desc:  'Somente leitura — Dashboard, Detecções, Analytics e Watchlist.',
  },
] as const

// Linhas da matriz: key = chave em PermMap, locked = não editável pelo admin
// group = inicia um novo grupo (linha de cabeçalho de seção)
// lockVw = viewer sempre bloqueado (falso); key=null = somente leitura (verdadeiro para todos)
const MATRIX_ROWS: {
  modulo: string
  rota:   string
  key:    keyof PermMap['operador'] | null
  lockVw?: boolean
  group?:  string
  desc:   string
}[] = [
  // ── Monitoramento ─────────────────────────────────────────────────────────
  { group: 'Monitoramento',
    modulo: 'Dashboard',       rota: '/',          key: null, desc: 'Visão geral com KPIs e status em tempo real' },
  { modulo: 'Leitura LPR',     rota: '/deteccoes', key: null, desc: 'Detecções e leituras de placas por câmeras LPR' },
  { modulo: 'Leitura Pessoas', rota: '/pessoas',   key: null, desc: 'Contagem e fluxo de pessoas por câmeras' },
  { modulo: 'EPI / PPE',       rota: '/epi',       key: null, desc: 'Análise de uso de equipamentos de proteção' },
  { modulo: 'Analytics',       rota: '/analytics', key: null, desc: 'Resumo e estatísticas por câmera nas últimas 24 h' },
  // ── Watchlist ─────────────────────────────────────────────────────────────
  { group: 'Watchlist',
    modulo: 'Watchlist — visualizar', rota: '/watchlist', key: 'watchlist_ver',    desc: 'Consultar registros de placas monitoradas' },
  { modulo: 'Watchlist — editar',     rota: '/watchlist', key: 'watchlist_editar', desc: 'Adicionar, editar e remover placas da watchlist' },
  // ── Câmeras ───────────────────────────────────────────────────────────────
  { group: 'Câmeras',
    modulo: 'Câmeras — visualizar',              rota: '/cameras', key: 'cameras_ver',    desc: 'Ver câmeras cadastradas, status e detalhes' },
  { modulo: 'Câmeras — cadastrar / editar / excluir', rota: '/cameras', key: 'cameras_crud', lockVw: true, desc: 'Gerenciar cadastro de câmeras no sistema' },
  { modulo: 'Câmeras — testar conexão',          rota: '/cameras', key: 'cameras_testar', desc: 'Iniciar testes de stream e conectividade' },
  // ── Portaria ──────────────────────────────────────────────────────────────
  { group: 'Portaria',
    modulo: 'Portaria — visualizar',              rota: '/portaria', key: 'portaria_ver',    desc: 'Ver visitas ativas, histórico e cadastro de pessoas' },
  { modulo: 'Portaria — registrar / gerenciar',  rota: '/portaria', key: 'portaria_editar', desc: 'Registrar entradas/saídas, cadastrar e editar pessoas' },
  // ── Sistema e Administração ───────────────────────────────────────────────
  { group: 'Sistema',
    modulo: 'Sistema',             rota: '/sistema',   key: 'sistema',   desc: 'Painel de saúde, logs e configurações do sistema' },
  { group: 'Administração',
    modulo: 'Gestão de Usuários', rota: '/usuarios',  key: 'usuarios',  lockVw: true, desc: 'Criar e gerenciar usuários e matrizes de permissão' },
]

const DEFAULT_PERM_MAP: PermMap = {
  gerente: {
    watchlist_ver: true, watchlist_editar: true,
    cameras_ver: true,   cameras_crud: true,
    cameras_testar: true, sistema: true, usuarios: false,
    portaria_ver: true,  portaria_editar: true,
  },
  operador: {
    watchlist_ver: true, watchlist_editar: true,
    cameras_ver: true,   cameras_crud: false,
    cameras_testar: true, sistema: true, usuarios: false,
    portaria_ver: true,  portaria_editar: true,
  },
  viewer: {
    watchlist_ver: true, watchlist_editar: false,
    cameras_ver: true,   cameras_crud: false,
    cameras_testar: false, sistema: true, usuarios: false,
    portaria_ver: true,  portaria_editar: false,
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(nome: string) {
  return nome.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

function perfilCfg(key: string) {
  return PERFIS.find(p => p.key === key) ?? PERFIS[2]
}

function apiErr(e: unknown) {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Erro inesperado'
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface2)',
  color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
  transition: 'border-color .15s',
}

const lbl: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.04em',
  textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 5,
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

const ICO = {
  plus:     'M12 5v14M5 12h14',
  edit:     'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  key:      'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  trash:    'M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2',
  lock:     'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  layers:   'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  eye:      'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 100 6 3 3 0 000-6z',
  wa:       'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
  tg:       'M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z',
  matrix:   'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  chevron:  'M6 9l6 6 6-6',
  x:        'M18 6L6 18M6 6l12 12',
  check:    'M20 6L9 17 4 12',
  image:    'M21 15l-5-5L5 20 M3 3h18v18H3z M8.5 8.5a1 1 0 100-2 1 1 0 000 2z',
  upload:   'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
  trash2:   'M3 6h18 M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6 M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2',
}

function Ico({ d, size = 14, style }: { d: string; size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}>
      <path d={d} />
    </svg>
  )
}

function PerfilIcon({ perfil }: { perfil: string }) {
  const d = perfil === 'admin' ? ICO.lock : perfil === 'operador' ? ICO.layers : ICO.eye
  return <Ico d={d} size={13} />
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)} style={{
      position: 'relative', width: 38, height: 21, borderRadius: 10.5, flexShrink: 0,
      background: value ? 'var(--primary)' : 'var(--border)',
      border: 'none', cursor: 'pointer', transition: 'background .2s',
    }}>
      <span style={{
        position: 'absolute', top: 3, left: value ? 19 : 3,
        width: 15, height: 15, borderRadius: '50%',
        background: '#fff', transition: 'left .2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.25)',
      }} />
    </button>
  )
}

// ── Pill badge ────────────────────────────────────────────────────────────────

function PerfilBadge({ perfil }: { perfil: string }) {
  const cfg = perfilCfg(perfil)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: cfg.bg, color: cfg.color,
    }}>
      <PerfilIcon perfil={perfil} />
      {cfg.label}
    </span>
  )
}

// ── Error banner ──────────────────────────────────────────────────────────────

function ErrMsg({ msg }: { msg: string }) {
  if (!msg) return null
  return (
    <div style={{
      padding: '9px 14px', borderRadius: 8, fontSize: 12,
      background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)',
      color: '#ef4444',
    }}>{msg}</div>
  )
}

// ── Icon action button ────────────────────────────────────────────────────────

function IcoBtn({ d, title, onClick, color, size = 14 }: {
  d: string; title: string; onClick: () => void; color?: string; size?: number
}) {
  return (
    <button title={title} onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 30, height: 30, borderRadius: 7,
      background: 'transparent', border: '1px solid var(--border)',
      color: color ?? 'var(--text2)', cursor: 'pointer',
      transition: 'all .15s',
    }}
      onMouseEnter={e => {
        ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--surface2)'
        ;(e.currentTarget as HTMLButtonElement).style.color = color ?? 'var(--text)'
      }}
      onMouseLeave={e => {
        ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        ;(e.currentTarget as HTMLButtonElement).style.color = color ?? 'var(--text2)'
      }}
    >
      <Ico d={d} size={size} />
    </button>
  )
}

// ── CheckCell — célula de permissão clicável ──────────────────────────────────

function CheckCell({ value, locked, onChange }: {
  value: boolean; locked?: boolean; onChange?: (v: boolean) => void
}) {
  if (locked) {
    return value ? (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={{ opacity: .45 }}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ) : (
      <span style={{ color: 'var(--border)', fontSize: 15 }}>—</span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onChange?.(!value)}
      title={value ? 'Clique para negar acesso' : 'Clique para conceder acesso'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 7, cursor: 'pointer',
        border: `1.5px solid ${value ? 'rgba(34,197,94,.4)' : 'var(--border)'}`,
        background: value ? 'rgba(34,197,94,.08)' : 'transparent',
        transition: 'all .15s',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget
        el.style.borderColor = value ? 'rgba(239,68,68,.5)' : 'rgba(34,197,94,.5)'
        el.style.background  = value ? 'rgba(239,68,68,.08)' : 'rgba(34,197,94,.08)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget
        el.style.borderColor = value ? 'rgba(34,197,94,.4)' : 'var(--border)'
        el.style.background  = value ? 'rgba(34,197,94,.08)' : 'transparent'
      }}
    >
      {value ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="var(--text3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      )}
    </button>
  )
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function Modal({ title, sub, onClose, children, width = 480 }: {
  title: string; sub?: string; onClose: () => void; children: React.ReactNode; width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 16, backdropFilter: 'blur(2px)',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} style={{
        background: 'var(--surface)', borderRadius: 14,
        border: '1px solid var(--border)', width: '100%', maxWidth: width,
        boxShadow: '0 24px 64px rgba(0,0,0,.35)',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          padding: '20px 24px 0',
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
            {sub && <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3 }}>{sub}</div>}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)',
            padding: 4, borderRadius: 6, display: 'flex', marginTop: -2,
          }}>
            <Ico d={ICO.x} size={16} />
          </button>
        </div>
        <div style={{ padding: '20px 24px 24px' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Usuarios() {
  const nav = useNavigate()
  const { can, isAdmin, op } = useAuth()

  useEffect(() => { if (!isAdmin) nav('/', { replace: true }) }, [isAdmin])

  const [users, setUsers]       = useState<Usuario[]>([])
  const [loading, setLoading]   = useState(true)
  const [modal, setModal]       = useState<ModalMode>(null)
  const [selected, setSelected] = useState<Usuario | null>(null)
  const [form, setForm]         = useState({ ...EMPTY_FORM })
  const [novaSenha, setNovaSenha]       = useState('')
  const [confirmSenha, setConfirmSenha] = useState('')
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState('')
  const [confirmDel, setConfirmDel] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarSaving, setAvatarSaving]   = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [showMatrix, setShowMatrix]   = useState(false)
  const [toastMsg, setToastMsg]       = useState('')
  const [permMap, setPermMap]         = useState<PermMap>(DEFAULT_PERM_MAP)
  const [permDirty, setPermDirty]     = useState(false)
  const [permSaving, setPermSaving]   = useState(false)
  const [permLoading, setPermLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try { const r = await api.get('/api/v1/usuarios'); setUsers(r.data) }
    finally { setLoading(false) }
  }

  const loadPerm = async () => {
    setPermLoading(true)
    try {
      const r = await api.get('/api/v1/config/permissoes')
      setPermMap(r.data as PermMap)
      setPermDirty(false)
    } finally { setPermLoading(false) }
  }

  useEffect(() => { if (isAdmin) { load(); loadPerm() } }, [isAdmin])

  const toast = (msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(''), 2800)
  }

  // ── Modal handlers ──────────────────────────────────────────────────────────

  const openCreate = () => {
    setForm({ ...EMPTY_FORM }); setErr(''); setModal('create')
  }

  const openEdit = (u: Usuario) => {
    setSelected(u)
    setForm({
      nome: u.nome, email: u.email, senha: '',
      perfil: u.perfil, ativo: u.ativo,
      whatsapp: u.whatsapp ?? '', telegram: u.telegram ?? '',
      cargo: u.cargo ?? '', departamento: u.departamento ?? '',
    })
    setAvatarPreview(u.avatar)
    setErr(''); setModal('edit')
  }

  const openReset = (u: Usuario) => {
    setSelected(u); setNovaSenha(''); setConfirmSenha(''); setErr(''); setModal('reset')
  }

  const closeModal = () => { setModal(null); setSelected(null); setErr(''); setAvatarPreview(null) }

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { toast('Avatar deve ter no máximo 2 MB'); return }
    const reader = new FileReader()
    reader.onload = ev => setAvatarPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  const uploadAvatar = async () => {
    if (!selected) return
    setAvatarSaving(true)
    try {
      await api.put(`/api/v1/usuarios/${selected.id}/avatar`, { avatar: avatarPreview })
      toast('Avatar atualizado')
      load()
    } catch (e) { toast(apiErr(e)) }
    finally { setAvatarSaving(false) }
  }

  const removeAvatar = async () => {
    if (!selected) return
    setAvatarSaving(true)
    try {
      await api.put(`/api/v1/usuarios/${selected.id}/avatar`, { avatar: null })
      setAvatarPreview(null)
      toast('Avatar removido')
      load()
    } catch (e) { toast(apiErr(e)) }
    finally { setAvatarSaving(false) }
  }

  const setF = (k: string, v: unknown) => setForm(p => ({ ...p, [k]: v }))

  // ── Save ────────────────────────────────────────────────────────────────────

  const save = async () => {
    setErr('')
    if (modal === 'create') {
      if (!form.nome.trim())                       { setErr('Nome é obrigatório'); return }
      if (!form.email.trim())                      { setErr('E-mail é obrigatório'); return }
      if (!form.senha || form.senha.length < 6)   { setErr('Senha deve ter ao menos 6 caracteres'); return }
    }
    setSaving(true)
    try {
      if (modal === 'create') {
        await api.post('/api/v1/usuarios', {
          nome: form.nome, email: form.email, senha: form.senha,
          perfil: form.perfil, ativo: form.ativo,
          whatsapp: form.whatsapp || null, telegram: form.telegram || null,
          cargo: form.cargo || null, departamento: form.departamento || null,
        })
        toast('Usuário criado com sucesso')
      } else if (modal === 'edit' && selected) {
        const body: Record<string, unknown> = {}
        if (form.nome        !== selected.nome)              body.nome        = form.nome
        if (form.email       !== selected.email)             body.email       = form.email
        if (form.perfil      !== selected.perfil)            body.perfil      = form.perfil
        if (form.ativo       !== selected.ativo)             body.ativo       = form.ativo
        if ((form.whatsapp   || null) !== selected.whatsapp)  body.whatsapp   = form.whatsapp || null
        if ((form.telegram   || null) !== selected.telegram)  body.telegram   = form.telegram || null
        if ((form.cargo      || null) !== selected.cargo)     body.cargo      = form.cargo || null
        if ((form.departamento || null) !== selected.departamento) body.departamento = form.departamento || null
        if (Object.keys(body).length) {
          await api.patch(`/api/v1/usuarios/${selected.id}`, body)
          toast('Usuário atualizado')
        }
      }
      closeModal(); load()
    } catch (e) {
      setErr(apiErr(e))
    } finally { setSaving(false) }
  }

  const resetSenha = async () => {
    if (!novaSenha || novaSenha.length < 6) { setErr('Mínimo 6 caracteres'); return }
    if (novaSenha !== confirmSenha)          { setErr('As senhas não coincidem'); return }
    setSaving(true); setErr('')
    try {
      await api.post(`/api/v1/usuarios/${selected!.id}/reset-senha`, { nova_senha: novaSenha })
      toast('Senha redefinida com sucesso')
      closeModal()
    } catch (e) { setErr(apiErr(e)) }
    finally { setSaving(false) }
  }

  const toggleAtivo = async (u: Usuario) => {
    try {
      await api.patch(`/api/v1/usuarios/${u.id}`, { ativo: !u.ativo })
      toast(u.ativo ? 'Usuário desativado' : 'Usuário ativado')
      load()
    } catch (e) { toast(apiErr(e)) }
  }

  const excluir = async (id: number) => {
    setDeleting(true)
    try {
      await api.delete(`/api/v1/usuarios/${id}`)
      setConfirmDel(null); toast('Usuário removido'); load()
    } catch (e) { toast(apiErr(e)) }
    finally { setDeleting(false) }
  }

  const togglePerm = (perfil: 'operador' | 'viewer', key: keyof PermMap['operador'], val: boolean) => {
    setPermMap(p => ({ ...p, [perfil]: { ...p[perfil], [key]: val } }))
    setPermDirty(true)
  }

  const savePerm = async () => {
    setPermSaving(true)
    try {
      await api.put('/api/v1/config/permissoes', permMap)
      savePermMap(permMap)
      setPermDirty(false)
      toast('Permissões salvas com sucesso')
    } catch (e) { toast(apiErr(e)) }
    finally { setPermSaving(false) }
  }

  if (!isAdmin) return null

  const activeCount   = users.filter(u => u.ativo).length
  const inactiveCount = users.filter(u => !u.ativo).length

  return (
    <div className="page">

      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      {toastMsg && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 2000,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '12px 18px', fontSize: 13, fontWeight: 500,
          boxShadow: '0 8px 32px rgba(0,0,0,.25)', color: 'var(--text)',
          display: 'flex', alignItems: 'center', gap: 8,
          animation: 'fadeIn .2s ease',
        }}>
          <span style={{ color: 'var(--success)' }}><Ico d={ICO.check} size={14} /></span>
          {toastMsg}
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <div className="page-title">Gestão de Usuários</div>
          <div className="page-subtitle">
            {activeCount} ativo{activeCount !== 1 ? 's' : ''}
            {inactiveCount > 0 && ` · ${inactiveCount} inativo${inactiveCount !== 1 ? 's' : ''}`}
          </div>
        </div>
        {can.usuarios.create && (
          <button className="btn btn-primary" onClick={openCreate}>
            <Ico d={ICO.plus} size={13} />
            Novo Usuário
          </button>
        )}
      </div>

      {/* ── Stat row ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        {PERFIS.map(p => {
          const count = users.filter(u => u.perfil === p.key).length
          return (
            <div key={p.key} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: '16px 18px',
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              <div style={{
                width: 38, height: 38, borderRadius: 9, flexShrink: 0,
                background: p.bg, color: p.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <PerfilIcon perfil={p.key} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  {p.label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: p.color, lineHeight: 1.1, marginTop: 1 }}>
                  {count}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── User list ──────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : users.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '48px 0' }}>
            <div className="empty-state-icon" style={{ fontSize: 32 }}>👤</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Nenhum usuário cadastrado</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>Crie o primeiro usuário para começar</div>
          </div>
        </div>
      ) : (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, overflow: 'hidden',
        }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1.4fr 1fr 1fr 1fr 120px',
            padding: '10px 20px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface2)',
          }}>
            {['Usuário', 'E-mail', 'Perfil', 'Status', 'Último acesso', ''].map((h, i) => (
              <div key={i} style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
                textTransform: 'uppercase', color: 'var(--text2)',
                textAlign: i === 5 ? 'right' : 'left',
              }}>{h}</div>
            ))}
          </div>

          {/* Rows */}
          {users.map((u, idx) => {
            const cfg    = perfilCfg(u.perfil)
            const isSelf = u.email === op?.email

            return (
              <div key={u.id} style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1.4fr 1fr 1fr 1fr 120px',
                padding: '14px 20px', alignItems: 'center',
                borderBottom: idx < users.length - 1 ? '1px solid var(--border)' : 'none',
                transition: 'background .12s',
                opacity: u.ativo ? 1 : 0.55,
              }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--surface2)'}
                onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
              >
                {/* Avatar + nome */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                    background: cfg.bg, color: cfg.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, letterSpacing: '.02em',
                    overflow: 'hidden',
                  }}>
                    {u.avatar
                      ? <img src={u.avatar} alt={u.nome} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : initials(u.nome)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {u.nome}
                      </span>
                      {isSelf && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 6px',
                          borderRadius: 4, background: 'rgba(99,102,241,.12)', color: 'var(--primary)',
                          textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0,
                        }}>você</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 1 }}>
                      {u.cargo ?? u.departamento ?? '\u00a0'}
                    </div>
                  </div>
                </div>

                {/* Email */}
                <div style={{ fontSize: 12, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>
                  {u.email}
                </div>

                {/* Perfil */}
                <div><PerfilBadge perfil={u.perfil} /></div>

                {/* Status + toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {can.usuarios.edit && !isSelf ? (
                    <Toggle value={u.ativo} onChange={() => toggleAtivo(u)} />
                  ) : (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      fontSize: 11, fontWeight: 600,
                      color: u.ativo ? 'var(--success)' : 'var(--text2)',
                    }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: u.ativo ? 'var(--success)' : 'var(--text2)',
                      }} />
                      {u.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                  )}
                </div>

                {/* Último acesso */}
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {u.ultimo_login
                    ? format(new Date(u.ultimo_login), "dd/MM/yy HH:mm", { locale: ptBR })
                    : <span style={{ color: 'var(--text3)' }}>Nunca</span>}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' }}>
                  {can.usuarios.edit && (
                    <IcoBtn d={ICO.edit} title="Editar" onClick={() => openEdit(u)} />
                  )}
                  {can.usuarios.resetSenha && (
                    <IcoBtn d={ICO.key} title="Redefinir senha" onClick={() => openReset(u)} />
                  )}
                  {can.usuarios.delete && !isSelf && (
                    confirmDel === u.id ? (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button className="btn btn-danger btn-sm" disabled={deleting}
                          style={{ padding: '3px 10px', fontSize: 11 }}
                          onClick={() => excluir(u.id)}>
                          {deleting ? <span className="spinner" style={{ width: 10, height: 10 }} /> : 'Confirmar'}
                        </button>
                        <button className="btn btn-ghost btn-sm"
                          style={{ padding: '3px 10px', fontSize: 11 }}
                          onClick={() => setConfirmDel(null)}>Cancelar</button>
                      </div>
                    ) : (
                      <IcoBtn d={ICO.trash} title="Excluir" color="#ef4444" onClick={() => setConfirmDel(u.id)} />
                    )
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Permission matrix (editable) ────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, overflow: 'hidden', marginTop: 16,
      }}>
        {/* Header colapsável */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px',
          borderBottom: showMatrix ? '1px solid var(--border)' : 'none',
        }}>
          <button
            onClick={() => setShowMatrix(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text)', fontWeight: 600, fontSize: 13, padding: 0,
            }}>
            <Ico d={ICO.matrix} size={14} style={{ color: 'var(--text2)' }} />
            Matriz de Permissões
            <Ico d={ICO.chevron} size={13} style={{
              color: 'var(--text2)',
              transform: showMatrix ? 'rotate(180deg)' : 'rotate(0)',
              transition: 'transform .2s',
            }} />
          </button>

          {showMatrix && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {permDirty && (
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>Alterações não salvas</span>
              )}
              {permDirty && (
                <button className="btn btn-ghost btn-sm" onClick={() => { loadPerm() }}>
                  Descartar
                </button>
              )}
              <button
                className={`btn btn-sm ${permDirty ? 'btn-primary' : 'btn-ghost'}`}
                onClick={savePerm}
                disabled={permSaving || !permDirty}
              >
                {permSaving
                  ? <span className="spinner" style={{ width: 11, height: 11 }} />
                  : 'Salvar permissões'}
              </button>
            </div>
          )}
        </div>

        {showMatrix && (
          permLoading ? (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <span className="spinner" />
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--surface2)' }}>
                    <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text2)', minWidth: 200 }}>
                      Módulo
                    </th>
                    {PERFIS.map(p => (
                      <th key={p.key} style={{ padding: '10px 24px', textAlign: 'center', width: 140 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: p.color }}>
                          {p.label}
                        </div>
                        {p.key === 'admin' && (
                          <div style={{ fontSize: 9, color: 'var(--text2)', fontWeight: 400, marginTop: 2 }}>acesso total fixo</div>
                        )}
                      </th>
                    ))}
                    <th style={{ padding: '10px 20px', width: 200, textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text2)' }}>
                      Descrição
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {MATRIX_ROWS.map((row, i) => {
                    const isFixed = row.key === null
                    const opVal   = isFixed ? true : permMap.operador[row.key!]
                    const vwVal   = isFixed ? true : (row.lockVw ? false : permMap.viewer[row.key!])

                    return (
                      <>
                        {/* Group header row */}
                        {row.group && (
                          <tr key={`g-${i}`} style={{ background: 'var(--surface2)' }}>
                            <td colSpan={5} style={{
                              padding: '6px 20px 5px',
                              borderTop: i > 0 ? '2px solid var(--border)' : '1px solid var(--border)',
                              fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                              textTransform: 'uppercase', color: 'var(--text2)', opacity: .7,
                            }}>
                              {row.group}
                            </td>
                          </tr>
                        )}

                        <tr key={i} style={{
                          borderTop: row.group ? 'none' : '1px solid var(--border)',
                          background: isFixed ? 'rgba(0,0,0,.012)' : 'transparent',
                        }}>
                          {/* Módulo + rota */}
                          <td style={{ padding: '10px 20px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 12, fontWeight: 500 }}>{row.modulo}</span>
                              <span style={{
                                fontSize: 9, fontWeight: 600, color: 'var(--text3)',
                                background: 'var(--surface2)', border: '1px solid var(--border)',
                                borderRadius: 4, padding: '1px 5px', fontFamily: 'monospace',
                                letterSpacing: '.02em', flexShrink: 0,
                              }}>{row.rota}</span>
                            </div>
                            {isFixed && (
                              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>somente leitura — todos os perfis</div>
                            )}
                          </td>

                          {/* Admin — sempre marcado, bloqueado */}
                          <td style={{ textAlign: 'center', padding: '10px 24px' }}>
                            <CheckCell value={true} locked />
                          </td>

                          {/* Operador */}
                          <td style={{ textAlign: 'center', padding: '10px 24px' }}>
                            <CheckCell
                              value={opVal}
                              locked={isFixed}
                              onChange={v => row.key && togglePerm('operador', row.key, v)}
                            />
                          </td>

                          {/* Viewer */}
                          <td style={{ textAlign: 'center', padding: '10px 24px' }}>
                            <CheckCell
                              value={vwVal}
                              locked={isFixed || !!row.lockVw}
                              onChange={v => row.key && togglePerm('viewer', row.key, v)}
                            />
                          </td>

                          <td style={{ padding: '10px 20px', fontSize: 11, color: 'var(--text2)', lineHeight: 1.5 }}>
                            {row.desc}
                          </td>
                        </tr>
                      </>
                    )
                  })}
                </tbody>
              </table>

              {/* Legend */}
              <div style={{
                padding: '12px 20px', borderTop: '1px solid var(--border)',
                display: 'flex', gap: 20, alignItems: 'center',
                background: 'var(--surface2)',
              }}>
                <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCell value={true} locked /> Acesso concedido (fixo)
                </div>
                <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCell value={true} onChange={() => {}} /> Acesso concedido (editável)
                </div>
                <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCell value={false} onChange={() => {}} /> Acesso negado (editável)
                </div>
              </div>
            </div>
          )
        )}
      </div>

      {/* ── Modal: Criar / Editar ───────────────────────────────────────────── */}
      {(modal === 'create' || modal === 'edit') && (
        <Modal
          title={modal === 'create' ? 'Novo Usuário' : 'Editar Usuário'}
          sub={modal === 'edit' ? selected?.email : undefined}
          onClose={closeModal}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Avatar (edit only) */}
            {modal === 'edit' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{
                  width: 64, height: 64, borderRadius: 14, flexShrink: 0,
                  background: avatarPreview ? 'transparent' : perfilCfg(selected?.perfil ?? 'viewer').bg,
                  color: perfilCfg(selected?.perfil ?? 'viewer').color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, fontWeight: 700, overflow: 'hidden',
                  border: '2px solid var(--border)',
                }}>
                  {avatarPreview
                    ? <img src={avatarPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : initials(selected?.nome ?? '')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    Foto de perfil
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={handleAvatarFile}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => avatarInputRef.current?.click()}
                      style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}
                    >
                      <Ico d={ICO.upload} size={12} />
                      {avatarPreview ? 'Trocar foto' : 'Enviar foto'}
                    </button>
                    {avatarPreview && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={removeAvatar}
                        disabled={avatarSaving}
                        style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 5 }}
                      >
                        <Ico d={ICO.trash2} size={12} />
                        Remover
                      </button>
                    )}
                    {avatarPreview !== selected?.avatar && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={uploadAvatar}
                        disabled={avatarSaving}
                        style={{ fontSize: 11 }}
                      >
                        {avatarSaving
                          ? <span className="spinner" style={{ width: 10, height: 10 }} />
                          : 'Salvar foto'}
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>JPG, PNG ou GIF — máx. 2 MB</div>
                </div>
              </div>
            )}

            {/* Nome + Email */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Nome completo</label>
                <input style={inp} placeholder="Ex: Maria Silva" autoFocus
                  value={form.nome} onChange={e => setF('nome', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>E-mail</label>
                <input style={inp} type="email" placeholder="maria@empresa.com"
                  value={form.email} onChange={e => setF('email', e.target.value)} />
              </div>
            </div>

            {/* Cargo + Depto */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Cargo</label>
                <input style={inp} placeholder="Ex: Analista de Segurança"
                  value={form.cargo} onChange={e => setF('cargo', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Departamento</label>
                <input style={inp} placeholder="Ex: Segurança Patrimonial"
                  value={form.departamento} onChange={e => setF('departamento', e.target.value)} />
              </div>
            </div>

            {/* WhatsApp + Telegram */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>WhatsApp</label>
                <input style={inp} placeholder="+55 65 99999-9999"
                  value={form.whatsapp} onChange={e => setF('whatsapp', e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Telegram</label>
                <input style={inp} placeholder="@usuario"
                  value={form.telegram} onChange={e => setF('telegram', e.target.value)} />
              </div>
            </div>

            {/* Senha (só no create) */}
            {modal === 'create' && (
              <div>
                <label style={lbl}>Senha inicial</label>
                <input style={inp} type="password" placeholder="Mínimo 6 caracteres"
                  value={form.senha} onChange={e => setF('senha', e.target.value)} />
              </div>
            )}

            {/* Perfil */}
            <div>
              <label style={lbl}>Perfil de acesso</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {PERFIS.map(p => {
                  const active = form.perfil === p.key
                  return (
                    <button key={p.key} type="button" onClick={() => setF('perfil', p.key)}
                      style={{
                        padding: '10px 8px', borderRadius: 9, cursor: 'pointer',
                        border: `1.5px solid ${active ? p.color : 'var(--border)'}`,
                        background: active ? p.bg : 'transparent',
                        transition: 'all .15s', textAlign: 'center',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, marginBottom: 3, color: active ? p.color : 'var(--text2)' }}>
                        <PerfilIcon perfil={p.key} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: active ? p.color : 'var(--text)' }}>
                        {p.label}
                      </div>
                    </button>
                  )
                })}
              </div>
              <div style={{
                marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12,
                color: 'var(--text2)', lineHeight: 1.6,
                background: perfilCfg(form.perfil).bg,
                border: `1px solid ${perfilCfg(form.perfil).color}25`,
              }}>
                {perfilCfg(form.perfil).desc}
              </div>
            </div>

            {/* Status toggle (só no edit) */}
            {modal === 'edit' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                <Toggle value={form.ativo} onChange={v => setF('ativo', v)} />
                <span style={{ fontSize: 13, color: form.ativo ? 'var(--text)' : 'var(--text2)' }}>
                  Conta {form.ativo ? 'ativa' : 'inativa'}
                </span>
              </div>
            )}

            <ErrMsg msg={err} />

            <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={closeModal}>Cancelar</button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={saving}>
                {saving
                  ? <span className="spinner" style={{ width: 13, height: 13 }} />
                  : modal === 'create' ? 'Criar Usuário' : 'Salvar Alterações'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Modal: Reset senha ──────────────────────────────────────────────── */}
      {modal === 'reset' && selected && (
        <Modal title="Redefinir Senha" sub={selected.nome} onClose={closeModal} width={400}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={lbl}>Nova senha</label>
              <input style={inp} type="password" placeholder="Mínimo 6 caracteres" autoFocus
                value={novaSenha} onChange={e => setNovaSenha(e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Confirmar senha</label>
              <input style={inp} type="password" placeholder="Repita a nova senha"
                value={confirmSenha} onChange={e => setConfirmSenha(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') resetSenha() }} />
              {novaSenha && confirmSenha && novaSenha !== confirmSenha && (
                <div style={{ fontSize: 11, color: '#ef4444', marginTop: 5 }}>As senhas não coincidem</div>
              )}
            </div>
            <div style={{
              padding: '9px 13px', borderRadius: 8, fontSize: 11, lineHeight: 1.6,
              background: 'rgba(234,179,8,.07)', border: '1px solid rgba(234,179,8,.2)',
              color: 'var(--text2)',
            }}>
              O usuário precisará usar esta senha no próximo login.
            </div>
            <ErrMsg msg={err} />
            <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={closeModal}>Cancelar</button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={resetSenha} disabled={saving}>
                {saving
                  ? <span className="spinner" style={{ width: 13, height: 13 }} />
                  : 'Redefinir Senha'}
              </button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  )
}
