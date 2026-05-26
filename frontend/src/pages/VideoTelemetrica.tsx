import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import api from '../api'
import { useModuleAlerts } from '../hooks/useModuleAlerts'
import ModuleAlertBanner from '../components/ModuleAlertBanner'
import { format, differenceInMinutes } from 'date-fns'
import { ptBR } from 'date-fns/locale'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

// ── Types ─────────────────────────────────────────────────────────────────────

interface CameraItem { id: number; nome: string }
interface Motorista {
  id: number; nome: string; cpf: string | null; cnh: string | null
  categoria: string; telefone: string | null; ativo: boolean
  veiculo_placa: string | null; veiculo_modelo: string | null
}
interface Veiculo {
  id: number; placa: string; modelo: string | null; marca: string | null
  ano: number | null; tipo: string; camera_id: number | null
  motorista_id: number | null; motorista_nome: string | null
  camera_nome: string | null; telemetria_ativa: boolean | null
}
interface EventoTel {
  id: number
  camera_id: number; camera_nome: string | null
  veiculo_id: number | null; veiculo_placa: string | null
  motorista_id: number | null; motorista_nome: string | null
  tipo_evento: 'fadiga' | 'celular' | 'bocejo' | 'distracao'
  severidade: 'baixo' | 'medio' | 'alto' | 'critico'
  confianca: number; ear_score: number | null; mar_score: number | null
  duracao_ms: number | null; snapshot_url: string | null
  detectado_em: string; tempo_processo_ms: number | null
}
interface Stats {
  totais: { total_fadiga: number; total_celular: number; total_bocejo: number; total_distracao: number; total_geral: number }
  por_motorista: Array<{ motorista: string; total: number; fadiga: number; celular: number }>
  por_tipo: Array<{ tipo_evento: string; severidade: string; total: number }>
}
interface WorkerStatus {
  cam_id: number; cam_nome: string; veiculo_placa: string | null
  motorista: string | null; stream_ok: boolean; alive: boolean
  errors: number; last_event: Record<string, unknown> | null
}
interface CameraConfig {
  camera_id: number; camera_nome: string; ativo: boolean
  cooldown_seg: number; webhook_token: string | null
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const T = {
  fadiga   : '#ef4444',
  celular  : '#f59e0b',
  bocejo   : '#8b5cf6',
  distracao: '#06b6d4',
  ok       : '#10b981',
  accent   : '#f59e0b',
}

const TIPO: Record<string, { label: string; color: string; abbr: string }> = {
  fadiga   : { label: 'Fadiga',    color: T.fadiga,    abbr: 'FAD' },
  celular  : { label: 'Celular',   color: T.celular,   abbr: 'CEL' },
  bocejo   : { label: 'Bocejo',    color: T.bocejo,    abbr: 'BOC' },
  distracao: { label: 'Distração', color: T.distracao, abbr: 'DIS' },
}

const SEV: Record<string, { label: string; color: string }> = {
  baixo  : { label: 'Baixo',    color: '#64748b' },
  medio  : { label: 'Médio',    color: '#f59e0b' },
  alto   : { label: 'Alto',     color: '#ef4444' },
  critico: { label: 'Crítico',  color: '#dc2626' },
}

// CSS var shorthands
const s1  = 'var(--surface1)'
const s2  = 'var(--surface2)'
const bdr = 'var(--border)'
const tx  = 'var(--text)'
const mu  = 'var(--muted)'

// ── Utils ─────────────────────────────────────────────────────────────────────

const ft = (s: string, f = 'HH:mm:ss') => {
  try { return format(new Date(s), f, { locale: ptBR }) } catch { return s }
}
function ago(s: string) {
  try {
    const m = differenceInMinutes(new Date(), new Date(s))
    if (m < 1) return 'agora'
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    return h < 24 ? `${h}h` : ft(s, 'dd/MM')
  } catch { return '' }
}
function initials(n: string) {
  return n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}
function safetyScore(events: EventoTel[], id: number) {
  const w: Record<string, number> = { baixo: 1, medio: 2, alto: 4, critico: 8 }
  const pen = events.filter(e => e.motorista_id === id).reduce((a, e) => a + (w[e.severidade] || 1), 0)
  return Math.max(0, 100 - pen)
}

// ── Primitives ────────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: s2, border: `1px solid ${bdr}`, borderRadius: 4,
  padding: '8px 10px', fontSize: 12, color: tx, outline: 'none', fontFamily: 'inherit',
}

function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  const hue = Math.abs(name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `hsl(${hue},45%,28%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.34, fontWeight: 700, color: `hsl(${hue},70%,75%)`,
      userSelect: 'none',
    }}>{initials(name)}</div>
  )
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 9, fontWeight: 700, letterSpacing: .7,
      color, background: `${color}14`,
      padding: '2px 6px', borderRadius: 3,
      border: `1px solid ${color}28`,
    }}>{children}</span>
  )
}

function SevDot({ sev }: { sev: string }) {
  const s = SEV[sev] || SEV.baixo
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        background: s.color,
        boxShadow: sev === 'critico' ? `0 0 6px ${s.color}` : 'none',
      }} />
      <span style={{ fontSize: 11, color: s.color, fontWeight: 600 }}>{s.label}</span>
    </span>
  )
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 80 ? T.ok : score >= 55 ? T.celular : T.fadiga
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 3, background: s2, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{score}</span>
    </div>
  )
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function Modal({ title, sub, accent = T.accent, onClose, width = 500, children }: {
  title: string; sub?: string; accent?: string
  onClose: () => void; width?: number; children: React.ReactNode
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: s1, borderRadius: 4, border: `1px solid ${bdr}`,
        width: '100%', maxWidth: width, overflow: 'hidden',
        boxShadow: '0 24px 64px rgba(0,0,0,.4)',
        borderTop: `2px solid ${accent}`,
      }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${bdr}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: tx }}>{title}</div>
            {sub && <div style={{ fontSize: 11, color: mu, marginTop: 2 }}>{sub}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: mu, fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '18px 18px 16px' }}>{children}</div>
      </div>
    </div>
  )
}

function FRow({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
      <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: mu, marginBottom: 5, letterSpacing: .4 }}>{label}</label>
      {children}
    </div>
  )
}

const BtnPrimary = ({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: T.accent, border: 'none', borderRadius: 4, color: '#000',
    padding: '8px 18px', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 12, fontWeight: 700, opacity: disabled ? .5 : 1,
  }}>{children}</button>
)
const BtnOutline = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} style={{
    background: 'none', border: `1px solid ${bdr}`, borderRadius: 4, color: mu,
    padding: '8px 14px', cursor: 'pointer', fontSize: 12,
  }}>{children}</button>
)

// ── Form modals ───────────────────────────────────────────────────────────────

function MotoristaModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ nome: '', cpf: '', cnh: '', categoria: 'B', telefone: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }))
  const submit = async () => {
    if (!f.nome.trim()) { setErr('Nome obrigatório'); return }
    setSaving(true); setErr('')
    try {
      await api.post('/api/v1/telemetria/motoristas', { nome: f.nome.trim(), cpf: f.cpf || null, cnh: f.cnh || null, categoria: f.categoria, telefone: f.telefone || null })
      onSaved(); onClose()
    } catch (e: any) { setErr(e?.response?.data?.detail || 'Erro ao salvar') }
    finally { setSaving(false) }
  }
  return (
    <Modal title="Novo Motorista" sub="Cadastrar motorista na frota" accent={T.distracao} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FRow label="Nome completo *" span={2}>
          <input style={inp} value={f.nome} onChange={e => set('nome', e.target.value)} placeholder="João da Silva" autoFocus />
        </FRow>
        <FRow label="CPF">
          <input style={inp} value={f.cpf} onChange={e => set('cpf', e.target.value)} placeholder="000.000.000-00" />
        </FRow>
        <FRow label="Telefone">
          <input style={inp} value={f.telefone} onChange={e => set('telefone', e.target.value)} placeholder="(65) 99999-0000" />
        </FRow>
        <FRow label="CNH">
          <input style={inp} value={f.cnh} onChange={e => set('cnh', e.target.value)} placeholder="Nº da habilitação" />
        </FRow>
        <FRow label="Categoria">
          <select style={inp} value={f.categoria} onChange={e => set('categoria', e.target.value)}>
            {['A','B','C','D','E','AB','AC','AD','AE'].map(c => <option key={c} value={c}>Categoria {c}</option>)}
          </select>
        </FRow>
      </div>
      {err && <p style={{ fontSize: 11, color: T.fadiga, margin: '10px 0 0' }}>{err}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <BtnOutline onClick={onClose}>Cancelar</BtnOutline>
        <BtnPrimary onClick={submit} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</BtnPrimary>
      </div>
    </Modal>
  )
}

function VeiculoModal({ onClose, onSaved, cameras, motoristas }: { onClose: () => void; onSaved: () => void; cameras: CameraItem[]; motoristas: Motorista[] }) {
  const [f, setF] = useState({ placa: '', modelo: '', marca: '', ano: '', tipo: 'truck', camera_id: '', motorista_id: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }))
  const submit = async () => {
    if (!f.placa.trim()) { setErr('Placa obrigatória'); return }
    setSaving(true); setErr('')
    try {
      await api.post('/api/v1/telemetria/veiculos', {
        placa: f.placa.trim().toUpperCase(), modelo: f.modelo || null, marca: f.marca || null,
        ano: f.ano ? parseInt(f.ano) : null, tipo: f.tipo,
        camera_id: f.camera_id ? parseInt(f.camera_id) : null,
        motorista_id: f.motorista_id ? parseInt(f.motorista_id) : null,
      })
      onSaved(); onClose()
    } catch (e: any) { setErr(e?.response?.data?.detail || 'Erro ao salvar') }
    finally { setSaving(false) }
  }
  return (
    <Modal title="Novo Veículo" sub="Vincular câmera e motorista" accent={T.bocejo} onClose={onClose} width={520}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FRow label="Placa *">
          <input style={{ ...inp, fontFamily: 'monospace', fontWeight: 700, letterSpacing: 1 }}
            value={f.placa} onChange={e => set('placa', e.target.value.toUpperCase())} placeholder="ABC1D23" maxLength={8} autoFocus />
        </FRow>
        <FRow label="Tipo">
          <select style={inp} value={f.tipo} onChange={e => set('tipo', e.target.value)}>
            <option value="truck">Caminhão</option><option value="van">Van</option>
            <option value="bus">Ônibus</option><option value="car">Carro</option><option value="moto">Moto</option>
          </select>
        </FRow>
        <FRow label="Marca"><input style={inp} value={f.marca} onChange={e => set('marca', e.target.value)} placeholder="Volvo, Mercedes…" /></FRow>
        <FRow label="Modelo"><input style={inp} value={f.modelo} onChange={e => set('modelo', e.target.value)} placeholder="FH 460, Axor…" /></FRow>
        <FRow label="Ano"><input style={inp} value={f.ano} onChange={e => set('ano', e.target.value)} placeholder="2024" maxLength={4} /></FRow>
        <div />
        <FRow label="Câmera de bordo" span={2}>
          <select style={inp} value={f.camera_id} onChange={e => set('camera_id', e.target.value)}>
            <option value="">— sem câmera —</option>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </FRow>
        <FRow label="Motorista" span={2}>
          <select style={inp} value={f.motorista_id} onChange={e => set('motorista_id', e.target.value)}>
            <option value="">— sem motorista —</option>
            {motoristas.map(m => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
        </FRow>
      </div>
      {err && <p style={{ fontSize: 11, color: T.fadiga, margin: '10px 0 0' }}>{err}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <BtnOutline onClick={onClose}>Cancelar</BtnOutline>
        <BtnPrimary onClick={submit} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</BtnPrimary>
      </div>
    </Modal>
  )
}

// ── Event detail modal ────────────────────────────────────────────────────────

function EventoModal({ ev, onClose }: { ev: EventoTel; onClose: () => void }) {
  const meta = TIPO[ev.tipo_evento] || TIPO.fadiga
  const [imgErr, setImgErr] = useState(false)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const rows = [
    { l: 'Câmera',      v: ev.camera_nome || `#${ev.camera_id}` },
    { l: 'Veículo',     v: ev.veiculo_placa || '—', mono: true },
    { l: 'Motorista',   v: ev.motorista_nome || '—' },
    { l: 'Severidade',  v: SEV[ev.severidade]?.label || ev.severidade, color: SEV[ev.severidade]?.color },
    { l: 'Confiança',   v: `${(ev.confianca * 100).toFixed(1)}%`, color: meta.color },
    ...(ev.ear_score != null  ? [{ l: 'EAR', v: ev.ear_score.toFixed(4), mono: true }] : []),
    ...(ev.mar_score != null  ? [{ l: 'MAR', v: ev.mar_score.toFixed(4), mono: true }] : []),
    ...(ev.duracao_ms != null ? [{ l: 'Duração', v: ev.duracao_ms < 1000 ? `${ev.duracao_ms}ms` : `${(ev.duracao_ms/1000).toFixed(1)}s` }] : []),
    { l: 'Detectado',   v: ft(ev.detectado_em, "dd/MM/yyyy 'às' HH:mm:ss") },
  ]

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: s1, borderRadius: 4, border: `1px solid ${bdr}`,
        width: '100%', maxWidth: 820, overflow: 'hidden',
        boxShadow: '0 32px 80px rgba(0,0,0,.5)',
        borderTop: `2px solid ${meta.color}`,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* header */}
        <div style={{ padding: '12px 18px', borderBottom: `1px solid ${bdr}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 3, height: 20, borderRadius: 2, background: meta.color, flexShrink: 0 }} />
          <span style={{ fontWeight: 800, fontSize: 13, color: meta.color, letterSpacing: .5 }}>{meta.label.toUpperCase()}</span>
          <SevDot sev={ev.severidade} />
          <span style={{ fontSize: 11, color: mu, marginLeft: 4 }}>{ft(ev.detectado_em, "dd/MM 'às' HH:mm:ss")}</span>
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: mu, marginLeft: 'auto' }}>#{String(ev.id).padStart(6, '0')}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: mu, fontSize: 16, marginLeft: 8 }}>✕</button>
        </div>

        <div style={{ display: 'flex', minHeight: 300 }}>
          {/* snapshot */}
          <div style={{ width: 380, background: '#030303', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: `1px solid ${bdr}` }}>
            {ev.snapshot_url && !imgErr
              ? <img src={`${API_BASE}${ev.snapshot_url}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} onError={() => setImgErr(true)} />
              : <div style={{ textAlign: 'center', opacity: .25 }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>📷</div>
                  <div style={{ fontSize: 11 }}>Sem snapshot</div>
                </div>
            }
          </div>

          {/* fields */}
          <div style={{ flex: 1, padding: '16px 18px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.4, color: mu, marginBottom: 12 }}>DETALHES DO EVENTO</div>
            {rows.map((r: any, i) => (
              <div key={r.l} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 0', borderBottom: i < rows.length - 1 ? `1px solid ${bdr}` : 'none',
              }}>
                <span style={{ fontSize: 12, color: mu }}>{r.l}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: r.color || tx, fontFamily: r.mono ? 'monospace' : undefined, fontVariantNumeric: 'tabular-nums' }}>{r.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Webhook panel ─────────────────────────────────────────────────────────────

function WebhookPanel({ config }: { config: CameraConfig }) {
  const [token, setToken] = useState(config.webhook_token || '')
  const [show, setShow]   = useState(false)
  const [regen, setRegen] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/api/v1/telemetria/camera/alert/${config.camera_id}?token=${token || 'TOKEN'}`
  const genToken = async () => {
    setRegen(true)
    try { const r = await api.post(`/api/v1/telemetria/camera/token/${config.camera_id}`); setToken(r.data.webhook_token) } catch {}
    setRegen(false)
  }
  const copy = () => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) }

  return (
    <div style={{ border: `1px solid ${bdr}`, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
      <div style={{ background: s2, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: config.ativo ? T.ok : '#ef4444', flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 12, flex: 1 }}>{config.camera_nome}</span>
        <Pill color={config.ativo ? T.ok : '#64748b'}>{config.ativo ? 'ATIVA' : 'INATIVA'}</Pill>
      </div>
      <div style={{ padding: '12px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, color: mu, marginBottom: 6 }}>WEBHOOK URL</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: s2, border: `1px solid ${bdr}`, borderRadius: 4, padding: '6px 10px', marginBottom: 10 }}>
          <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', color: tx }}>{url}</span>
          <button onClick={copy} style={{ background: 'none', border: `1px solid ${copied ? T.ok : bdr}`, color: copied ? T.ok : mu, borderRadius: 3, padding: '3px 8px', cursor: 'pointer', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', transition: 'all .15s' }}>{copied ? '✓' : 'Copiar'}</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, background: s2, border: `1px solid ${bdr}`, borderRadius: 4, padding: '5px 10px', fontFamily: 'monospace', fontSize: 11, color: mu, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {token ? (show ? token : `${token.slice(0, 8)}${'•'.repeat(14)}`) : '— sem token gerado —'}
          </div>
          {token && <button onClick={() => setShow(s => !s)} style={{ background: s2, border: `1px solid ${bdr}`, borderRadius: 3, color: mu, padding: '4px 8px', cursor: 'pointer', fontSize: 10 }}>{show ? 'Ocultar' : 'Mostrar'}</button>}
          <button onClick={genToken} disabled={regen} style={{ background: T.accent, border: 'none', borderRadius: 3, color: '#000', padding: '4px 10px', cursor: 'pointer', fontSize: 10, fontWeight: 700, opacity: regen ? .6 : 1 }}>
            {token ? 'Regenerar' : 'Gerar Token'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Hourly bar chart ──────────────────────────────────────────────────────────

function HourlyChart({ eventos }: { eventos: EventoTel[] }) {
  const HOURS = 12, now = new Date()
  const buckets = useMemo(() => {
    const b: Record<number, Record<string, number>> = {}
    for (let i = 0; i < HOURS; i++) b[i] = { fadiga: 0, celular: 0, bocejo: 0, distracao: 0 }
    eventos.forEach(ev => {
      const idx = Math.floor(differenceInMinutes(now, new Date(ev.detectado_em)) / 60)
      if (idx >= 0 && idx < HOURS) { const sl = b[HOURS - 1 - idx]; if (sl && ev.tipo_evento in sl) sl[ev.tipo_evento]++ }
    })
    return b
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventos])
  const maxV = Math.max(1, ...Object.values(buckets).map(b => Object.values(b).reduce((a, c) => a + c, 0)))
  const BW = 100 / HOURS - .6
  const TIPOS = ['distracao', 'bocejo', 'celular', 'fadiga'] as const
  const labels = Array.from({ length: HOURS }, (_, i) => {
    const d = new Date(now); d.setHours(d.getHours() - (HOURS - 1 - i), 0, 0, 0); return d.getHours().toString().padStart(2, '0')
  })
  return (
    <div>
      <svg viewBox="0 0 100 52" style={{ width: '100%', height: 52, display: 'block' }}>
        {[.33, .66, 1].map(f => <line key={f} x1={0} y1={52 - 50 * f} x2={100} y2={52 - 50 * f} stroke={bdr} strokeWidth={.3} strokeDasharray="2,2" />)}
        {Object.entries(buckets).map(([iStr, counts]) => {
          const i = Number(iStr), x = i * (100 / HOURS) + .3
          let yOff = 0
          return <g key={i}>{TIPOS.map(t => {
            const v = counts[t] || 0; if (!v) return null
            const bH = (v / maxV) * 48, y = 52 - bH - yOff; yOff += bH
            return <rect key={t} x={x} y={y} width={BW} height={bH} fill={TIPO[t].color} opacity={.75} rx={.5}><title>{TIPO[t].label}: {v} às {labels[i]}h</title></rect>
          })}</g>
        })}
      </svg>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${HOURS},1fr)`, marginTop: 3 }}>
        {labels.map((l, i) => <div key={i} style={{ fontSize: 8, color: mu, textAlign: 'center', fontVariantNumeric: 'tabular-nums', opacity: i % 3 === 0 ? .8 : .25 }}>{l}</div>)}
      </div>
    </div>
  )
}

// ── Section label ─────────────────────────────────────────────────────────────

const SLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: mu, textTransform: 'uppercase', marginBottom: 10 }}>{children}</div>
)

// ── Main ──────────────────────────────────────────────────────────────────────

type Tab = 'monitor' | 'frota' | 'motoristas' | 'sistema'

export default function VideoTelemetrica() {
  const [tab, setTab]               = useState<Tab>('monitor')
  const [eventos, setEventos]       = useState<EventoTel[]>([])
  const [stats, setStats]           = useState<Stats | null>(null)
  const [workers, setWorkers]       = useState<WorkerStatus[]>([])
  const [veiculos, setVeiculos]     = useState<Veiculo[]>([])
  const [motoristas, setMotoristas] = useState<Motorista[]>([])
  const [cameras, setCameras]       = useState<CameraItem[]>([])
  const [configs, setConfigs]       = useState<CameraConfig[]>([])
  const [selected, setSelected]     = useState<EventoTel | null>(null)
  const [tipoFilter, setTipoFilter] = useState('')
  const [loading, setLoading]       = useState(false)
  const [tick, setTick]             = useState(new Date())
  const [showVeiculo, setShowVeiculo] = useState(false)
  const [showMot, setShowMot]         = useState(false)
  const [newIds, setNewIds]           = useState<Set<number>>(new Set())
  const pollerRef = useRef<number | null>(null)

  const { alert, prefs, toggleSound, toggleVisual, dismiss } = useModuleAlerts({
    moduleKey: 'telemetria', eventTypes: ['telemetria_alerta'],
    buildMessage: ev => {
      const m = TIPO[ev.tipo_evento as string] || { label: ev.tipo_evento }
      return `${m.label}${ev.veiculo_placa ? ` — ${ev.veiculo_placa}` : ''}${ev.motorista_nome ? ` (${ev.motorista_nome})` : ''}`
    },
    sirenDuration: 4,
  })

  const loadEventos = useCallback(async () => {
    try {
      const params: Record<string, string> = { limit: '100' }
      if (tipoFilter) params.tipo = tipoFilter
      setEventos(await api.get('/api/v1/telemetria/eventos', { params }).then(r => r.data))
      setTick(new Date())
    } catch {}
  }, [tipoFilter])

  const loadStats   = async () => { try { setStats(await api.get('/api/v1/telemetria/stats').then(r => r.data)) } catch {} }
  const loadWorkers = async () => { try { const d = await api.get('/api/v1/telemetria/system/status').then(r => r.data); setWorkers(d.workers || []) } catch {} }
  const loadConfigs = async () => { try { setConfigs(await api.get('/api/v1/telemetria/config').then(r => r.data)) } catch {} }
  const loadFrota   = async () => {
    try {
      const [v, m, c] = await Promise.all([
        api.get('/api/v1/telemetria/veiculos').then(r => r.data),
        api.get('/api/v1/telemetria/motoristas').then(r => r.data),
        api.get('/api/v1/cameras').then(r => (r.data.data || r.data) as CameraItem[]),
      ])
      setVeiculos(v); setMotoristas(m); setCameras(c)
    } catch {}
  }

  useEffect(() => {
    setLoading(true)
    Promise.all([loadEventos(), loadStats(), loadWorkers(), loadFrota(), loadConfigs()]).finally(() => setLoading(false))
    pollerRef.current = window.setInterval(() => { loadEventos(); loadStats(); loadWorkers() }, 10_000)
    return () => { if (pollerRef.current) clearInterval(pollerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { loadEventos() }, [loadEventos])

  useEffect(() => {
    if (!alert?.extra) return
    const ev = alert.extra as unknown as EventoTel
    if (!ev.id) return
    setEventos(p => [ev, ...p.slice(0, 99)])
    setNewIds(p => new Set([...p, ev.id]))
    setTimeout(() => setNewIds(p => { const s = new Set(p); s.delete(ev.id); return s }), 8000)
  }, [alert])

  const filtered = useMemo(() =>
    tipoFilter ? eventos.filter(e => e.tipo_evento === tipoFilter) : eventos,
    [eventos, tipoFilter]
  )

  const tot = stats?.totais
  const onlineCount = workers.filter(w => w.stream_ok && w.alive).length

  // table column grid
  const COLS = '4px 44px 90px 1fr 1fr 80px 58px 88px'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <style>{`
        @keyframes rowFlash { 0%{background:rgba(245,158,11,.12)} 100%{background:transparent} }
        .ev-row-new { animation: rowFlash 4s ease forwards; }
        .ev-row:hover { background: var(--surface2) !important; cursor: pointer; }
      `}</style>

      <ModuleAlertBanner alert={alert} soundEnabled={prefs.sound} visualEnabled={prefs.visual}
        onToggleSound={toggleSound} onToggleVisual={toggleVisual} onDismiss={dismiss} accentColor={T.accent} />

      {/* ── Status strip ───────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(6,1fr)',
        background: s1, borderBottom: `1px solid ${bdr}`,
        position: 'sticky', top: 54, zIndex: 40,
      }}>
        {[
          { k: 'FADIGA',    v: tot?.total_fadiga    ?? 0, c: T.fadiga    },
          { k: 'CELULAR',   v: tot?.total_celular   ?? 0, c: T.celular   },
          { k: 'BOCEJO',    v: tot?.total_bocejo    ?? 0, c: T.bocejo    },
          { k: 'DISTRAÇÃO', v: tot?.total_distracao ?? 0, c: T.distracao },
          { k: 'TOTAL',     v: tot?.total_geral     ?? 0, c: tx          },
          { k: 'CÂMERAS',   v: `${onlineCount}/${workers.length}`, c: onlineCount > 0 ? T.ok : '#64748b' },
        ].map((item, i) => (
          <div key={item.k} style={{
            padding: '10px 16px',
            borderLeft: i > 0 ? `1px solid ${bdr}` : 'none',
            borderTop: `2px solid ${item.c}`,
            position: 'relative',
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: item.c, lineHeight: 1, fontVariantNumeric: 'tabular-nums', letterSpacing: -1 }}>{item.v}</div>
            <div style={{ fontSize: 9, fontWeight: 700, color: mu, marginTop: 3, letterSpacing: 1 }}>{item.k}</div>
          </div>
        ))}
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${bdr}`, background: s1, paddingLeft: 20 }}>
        {([
          { k: 'monitor',    l: 'Monitoramento' },
          { k: 'frota',      l: 'Frota' },
          { k: 'motoristas', l: 'Motoristas' },
          { k: 'sistema',    l: 'Sistema' },
        ] as const).map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '10px 16px', fontSize: 12,
            fontWeight: tab === t.k ? 700 : 400,
            color: tab === t.k ? T.accent : mu,
            borderBottom: `2px solid ${tab === t.k ? T.accent : 'transparent'}`,
            marginBottom: -1, transition: 'color .12s',
          }}>{t.l}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingRight: 16, gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.ok, boxShadow: `0 0 5px ${T.ok}` }} />
          <span style={{ fontSize: 10, color: mu, fontVariantNumeric: 'tabular-nums' }}>
            {format(tick, 'HH:mm:ss')}
          </span>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, padding: '16px 20px' }}>

        {/* ══ Monitor ══════════════════════════════════════════════════════ */}
        {tab === 'monitor' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 248px', gap: 16, alignItems: 'start' }}>

            {/* Event table */}
            <div style={{ border: `1px solid ${bdr}`, borderRadius: 4, overflow: 'hidden' }}>

              {/* filter bar */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '9px 12px', borderBottom: `1px solid ${bdr}`, background: s2, gap: 4 }}>
                {(['', 'fadiga', 'celular', 'bocejo', 'distracao'] as const).map(t => {
                  const m = t ? TIPO[t] : null; const act = tipoFilter === t
                  return (
                    <button key={t} onClick={() => setTipoFilter(t)} style={{
                      background: act ? (m ? `${m.color}14` : `${bdr}`) : 'transparent',
                      border: `1px solid ${act ? (m?.color || T.accent) : bdr}`,
                      color: act ? (m?.color || tx) : mu,
                      borderRadius: 3, padding: '3px 10px', cursor: 'pointer',
                      fontSize: 10, fontWeight: act ? 700 : 400, transition: 'all .1s',
                    }}>{t ? TIPO[t].label : 'Todos'}</button>
                  )
                })}
                <span style={{ marginLeft: 'auto', fontSize: 10, color: mu, fontVariantNumeric: 'tabular-nums' }}>{filtered.length} eventos</span>
              </div>

              {/* table head */}
              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: s2, borderBottom: `1px solid ${bdr}` }}>
                {['', '', 'Veículo', 'Motorista', 'Câmera', 'Severidade', 'Conf.', 'Horário'].map((h, i) => (
                  <div key={i} style={{ padding: '7px 10px', fontSize: 9, fontWeight: 700, letterSpacing: 1, color: mu, textTransform: 'uppercase' }}>{h}</div>
                ))}
              </div>

              {/* rows */}
              <div>
                {loading && filtered.length === 0 && (
                  <div style={{ padding: '40px 16px', fontSize: 12, color: mu }}>Carregando…</div>
                )}
                {!loading && filtered.length === 0 && (
                  <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: mu, marginBottom: 4 }}>Nenhum evento registrado</div>
                    <div style={{ fontSize: 10, color: mu, opacity: .6 }}>Configure câmeras de bordo na aba Sistema</div>
                  </div>
                )}
                {filtered.map((ev, i) => {
                  const meta = TIPO[ev.tipo_evento] || TIPO.fadiga
                  const isNew = newIds.has(ev.id)
                  return (
                    <EventRow
                      key={ev.id}
                      ev={ev} meta={meta} isNew={isNew}
                      cols={COLS} index={i}
                      onClick={() => setSelected(ev)}
                    />
                  )
                })}
              </div>
            </div>

            {/* Right insight panel */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 130 }}>

              {/* 12h chart */}
              <div style={{ background: s1, border: `1px solid ${bdr}`, borderRadius: 4, padding: '12px 12px 10px' }}>
                <SLabel>Eventos — 12h</SLabel>
                <HourlyChart eventos={eventos} />
                {/* legend */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginTop: 8 }}>
                  {Object.entries(TIPO).map(([k, m]) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ width: 6, height: 6, borderRadius: 1, background: m.color }} />
                      <span style={{ fontSize: 9, color: mu }}>{m.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* type breakdown */}
              {tot && tot.total_geral > 0 && (
                <div style={{ background: s1, border: `1px solid ${bdr}`, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 12px 6px' }}><SLabel>Por Tipo</SLabel></div>
                  {Object.entries(TIPO).map(([k, m]) => {
                    const count = tot[`total_${k}` as keyof typeof tot] as number || 0
                    const pct = tot.total_geral > 0 ? (count / tot.total_geral) * 100 : 0
                    return (
                      <div key={k} style={{ padding: '6px 12px', borderTop: `1px solid ${bdr}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: m.color, fontWeight: 600 }}>{m.label}</span>
                          <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{count}</span>
                        </div>
                        <div style={{ height: 2, background: s2, borderRadius: 1 }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: m.color, opacity: .7 }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* driver risk */}
              {(stats?.por_motorista || []).length > 0 && (
                <div style={{ background: s1, border: `1px solid ${bdr}`, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 12px 6px' }}><SLabel>Risco por Motorista</SLabel></div>
                  {stats!.por_motorista.slice(0, 5).map((row, i) => (
                    <div key={i} style={{ padding: '7px 12px', borderTop: `1px solid ${bdr}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                        <Avatar name={row.motorista} size={20} />
                        <span style={{ fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.motorista}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: T.fadiga, fontVariantNumeric: 'tabular-nums' }}>{row.total}</span>
                      </div>
                      <ScoreBar score={Math.max(0, 100 - row.total * 3)} />
                    </div>
                  ))}
                </div>
              )}

              {/* cameras */}
              {workers.length > 0 && (
                <div style={{ background: s1, border: `1px solid ${bdr}`, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 12px 6px' }}><SLabel>Câmeras</SLabel></div>
                  {workers.map(w => {
                    const on = w.stream_ok && w.alive
                    return (
                      <div key={w.cam_id} style={{ padding: '7px 12px', borderTop: `1px solid ${bdr}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: on ? T.ok : '#ef4444', boxShadow: on ? `0 0 5px ${T.ok}` : 'none' }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.veiculo_placa || w.cam_nome}</div>
                          {w.motorista && <div style={{ fontSize: 9, color: mu }}>{w.motorista}</div>}
                        </div>
                        <Pill color={on ? T.ok : '#ef4444'}>{on ? 'ON' : 'OFF'}</Pill>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══ Frota ════════════════════════════════════════════════════════ */}
        {tab === 'frota' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <BtnPrimary onClick={() => setShowVeiculo(true)}>+ Novo Veículo</BtnPrimary>
            </div>
            <DataTable
              cols="116px 1fr 1fr 1fr 96px"
              head={['Placa', 'Modelo / Marca', 'Motorista', 'Câmera', 'Status']}
              empty="Nenhum veículo cadastrado"
            >
              {veiculos.map((v, i) => (
                <DataRow key={v.id} cols="116px 1fr 1fr 1fr 96px" index={i}>
                  <Cell><span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, letterSpacing: .5 }}>{v.placa}</span></Cell>
                  <Cell>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{v.modelo || '—'}</div>
                    <div style={{ fontSize: 10, color: mu }}>{v.marca}{v.ano ? ` · ${v.ano}` : ''}</div>
                  </Cell>
                  <Cell>
                    {v.motorista_nome
                      ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Avatar name={v.motorista_nome} size={22} /><span style={{ fontSize: 12 }}>{v.motorista_nome}</span></span>
                      : <span style={{ color: mu, fontSize: 12 }}>—</span>
                    }
                  </Cell>
                  <Cell><span style={{ fontSize: 12, color: mu }}>{v.camera_nome || '—'}</span></Cell>
                  <Cell>{v.telemetria_ativa != null && <Pill color={v.telemetria_ativa ? T.ok : '#64748b'}>{v.telemetria_ativa ? 'ATIVO' : 'INATIVO'}</Pill>}</Cell>
                </DataRow>
              ))}
            </DataTable>
          </div>
        )}

        {/* ══ Motoristas ═══════════════════════════════════════════════════ */}
        {tab === 'motoristas' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <BtnPrimary onClick={() => setShowMot(true)}>+ Novo Motorista</BtnPrimary>
            </div>
            <DataTable
              cols="1fr 130px 120px 110px 140px 78px"
              head={['Motorista', 'CNH / Cat.', 'Telefone', 'Veículo', 'Score Segurança', 'Status']}
              empty="Nenhum motorista cadastrado"
            >
              {motoristas.map((m, i) => (
                <DataRow key={m.id} cols="1fr 130px 120px 110px 140px 78px" index={i}>
                  <Cell>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar name={m.nome} size={26} />
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{m.nome}</span>
                    </span>
                  </Cell>
                  <Cell>
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{m.cnh || '—'}</span>
                    <span style={{ fontSize: 10, color: mu, marginLeft: 5 }}>Cat {m.categoria}</span>
                  </Cell>
                  <Cell><span style={{ fontFamily: 'monospace', fontSize: 11, color: mu }}>{m.telefone || '—'}</span></Cell>
                  <Cell><span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 12 }}>{m.veiculo_placa || <span style={{ color: mu, fontFamily: 'inherit', fontWeight: 400 }}>—</span>}</span></Cell>
                  <Cell><ScoreBar score={safetyScore(eventos, m.id)} /></Cell>
                  <Cell><Pill color={m.ativo ? T.ok : '#64748b'}>{m.ativo ? 'ATIVO' : 'INATIVO'}</Pill></Cell>
                </DataRow>
              ))}
            </DataTable>
            {motoristas.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 10, color: mu, opacity: .7 }}>
                Score calculado com base nos eventos registrados. Penalidade: baixo −1 · médio −2 · alto −4 · crítico −8.
              </div>
            )}
          </div>
        )}

        {/* ══ Sistema ══════════════════════════════════════════════════════ */}
        {tab === 'sistema' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* webhook */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <SLabel>Integração — Câmeras Embarcadas</SLabel>
                <button style={{ background: s2, border: `1px solid ${bdr}`, borderRadius: 4, color: tx, padding: '5px 11px', cursor: 'pointer', fontSize: 11 }}
                  onClick={async () => { await api.post('/api/v1/telemetria/system/reload'); await loadWorkers() }}>
                  Recarregar workers
                </button>
              </div>
              {configs.length === 0
                ? <div style={{ border: `1px solid ${bdr}`, borderRadius: 4, padding: '32px 16px', textAlign: 'center', fontSize: 11, color: mu }}>Nenhuma câmera configurada.</div>
                : configs.map(c => <WebhookPanel key={c.camera_id} config={c} />)
              }
              <div style={{ marginTop: 10, padding: '12px 14px', background: s1, border: `1px solid ${bdr}`, borderRadius: 4, fontSize: 11, color: mu, lineHeight: 1.9 }}>
                <strong style={{ color: tx, display: 'block', fontSize: 9, letterSpacing: 1, marginBottom: 6 }}>CONFIGURAÇÃO NA CÂMERA</strong>
                1. Gere o token da câmera acima<br />
                2. Configure o servidor de alertas com a URL exibida<br />
                3. Método <strong style={{ color: tx }}>POST</strong> · formato <strong style={{ color: tx }}>JSON</strong><br />
                4. A câmera enviará alertas automaticamente ao detectar eventos
              </div>
            </div>

            {/* workers + ranking */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={{ marginBottom: 10 }}><SLabel>Workers RTSP</SLabel></div>
                <DataTable cols="1fr 80px" head={['Câmera / Veículo', 'Status']} empty="Nenhum worker ativo">
                  {workers.map((w, i) => {
                    const on = w.stream_ok && w.alive
                    return (
                      <DataRow key={w.cam_id} cols="1fr 80px" index={i}>
                        <Cell>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: on ? T.ok : '#ef4444', boxShadow: on ? `0 0 5px ${T.ok}` : 'none' }} />
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 500 }}>{w.veiculo_placa || w.cam_nome}</div>
                              {w.motorista && <div style={{ fontSize: 10, color: mu }}>{w.motorista}</div>}
                            </div>
                          </span>
                        </Cell>
                        <Cell>
                          <Pill color={on ? T.ok : '#ef4444'}>{on ? 'ONLINE' : 'OFFLINE'}</Pill>
                          {w.errors > 0 && <span style={{ fontSize: 9, color: T.fadiga, marginLeft: 4 }}>{w.errors}err</span>}
                        </Cell>
                      </DataRow>
                    )
                  })}
                </DataTable>
              </div>

              <div>
                <div style={{ marginBottom: 10 }}><SLabel>Ranking Motoristas</SLabel></div>
                <DataTable cols="1fr 52px 52px 52px" head={['Motorista', 'Total', 'Fadiga', 'Celular']} empty="Sem dados">
                  {(stats?.por_motorista || []).map((row, i) => (
                    <DataRow key={i} cols="1fr 52px 52px 52px" index={i}>
                      <Cell>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Avatar name={row.motorista} size={20} />
                          <span style={{ fontSize: 12 }}>{row.motorista}</span>
                        </span>
                      </Cell>
                      <Cell><span style={{ fontWeight: 700, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{row.total}</span></Cell>
                      <Cell><span style={{ fontSize: 12, color: T.fadiga, fontVariantNumeric: 'tabular-nums' }}>{row.fadiga}</span></Cell>
                      <Cell><span style={{ fontSize: 12, color: T.celular, fontVariantNumeric: 'tabular-nums' }}>{row.celular}</span></Cell>
                    </DataRow>
                  ))}
                </DataTable>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {selected    && <EventoModal ev={selected} onClose={() => setSelected(null)} />}
      {showVeiculo && <VeiculoModal onClose={() => setShowVeiculo(false)} onSaved={loadFrota} cameras={cameras} motoristas={motoristas} />}
      {showMot     && <MotoristaModal onClose={() => setShowMot(false)} onSaved={loadFrota} />}
    </div>
  )
}

// ── Table primitives (defined after main to keep types in scope) ───────────────

function DataTable({ cols, head, empty, children }: { cols: string; head: string[]; empty: string; children: React.ReactNode }) {
  const hasRows = React.Children.count(children) > 0
  return (
    <div style={{ border: `1px solid ${bdr}`, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, background: s2, borderBottom: `1px solid ${bdr}` }}>
        {head.map(h => <div key={h} style={{ padding: '8px 12px', fontSize: 9, fontWeight: 700, letterSpacing: 1, color: mu, textTransform: 'uppercase' }}>{h}</div>)}
      </div>
      {!hasRows
        ? <div style={{ padding: '40px 16px', textAlign: 'center', fontSize: 11, color: mu }}>{empty}</div>
        : children
      }
    </div>
  )
}

function DataRow({ cols, index, children }: { cols: string; index: number; children: React.ReactNode }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', minHeight: 48, background: hov ? s2 : s1, borderTop: index > 0 ? `1px solid ${bdr}` : 'none', transition: 'background .1s' }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
    >{children}</div>
  )
}

function Cell({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '0 12px', display: 'flex', alignItems: 'center', minWidth: 0 }}>{children}</div>
}

// EventRow is separated to allow hooks per row
function EventRow({ ev, meta, isNew, cols, index, onClick }: {
  ev: EventoTel; meta: { label: string; color: string; abbr: string }
  isNew: boolean; cols: string; index: number; onClick: () => void
}) {
  const [hov, setHov] = useState(false)
  const [imgErr, setImgErr] = useState(false)
  return (
    <div
      className={`ev-row${isNew ? ' ev-row-new' : ''}`}
      style={{
        display: 'grid', gridTemplateColumns: cols, alignItems: 'center',
        minHeight: 42, cursor: 'pointer',
        borderTop: index > 0 ? `1px solid ${bdr}` : 'none',
        background: hov ? s2 : s1,
        transition: 'background .1s',
      }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      onClick={onClick}
    >
      {/* color indicator */}
      <div style={{ width: '100%', height: '100%', background: meta.color }} />

      {/* thumbnail */}
      <div style={{ padding: '0 6px' }}>
        <div style={{ width: 40, height: 28, borderRadius: 2, background: '#080808', overflow: 'hidden', border: `1px solid ${bdr}`, flexShrink: 0 }}>
          {ev.snapshot_url && !imgErr
            ? <img src={`${API_BASE}${ev.snapshot_url}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgErr(true)} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${meta.color}0c` }}>
                <span style={{ fontSize: 7, color: `${meta.color}70`, fontWeight: 800 }}>{meta.abbr}</span>
              </div>
          }
        </div>
      </div>

      {/* vehicle */}
      <div style={{ padding: '0 8px' }}>
        {ev.veiculo_placa
          ? <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, letterSpacing: .5 }}>{ev.veiculo_placa}</span>
          : <span style={{ fontSize: 11, color: mu }}>{ev.camera_nome || `#${ev.camera_id}`}</span>
        }
      </div>

      {/* driver */}
      <div style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {ev.motorista_nome
          ? <><Avatar name={ev.motorista_nome} size={20} /><span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.motorista_nome}</span></>
          : <span style={{ fontSize: 11, color: mu }}>—</span>
        }
      </div>

      {/* camera (only on bigger screens, used as fallback col) */}
      <div style={{ padding: '0 8px', fontSize: 11, color: mu, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ev.camera_nome || `#${ev.camera_id}`}
      </div>

      {/* severity */}
      <div style={{ padding: '0 8px' }}><SevDot sev={ev.severidade} /></div>

      {/* confidence */}
      <div style={{ padding: '0 8px', fontWeight: 700, fontSize: 13, color: meta.color, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
        {(ev.confianca * 100).toFixed(0)}%
      </div>

      {/* time */}
      <div style={{ padding: '0 12px 0 4px', textAlign: 'right' }}>
        <div style={{ fontFamily: 'monospace', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{ft(ev.detectado_em, 'HH:mm:ss')}</div>
        <div style={{ fontSize: 9, color: mu, marginTop: 1 }}>{ago(ev.detectado_em)}</div>
      </div>
    </div>
  )
}
