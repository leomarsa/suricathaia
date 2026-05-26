import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getCameras, createCamera, updateCamera, deleteCamera, testCamera,
  testConnection, testHttpApi, resetSftp, getSftpCredentials,
  getIntelbrasStatus,
  type Camera, type SftpCredentials, type CameraProvisionResult, type IntelbrasStatus,
} from '../api'
import { useAuth } from '../hooks/useAuth'

// ── Catálogo de modelos homologados ───────────────────────────────────────────
const CAMERA_CATALOG: Record<string, string[]> = {
  Intelbras: ['VIP-5460-LPR-IA', 'VIP 7250 LPR IA FT G2', 'VIP 9320 3D IA FT', 'VIP 9440 D ULTRA IA FT'],
  Hikvision: ['IDS-TCM403-BI'],
  Outros: [],
}

const BRAND_COLORS: Record<string, string> = {
  Intelbras: '#e8232a',
  Hikvision: '#d40000',
  Outros:    '#6b7280',
}

const EMPTY: Partial<Camera> = {
  nome: '', local: '', observacoes: '',
  latitude: undefined, longitude: undefined,
  fabricante: '', modelo: '', numero_serie: '',
  url_base: '', url_stream: '', resolucao: '1080p', fps: 15, protocolo: 'rtsp',
  ip_sftp: '', porta_sftp: 22, faixa_horaria: '00:00-23:59', prefixo_arquivo: '',
  tipo: 'lpr', sentido: 'ambos',
  rec_lpr: false, beep_lpr: false, rec_deteccao_unica: false, janela_dedup_seg: 60, intervalo_captura_seg: 0,
  rec_epi: false, zona_interesse: '',
  rec_contagem_pessoas: false, limite_pessoas: undefined,
  ativa: true,
  usuario_camera: '', senha_camera: '', porta_http: 80, https_camera: false,
  protocolo_lpr: 'sftp',
}

// ── UI primitives ─────────────────────────────────────────────────────────────

function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--text2)',
        paddingBottom: 8, marginBottom: 12,
        borderBottom: '1px solid var(--border)',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{children}</div>
}

function Field({ label, flex = 1, hint, children }: {
  label: string; flex?: number; hint?: string; children: React.ReactNode
}) {
  return (
    <div className="form-group" style={{ flex: `${flex} 1 0`, minWidth: 140 }}>
      <label className="form-label" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', letterSpacing: '.03em' }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4, opacity: .7 }}>{hint}</div>}
    </div>
  )
}

function Toggle({ label, sub, checked, onChange, color = 'var(--primary)' }: {
  label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void; color?: string
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '2px 0' }}
      onClick={() => onChange(!checked)}>
      <div style={{
        width: 36, height: 20, borderRadius: 10, flexShrink: 0, marginTop: 2,
        background: checked ? color : 'var(--surface2)',
        border: `1.5px solid ${checked ? color : 'var(--border)'}`,
        position: 'relative', transition: 'all .2s',
      }}>
        <div style={{
          position: 'absolute', top: 2, left: checked ? 17 : 2,
          width: 14, height: 14, borderRadius: '50%', background: '#fff',
          transition: 'left .18s', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
        }} />
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
    </label>
  )
}

// ── Hardware picker ───────────────────────────────────────────────────────────

function HardwareFields({ fabricante, modelo, onFabricante, onModelo }: {
  fabricante: string; modelo: string
  onFabricante: (v: string) => void; onModelo: (v: string) => void
}) {
  const brands       = Object.keys(CAMERA_CATALOG)
  const activeBrand  = brands.find(b => b === fabricante) ?? null
  const catalogMdls  = activeBrand ? CAMERA_CATALOG[activeBrand] : []
  const isCustom     = fabricante !== '' && !activeBrand
  const isCustomMdl  = modelo !== '' && activeBrand && !catalogMdls.includes(modelo)

  return (
    <>
      <Field label="Fabricante">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
          {brands.map(b => {
            const active = fabricante === b
            return (
              <button key={b} type="button"
                onClick={() => { onFabricante(b); if (fabricante !== b) onModelo('') }}
                style={{
                  padding: '5px 14px', borderRadius: 6, border: '1px solid',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: active ? BRAND_COLORS[b] : 'transparent',
                  borderColor: active ? BRAND_COLORS[b] : 'var(--border)',
                  color: active ? '#fff' : 'var(--text2)',
                  transition: 'all .15s',
                }}>
                {b}
              </button>
            )
          })}
        </div>
      </Field>

      {(activeBrand || isCustom || fabricante !== '') && (
        <Field label="Modelo">
          {catalogMdls.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2, marginBottom: (isCustom || isCustomMdl) ? 8 : 0 }}>
              {catalogMdls.map(m => {
                const active = modelo === m
                const color  = BRAND_COLORS[activeBrand!]
                return (
                  <button key={m} type="button" onClick={() => onModelo(m)}
                    style={{
                      padding: '4px 12px', borderRadius: 6, border: '1px solid',
                      fontSize: 11, cursor: 'pointer', fontFamily: 'monospace',
                      background: active ? color : 'transparent',
                      borderColor: active ? color : 'var(--border)',
                      color: active ? '#fff' : 'var(--text2)',
                      transition: 'all .15s',
                    }}>
                    {m}
                  </button>
                )
              })}
            </div>
          )}
          {(isCustom || isCustomMdl || catalogMdls.length === 0) && (
            <input className="form-input font-mono" placeholder="Digite o modelo"
              value={modelo} onChange={e => onModelo(e.target.value)} />
          )}
        </Field>
      )}
    </>
  )
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'geral',    label: 'Geral'    },
  { key: 'hardware', label: 'Hardware' },
  { key: 'conexao',  label: 'Conexão'  },
  { key: 'funcoes',  label: 'Funções'  },
] as const
type TabKey = typeof TABS[number]['key']

function TabBar({ active, onChange }: { active: TabKey; onChange: (t: TabKey) => void }) {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 20, gap: 0 }}>
      {TABS.map(t => {
        const isActive = t.key === active
        return (
          <button key={t.key} type="button" onClick={() => onChange(t.key)}
            style={{
              padding: '9px 18px', border: 'none', cursor: 'pointer',
              background: 'transparent', fontSize: 12, fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--text)' : 'var(--text2)',
              borderBottom: `2px solid ${isActive ? 'var(--primary)' : 'transparent'}`,
              marginBottom: -1, letterSpacing: '.02em',
              transition: 'all .15s', whiteSpace: 'nowrap',
            }}>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Credentials Modal ─────────────────────────────────────────────────────────

function CredentialsModal({ creds, onClose }: { creds: Partial<CameraProvisionResult>; onClose: () => void }) {
  const [visible, setVisible] = useState(false)
  const [copied, setCopied]   = useState<string | null>(null)

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key); setTimeout(() => setCopied(null), 2000)
    })
  }

  const CopyBtn = ({ text, k }: { text: string; k: string }) => (
    <button className="btn btn-ghost btn-sm" onClick={() => copy(text, k)} style={{ flexShrink: 0, minWidth: 56 }}>
      {copied === k ? '✓ Copiado' : 'Copiar'}
    </button>
  )

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 500 }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: creds.sftp_avisos?.length ? 'rgba(234,179,8,.15)' : 'rgba(34,197,94,.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
            }}>
              {creds.sftp_avisos?.length ? '⚠' : '✓'}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Câmera cadastrada</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                {creds.nome} · <span style={{ fontFamily: 'monospace' }}>#{creds.id}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Avisos */}
        {creds.sftp_avisos && creds.sftp_avisos.length > 0 && (
          <div style={{
            background: 'rgba(234,179,8,.07)', border: '1px solid rgba(234,179,8,.25)',
            borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 12,
          }}>
            {creds.sftp_avisos.map((w, i) => <div key={i} style={{ color: 'var(--warning)' }}>· {w}</div>)}
          </div>
        )}

        {/* SFTP — só exibe quando há credenciais SFTP */}
        {creds.sftp_usuario && <div style={{
          border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', marginBottom: 12,
        }}>
          <div style={{
            padding: '10px 14px', background: 'var(--surface2)',
            borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text2)' }}>
              Credenciais SFTP
            </span>
            <span style={{ fontSize: 10, color: 'var(--warning)', background: 'rgba(234,179,8,.1)', padding: '2px 8px', borderRadius: 4 }}>
              Salve agora — senha exibida uma única vez
            </span>
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Usuário', value: creds.sftp_usuario || '', key: 'user' },
              { label: 'Senha',   value: creds.sftp_senha   || '', key: 'pwd'  },
              { label: 'Home',    value: creds.sftp_home    || '', key: 'dir'  },
            ].map(({ label, value, key }) => (
              <div key={key}>
                <div style={{ fontSize: 10, color: 'var(--text2)', marginBottom: 4, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                  {label}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code style={{
                    flex: 1, background: 'var(--surface2)', padding: '7px 10px',
                    borderRadius: 6, fontSize: 12, fontFamily: 'monospace',
                    filter: key === 'pwd' && !visible ? 'blur(6px)' : 'none',
                    userSelect: key === 'pwd' && !visible ? 'none' : 'text',
                    transition: 'filter .2s',
                  }}>
                    {value}
                  </code>
                  {key === 'pwd' && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setVisible(v => !v)} style={{ flexShrink: 0 }}>
                      {visible ? 'Ocultar' : 'Mostrar'}
                    </button>
                  )}
                  <CopyBtn text={value} k={key} />
                </div>
              </div>
            ))}
            {creds.sftp_pilares && creds.sftp_pilares.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {creds.sftp_pilares.map(p => (
                  <code key={p} style={{
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    padding: '2px 8px', borderRadius: 4, fontSize: 11,
                  }}>/{p}</code>
                ))}
              </div>
            )}
          </div>
        </div>}

        {/* RTMP */}
        {(creds as CameraProvisionResult & { rtmp_url?: string }).rtmp_url && (
          <div style={{
            border: '1px solid rgba(251,146,60,.3)', borderRadius: 10, overflow: 'hidden', marginBottom: 12,
          }}>
            <div style={{
              padding: '10px 14px', background: 'rgba(251,146,60,.06)',
              borderBottom: '1px solid rgba(251,146,60,.2)',
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#fb923c' }}>
                Endereço RTMP
              </span>
            </div>
            <div style={{ padding: 14 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{
                  flex: 1, background: 'var(--surface2)', padding: '7px 10px',
                  borderRadius: 6, fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', color: '#fb923c',
                }}>
                  {(creds as CameraProvisionResult & { rtmp_url?: string }).rtmp_url}
                </code>
                <CopyBtn text={(creds as CameraProvisionResult & { rtmp_url?: string }).rtmp_url!} k="rtmp" />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 8 }}>
                Configure como destino de push na câmera — sem redirecionamento de porta.
              </div>
            </div>
          </div>
        )}

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 4 }} onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Cameras() {
  const nav = useNavigate()
  const { can, perfil, isAdmin } = useAuth()

  useEffect(() => { if (!can.cameras.read) nav('/', { replace: true }) }, [perfil])

  const RTMP_HOST = import.meta.env.VITE_RTMP_HOST ?? '181.215.134.65'
  const RTMP_PORT = import.meta.env.VITE_RTMP_PORT ?? '1935'
  const rtmpUrl   = (key: string) => `rtmp://${RTMP_HOST}:${RTMP_PORT}/live/${key}`

  const [cameras, setCameras]       = useState<Camera[]>([])
  const [intelbrasStatus, setIntelbrasStatus] = useState<IntelbrasStatus[]>([])
  const [loading, setLoading]     = useState(true)
  const [modal, setModal]         = useState(false)
  const [editing, setEditing]     = useState<Partial<Camera>>(EMPTY)
  const [rtmpKey, setRtmpKey]     = useState('')
  const [saving, setSaving]       = useState(false)
  const [testing, setTesting]     = useState<number | null>(null)
  const [testResult, setTestResult] = useState<Record<number, string>>({})
  const [creds, setCreds]         = useState<Partial<CameraProvisionResult> | null>(null)
  const [connTest, setConnTest]   = useState<{ ok?: boolean; msg: string } | null>(null)
  const [connTesting, setConnTesting] = useState(false)
  const [httpTest, setHttpTest]   = useState<{ ok?: boolean; msg: string } | null>(null)
  const [httpTesting, setHttpTesting] = useState(false)
  const [sftpCreds, setSftpCreds] = useState<SftpCredentials | null>(null)
  const [sftpVisible, setSftpVisible] = useState(false)
  const [tab, setTab]             = useState<TabKey>('geral')
  const [copied, setCopied]       = useState(false)
  const [confirmDel, setConfirmDel] = useState<number | null>(null)
  const [deleting, setDeleting]   = useState(false)
  const [showInactive, setShowInactive] = useState(false)

  const load = async () => {
    setLoading(true)
    try { const r = await getCameras(); setCameras(r.data.data) }
    finally { setLoading(false) }
  }

  const loadIntelbrasStatus = async () => {
    try { const r = await getIntelbrasStatus(); setIntelbrasStatus(r.data) }
    catch { /* silently ignore */ }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    loadIntelbrasStatus()
    const iv = setInterval(loadIntelbrasStatus, 10_000)
    return () => clearInterval(iv)
  }, [])

  const set = <K extends keyof Camera>(k: K, v: Camera[K]) =>
    setEditing(p => ({ ...p, [k]: v }))

  const genUUID = (): string => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID)
      return crypto.randomUUID()
    // Fallback para HTTP (sem secure context)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
  }

  const openNew = () => {
    setRtmpKey(genUUID())
    setEditing(EMPTY)
    setConnTest(null); setHttpTest(null); setSftpCreds(null)
    setTab('geral'); setModal(true)
  }

  const openEdit = (c: Camera) => {
    setEditing({ ...c })
    setConnTest(null); setHttpTest(null); setSftpCreds(null); setSftpVisible(false)
    setTab('geral'); setModal(true)
  }

  // Campos read-only gerados pelo servidor — nunca enviados no PATCH
  const READ_ONLY = new Set([
    'id', 'uuid', 'criado_em', 'atualizado_em', 'sftp_provisioned',
    'usuario_sftp', 'pasta_upload', 'sftp_user', 'sftp_path',
    'status_conexao', 'ultima_conexao', 'ultima_deteccao', 'total_deteccoes',
    'sftp_password_enc',
  ])

  const save = async () => {
    setSaving(true)
    try {
      const isNew = !(editing as Camera).id
      if (isNew) {
        const payload = { ...editing }
        if (payload.protocolo === 'rtmp' && !payload.url_stream)
          payload.url_stream = rtmpUrl(rtmpKey)
        const r = await createCamera(payload)
        setModal(false); setCreds(r.data); load()
      } else {
        // PATCH: envia apenas campos editáveis com valor definido
        const patch = Object.fromEntries(
          Object.entries(editing).filter(([k, v]) => !READ_ONLY.has(k) && v !== undefined)
        )
        await updateCamera((editing as Camera).id, patch)
        setModal(false); load()
      }
    } catch (e: unknown) {
      alert((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Erro ao salvar')
    } finally { setSaving(false) }
  }

  const del = async (id: number) => {
    setDeleting(true)
    try {
      await deleteCamera(id)
      setConfirmDel(null)
      load()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Erro ao desativar câmera'
      alert(msg)
    } finally { setDeleting(false) }
  }

  const testConn = async () => {
    const ip = editing.ip_sftp || '', porta = editing.porta_sftp || 22
    if (!ip) return
    setConnTesting(true); setConnTest(null)
    try {
      const r = await testConnection(ip, porta)
      setConnTest(r.data.ok
        ? { ok: true,  msg: `Conectado em ${ip}:${porta} · ${r.data.latencia_ms}ms` }
        : { ok: false, msg: r.data.error || 'Sem resposta' })
    } catch { setConnTest({ ok: false, msg: 'Falha na requisição' }) }
    finally  { setConnTesting(false) }
  }

  const testHttpConn = async () => {
    const ip  = (editing.ip_sftp || '').toString().split('/')[0].trim()
    const fab = editing.fabricante || ''
    const usr = editing.usuario_camera || ''
    const pwd = editing.senha_camera || ''
    if (!ip || !fab || !usr || !pwd) return
    setHttpTesting(true); setHttpTest(null)
    try {
      const r = await testHttpApi({
        ip, fabricante: fab, usuario: usr, senha: pwd,
        porta: editing.porta_http || 80, https: !!editing.https_camera,
      })
      setHttpTest(r.data.ok
        ? { ok: true,  msg: `API HTTP OK · ${r.data.latencia_ms}ms · ${r.data.bytes} bytes` }
        : { ok: false, msg: r.data.error || 'Sem resposta' })
    } catch { setHttpTest({ ok: false, msg: 'Falha na requisição' }) }
    finally  { setHttpTesting(false) }
  }

  const autoFillRtsp = () => {
    const ip  = (editing.ip_sftp || '').toString().split('/')[0].trim()
    if (!ip) return
    const fab = (editing.fabricante || '').toLowerCase()
    const usr = editing.usuario_camera || 'admin'
    const pwd = editing.senha_camera || ''
    const creds = pwd ? `${usr}:${pwd}@` : `${usr}@`
    let url = ''
    if (fab.includes('intelbras')) {
      url = `rtsp://${creds}${ip}:554/cam/realmonitor?channel=1&subtype=0`
    } else if (fab.includes('hikvision') || fab.includes('hik')) {
      url = `rtsp://${creds}${ip}:554/Streaming/Channels/101`
    }
    if (url) set('url_stream', url)
  }

  const testExisting = async (id: number) => {
    setTesting(id)
    try {
      const r = await testCamera(id)
      setTestResult(prev => ({ ...prev, [id]: r.data.status || 'ok' }))
    } catch { setTestResult(prev => ({ ...prev, [id]: 'erro' })) }
    finally  { setTesting(null); load() }
  }

  const recoverSftp = async () => {
    const id = (editing as Camera).id; if (!id) return
    try { const r = await getSftpCredentials(id); setSftpCreds(r.data); setSftpVisible(false) }
    catch { alert('Falha ao recuperar credenciais') }
  }

  const doResetSftp = async () => {
    const id = (editing as Camera).id
    if (!id || !confirm('Gerar nova senha SFTP? A atual será invalidada.')) return
    try { const r = await resetSftp(id); setSftpCreds(r.data); setSftpVisible(true) }
    catch { alert('Falha ao resetar senha') }
  }

  const copyRtmp = (url: string) => {
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  const statusBadge = (s: string) => {
    if (s === 'online')  return <span className="badge badge-green"><span className="status-dot online"/>Online</span>
    if (s === 'offline') return <span className="badge badge-red"><span className="status-dot offline"/>Offline</span>
    if (s === 'erro')    return <span className="badge badge-red"><span className="status-dot offline"/>Erro</span>
    return <span className="badge badge-gray"><span className="status-dot unknown"/>—</span>
  }

  const intelbrasBadge = (st: IntelbrasStatus) => {
    const cfg = {
      connected:   { bg: 'rgba(34,197,94,.12)',  color: '#22c55e', label: 'API OK'         },
      reconnecting:{ bg: 'rgba(234,179,8,.12)',  color: '#eab308', label: 'Reconectando'   },
      error:       { bg: 'rgba(239,68,68,.12)',  color: '#ef4444', label: 'Erro'            },
      stopped:     { bg: 'rgba(100,116,139,.1)', color: '#94a3b8', label: 'Parado'          },
    }
    const c = cfg[st.status] ?? cfg.stopped
    const tip = st.last_error
      ? `${st.last_error}${st.last_error_at ? ' · ' + st.last_error_at : ''}`
      : st.last_connect_at
        ? `Conectado em ${st.last_connect_at}` + (st.last_event_at ? ` · Último evento ${st.last_event_at}` : '')
        : ''
    return (
      <span title={tip} style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 7px', borderRadius: 4,
        fontSize: 10, fontWeight: 700, letterSpacing: '.05em',
        background: c.bg, color: c.color, cursor: tip ? 'help' : 'default',
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%', background: c.color,
          boxShadow: st.status === 'connected' ? `0 0 4px ${c.color}` : 'none',
        }} />
        {c.label}
      </span>
    )
  }

  const protoBadge = (p: string) => {
    const map: Record<string, { bg: string; color: string }> = {
      rtmp: { bg: 'rgba(251,146,60,.12)', color: '#f97316' },
      rtsp: { bg: 'rgba(99,102,241,.12)', color: '#818cf8' },
      http: { bg: 'rgba(100,116,139,.1)', color: '#94a3b8' },
    }
    const style = map[p] ?? map.rtsp
    return (
      <span style={{
        display: 'inline-block', padding: '2px 7px', borderRadius: 4,
        fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
        background: style.bg, color: style.color,
      }}>
        {(p || 'rtsp').toUpperCase()}
      </span>
    )
  }

  const isEditing = !!(editing as Camera).id

  return (
    <div className="page">
      {creds && <CredentialsModal creds={creds} onClose={() => setCreds(null)} />}

      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Câmeras</div>
          <div className="page-subtitle">{cameras.filter(c => c.ativa).length} ativa(s) · {cameras.filter(c => !c.ativa).length} inativa(s)</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {cameras.some(c => !c.ativa) && (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowInactive(p => !p)}
              style={{ fontSize: 11 }}>
              {showInactive ? 'Ocultar inativas' : 'Ver inativas'}
            </button>
          )}
          {can.cameras.create && (
            <button className="btn btn-primary" onClick={openNew}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Nova Câmera
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : cameras.filter(c => showInactive || c.ativa).length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📷</div>
            <div>Nenhuma câmera cadastrada</div>
            {can.cameras.create && (
              <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={openNew}>
                Adicionar câmera
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Câmera</th>
                  <th>Local</th>
                  <th>Protocolo</th>
                  <th>SFTP</th>
                  <th>Pilares</th>
                  <th>Status</th>
                  {intelbrasStatus.length > 0 && <th>API HTTP</th>}
                  <th style={{ textAlign: 'right' }}>Detecções</th>
                  <th style={{ textAlign: 'right' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {cameras.filter(c => showInactive || c.ativa).map(c => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          fontFamily: 'monospace', fontSize: 10,
                          color: 'var(--text2)', minWidth: 28,
                        }}>#{c.id}</span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{c.nome}</div>
                          {!c.ativa && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, letterSpacing: '.06em',
                              color: 'var(--text2)', textTransform: 'uppercase',
                            }}>Inativa</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.local}
                    </td>
                    <td>{protoBadge(c.protocolo)}</td>
                    <td className="font-mono" style={{ fontSize: 11 }}>
                      {c.usuario_sftp
                        ? <span style={{ color: c.sftp_provisioned ? 'var(--success)' : 'var(--text2)' }}>
                            {c.sftp_provisioned && <span style={{ marginRight: 4 }}>✓</span>}{c.usuario_sftp}
                          </span>
                        : <span style={{ color: 'var(--danger)', fontSize: 11 }}>—</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {c.rec_lpr && <span className="badge badge-blue" style={{ fontSize: 10 }}>LPR</span>}
                        {c.rec_epi && <span className="badge badge-cyan" style={{ fontSize: 10 }}>EPI</span>}
                        {c.rec_contagem_pessoas && <span className="badge badge-yellow" style={{ fontSize: 10 }}>Pessoas</span>}
                        {!c.rec_lpr && !c.rec_epi && !c.rec_contagem_pessoas &&
                          <span style={{ color: 'var(--text2)', fontSize: 11 }}>—</span>}
                      </div>
                    </td>
                    <td>{statusBadge(testResult[c.id] || c.status_conexao)}</td>
                    {intelbrasStatus.length > 0 && (
                      <td>
                        {(() => {
                          const st = intelbrasStatus.find(s => s.camera_id === c.id)
                          return st ? intelbrasBadge(st) : (
                            c.protocolo_lpr === 'intelbras_api'
                              ? <span style={{ fontSize: 10, color: 'var(--text2)' }}>—</span>
                              : null
                          )
                        })()}
                      </td>
                    )}
                    <td style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                      {c.total_deteccoes.toLocaleString()}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        {can.cameras.test && (
                          <button className="btn btn-ghost btn-sm" disabled={testing === c.id}
                            onClick={() => testExisting(c.id)}>
                            {testing === c.id ? <span className="spinner" style={{ width: 11, height: 11 }} /> : 'Testar'}
                          </button>
                        )}
                        {can.cameras.edit && (
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(c)}>Editar</button>
                        )}
                        {can.cameras.delete && (
                          confirmDel === c.id ? (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <span style={{ fontSize: 11, color: 'var(--danger)', whiteSpace: 'nowrap' }}>Desativar?</span>
                              <button className="btn btn-danger btn-sm" disabled={deleting}
                                onClick={() => del(c.id)}>
                                {deleting ? <span className="spinner" style={{ width: 10, height: 10 }} /> : 'Sim'}
                              </button>
                              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(null)}>Não</button>
                            </div>
                          ) : (
                            <button className="btn btn-ghost btn-sm"
                              style={{ color: 'var(--danger)' }}
                              onClick={() => setConfirmDel(c.id)}>
                              Excluir
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Form Modal ───────────────────────────────────────────────────────── */}
      {modal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModal(false)}>
          <div className="modal" style={{
            maxWidth: 620, width: '100%',
            display: 'flex', flexDirection: 'column',
            maxHeight: '92vh', padding: 0, overflow: 'hidden',
          }}>

            {/* Modal header */}
            <div style={{
              padding: '18px 24px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {isEditing ? 'Editar Câmera' : 'Nova Câmera'}
                </div>
                {isEditing && (
                  <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2, fontFamily: 'monospace' }}>
                    #{(editing as Camera).id} · {editing.nome}
                  </div>
                )}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setModal(false)}
                style={{ fontSize: 18, lineHeight: 1, padding: '4px 8px' }}>×</button>
            </div>

            {/* Status Intelbras API — visível apenas ao editar câmera com protocolo_lpr=intelbras_api */}
            {isEditing && editing.protocolo_lpr === 'intelbras_api' && (() => {
              const st = intelbrasStatus.find(s => s.camera_id === (editing as Camera).id)
              if (!st) return null
              const cfg = {
                connected:   { bg: 'rgba(34,197,94,.08)',  border: 'rgba(34,197,94,.25)',  color: '#22c55e', label: 'Conectado e recebendo eventos' },
                reconnecting:{ bg: 'rgba(234,179,8,.08)',  border: 'rgba(234,179,8,.25)',  color: '#eab308', label: `Reconectando (próxima tentativa em ${st.backoff_s}s)` },
                error:       { bg: 'rgba(239,68,68,.07)',  border: 'rgba(239,68,68,.25)',  color: '#ef4444', label: st.last_error || 'Erro de conexão' },
                stopped:     { bg: 'rgba(100,116,139,.07)', border: 'rgba(100,116,139,.2)', color: '#94a3b8', label: 'Serviço parado' },
              }
              const c = cfg[st.status] ?? cfg.stopped
              return (
                <div style={{
                  margin: '0 24px', padding: '8px 12px', borderRadius: 7,
                  background: c.bg, border: `1px solid ${c.border}`,
                  display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
                }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', background: c.color, flexShrink: 0,
                    boxShadow: st.status === 'connected' ? `0 0 6px ${c.color}` : 'none',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: c.color }}>
                      API HTTP — {c.label}
                    </span>
                    {(st.last_event_at || st.last_connect_at) && (
                      <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>
                        {st.last_event_at && `Último evento: ${st.last_event_at}`}
                        {st.last_event_at && st.last_connect_at && ' · '}
                        {st.last_connect_at && `Conectado em: ${st.last_connect_at}`}
                        {st.total_events > 0 && ` · ${st.total_events} eventos`}
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Tabs */}
            <div style={{ padding: '0 24px', flexShrink: 0 }}>
              <TabBar active={tab} onChange={setTab} />
            </div>

            {/* Body */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '4px 24px 20px',
              display: 'flex', flexDirection: 'column', gap: 20,
            }}>

              {/* ── Geral ─────────────────────────────────────────────── */}
              {tab === 'geral' && (
                <>
                  <FormSection label="Identificação">
                    <Row>
                      <Field label="Nome / Identificador *" flex={2}>
                        <input className="form-input" placeholder="CAM-ENTRADA-01"
                          value={editing.nome || ''}
                          onChange={e => set('nome', e.target.value)} />
                      </Field>
                      {isEditing && (
                        <Field label="Status" flex={1}>
                          <div style={{ paddingTop: 6 }}>
                            <Toggle label={editing.ativa ? 'Ativa' : 'Inativa'}
                              checked={!!editing.ativa} onChange={v => set('ativa', v)} />
                          </div>
                        </Field>
                      )}
                    </Row>
                    <Field label="Localização *">
                      <input className="form-input" placeholder="Portaria principal — sentido entrada"
                        value={editing.local || ''}
                        onChange={e => set('local', e.target.value)} />
                    </Field>
                    <Field label="Observações">
                      <input className="form-input" placeholder="Notas adicionais (opcional)"
                        value={editing.observacoes || ''}
                        onChange={e => set('observacoes', e.target.value)} />
                    </Field>
                  </FormSection>

                  <FormSection label="Coordenadas GPS">
                    <Row>
                      <Field label="Latitude" flex={1}>
                        <input className="form-input font-mono" placeholder="-15.7801" type="number" step="any"
                          value={editing.latitude ?? ''}
                          onChange={e => set('latitude', e.target.value ? +e.target.value : undefined as unknown as null)} />
                      </Field>
                      <Field label="Longitude" flex={1}>
                        <input className="form-input font-mono" placeholder="-47.9292" type="number" step="any"
                          value={editing.longitude ?? ''}
                          onChange={e => set('longitude', e.target.value ? +e.target.value : undefined as unknown as null)} />
                      </Field>
                    </Row>
                  </FormSection>
                </>
              )}

              {/* ── Hardware ──────────────────────────────────────────── */}
              {tab === 'hardware' && (
                <FormSection label="Equipamento">
                  <HardwareFields
                    fabricante={editing.fabricante || ''} modelo={editing.modelo || ''}
                    onFabricante={v => set('fabricante', v)} onModelo={v => set('modelo', v)} />
                  <Field label="Número de Série">
                    <input className="form-input font-mono" placeholder="DS2024A1B2C3"
                      value={editing.numero_serie || ''}
                      onChange={e => set('numero_serie', e.target.value)} />
                  </Field>
                </FormSection>
              )}

              {/* ── Conexão ───────────────────────────────────────────── */}
              {tab === 'conexao' && (
                <>
                  <FormSection label="Stream de vídeo">
                    <Row>
                      <Field label="Protocolo" flex={1}>
                        <select className="form-input"
                          value={['rtsp','rtmp'].includes(editing.protocolo || '') ? editing.protocolo : 'rtsp'}
                          onChange={e => set('protocolo', e.target.value)}>
                          <option value="rtsp">RTSP</option>
                          <option value="rtmp">RTMP (push)</option>
                        </select>
                      </Field>
                      <Field label="Resolução" flex={1}>
                        <select className="form-input" value={editing.resolucao || '1080p'}
                          onChange={e => set('resolucao', e.target.value)}>
                          {['4K', '1440p', '1080p', '720p', '480p'].map(r => <option key={r}>{r}</option>)}
                        </select>
                      </Field>
                      <Field label="FPS" flex={1}>
                        <input className="form-input" type="number" min={1} max={60}
                          value={editing.fps ?? 15}
                          onChange={e => set('fps', +e.target.value)} />
                      </Field>
                    </Row>

                    {/* RTSP: campo URL manual + auto-fill para marcas conhecidas */}
                    {editing.protocolo !== 'rtmp' && (() => {
                      const fab = (editing.fabricante || '').toLowerCase()
                      const knownBrand = fab.includes('intelbras') || fab.includes('hikvision') || fab.includes('hik')
                      const hasIp = !!(editing.ip_sftp || '').toString().trim()
                      return (
                        <Field label="URL RTSP">
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input className="form-input font-mono" style={{ flex: 1 }}
                              placeholder={
                                fab.includes('intelbras') ? 'rtsp://admin:senha@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0' :
                                (fab.includes('hikvision') || fab.includes('hik')) ? 'rtsp://admin:senha@192.168.1.100:554/Streaming/Channels/101' :
                                'rtsp://192.168.1.100:554/stream1'
                              }
                              value={editing.url_stream || ''}
                              onChange={e => set('url_stream', e.target.value)} />
                            {knownBrand && hasIp && (
                              <button className="btn btn-ghost btn-sm" style={{ flexShrink: 0, fontSize: 11 }}
                                onClick={autoFillRtsp} title="Preencher URL padrão para esta marca">
                                Auto
                              </button>
                            )}
                          </div>
                          {knownBrand && (
                            <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4 }}>
                              {fab.includes('intelbras')
                                ? 'Intelbras: …/cam/realmonitor?channel=1&subtype=0'
                                : 'Hikvision: …/Streaming/Channels/101'}
                            </div>
                          )}
                        </Field>
                      )
                    })()}

                    {/* RTMP novo: endereço gerado */}
                    {editing.protocolo === 'rtmp' && !isEditing && (
                      <div style={{
                        borderRadius: 8, border: '1px solid rgba(251,146,60,.25)',
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          padding: '8px 12px', background: 'rgba(251,146,60,.06)',
                          borderBottom: '1px solid rgba(251,146,60,.15)',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        }}>
                          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#f97316' }}>
                            Endereço de ingestão RTMP
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--text2)' }}>
                            Configure na câmera como destino de push
                          </span>
                        </div>
                        <div style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
                          <code style={{
                            flex: 1, fontFamily: 'monospace', fontSize: 12,
                            color: '#f97316', wordBreak: 'break-all',
                          }}>
                            {rtmpUrl(rtmpKey)}
                          </code>
                          <button className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
                            onClick={() => copyRtmp(rtmpUrl(rtmpKey))}>
                            {copied ? '✓' : 'Copiar'}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* RTMP edição: exibe URL salva */}
                    {editing.protocolo === 'rtmp' && isEditing && editing.url_stream && (
                      <div style={{
                        borderRadius: 8, border: '1px solid rgba(251,146,60,.25)',
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          padding: '8px 12px', background: 'rgba(251,146,60,.06)',
                          borderBottom: '1px solid rgba(251,146,60,.15)',
                        }}>
                          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#f97316' }}>
                            Endereço de ingestão RTMP
                          </span>
                        </div>
                        <div style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
                          <code style={{
                            flex: 1, fontFamily: 'monospace', fontSize: 12,
                            color: '#f97316', wordBreak: 'break-all',
                          }}>
                            {editing.url_stream}
                          </code>
                          <button className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}
                            onClick={() => copyRtmp(editing.url_stream || '')}>
                            {copied ? '✓' : 'Copiar'}
                          </button>
                        </div>
                      </div>
                    )}

                    <Field label="Base URL HTTP" hint="URL web da câmera para acesso ao painel de configuração">
                      <input className="form-input font-mono" placeholder="http://192.168.1.100"
                        value={editing.url_base || ''}
                        onChange={e => set('url_base', e.target.value)} />
                    </Field>
                  </FormSection>

                  <FormSection label="Credenciais HTTP API">
                    {(() => {
                      const fab = (editing.fabricante || '').toLowerCase()
                      const isIntelbras = fab.includes('intelbras')
                      const isHikvision = fab.includes('hikvision') || fab.includes('hik')
                      const knownBrand  = isIntelbras || isHikvision
                      const canTest = !!(editing.ip_sftp && editing.usuario_camera && editing.senha_camera)
                      return (
                        <>
                          {knownBrand && (
                            <div style={{
                              padding: '8px 12px', borderRadius: 7, marginBottom: 4,
                              background: isIntelbras ? 'rgba(232,35,42,.07)' : 'rgba(212,0,0,.07)',
                              border: `1px solid ${isIntelbras ? 'rgba(232,35,42,.2)' : 'rgba(212,0,0,.2)'}`,
                              fontSize: 11, color: 'var(--text2)',
                            }}>
                              <strong style={{ color: 'var(--text)', fontWeight: 600 }}>
                                {isIntelbras ? 'Intelbras' : 'Hikvision'}
                              </strong>
                              {' — '}
                              {isIntelbras
                                ? 'Digest Auth · GET /cgi-bin/snapshot.cgi · porta 80'
                                : 'Digest Auth · GET /ISAPI/Streaming/channels/101/picture · porta 80'}
                            </div>
                          )}
                          <Row>
                            <Field label="Usuário" flex={1}>
                              <input className="form-input" placeholder="admin"
                                value={editing.usuario_camera || ''}
                                onChange={e => set('usuario_camera', e.target.value)} />
                            </Field>
                            <Field label="Senha" flex={1}>
                              <input className="form-input" type="password" placeholder="••••••••"
                                value={editing.senha_camera || ''}
                                onChange={e => set('senha_camera', e.target.value)} />
                            </Field>
                          </Row>
                          <Row>
                            <Field label="Porta HTTP" flex={1}>
                              <input className="form-input" type="number" min={1} max={65535}
                                value={editing.porta_http || 80}
                                onChange={e => set('porta_http', +e.target.value)} />
                            </Field>
                            <Field label="HTTPS" flex={1}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', paddingTop: 6 }}>
                                <input type="checkbox"
                                  checked={!!editing.https_camera}
                                  onChange={e => set('https_camera', e.target.checked)} />
                                <span style={{ fontSize: 12 }}>Usar HTTPS</span>
                              </label>
                            </Field>
                          </Row>
                          {knownBrand && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <button className="btn btn-ghost btn-sm" onClick={testHttpConn}
                                disabled={httpTesting || !canTest}
                                title={!canTest ? 'Preencha IP, usuário e senha' : ''}>
                                {httpTesting
                                  ? <><span className="spinner" style={{ width: 11, height: 11 }} /> Testando API...</>
                                  : 'Testar API HTTP'}
                              </button>
                              {httpTest && (
                                <span style={{ fontSize: 11, color: httpTest.ok ? 'var(--success)' : 'var(--danger)' }}>
                                  {httpTest.ok ? '✓' : '✗'} {httpTest.msg}
                                </span>
                              )}
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </FormSection>

                  <FormSection label="Upload SFTP">
                    {!isEditing && (
                      <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                        Usuário e diretórios criados automaticamente ao cadastrar.
                      </div>
                    )}
                    <Row>
                      <Field label="IP da câmera" flex={2}>
                        <input className="form-input font-mono" placeholder="192.168.1.100"
                          value={editing.ip_sftp || ''}
                          onChange={e => set('ip_sftp', e.target.value)} />
                      </Field>
                      <Field label="Porta" flex={1}>
                        <input className="form-input" type="number" min={1} max={65535}
                          value={editing.porta_sftp || 22}
                          onChange={e => set('porta_sftp', +e.target.value)} />
                      </Field>
                    </Row>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button className="btn btn-ghost btn-sm" onClick={testConn}
                        disabled={connTesting || !editing.ip_sftp}>
                        {connTesting
                          ? <><span className="spinner" style={{ width: 11, height: 11 }} /> Testando...</>
                          : 'Testar conexão'}
                      </button>
                      {connTest && (
                        <span style={{ fontSize: 11, color: connTest.ok ? 'var(--success)' : 'var(--danger)' }}>
                          {connTest.ok ? '✓' : '✗'} {connTest.msg}
                        </span>
                      )}
                    </div>

                    {isEditing && (
                      <>
                        <Row>
                          <Field label="Usuário SFTP" flex={1}>
                            <input className="form-input font-mono" readOnly
                              value={editing.usuario_sftp || '—'}
                              style={{ opacity: .6, cursor: 'default' }} />
                          </Field>
                          <Field label="Diretório" flex={2}>
                            <input className="form-input font-mono" readOnly
                              value={editing.pasta_upload || '—'}
                              style={{ opacity: .6, cursor: 'default', fontSize: 11 }} />
                          </Field>
                        </Row>
                        {isAdmin && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-ghost btn-sm" onClick={recoverSftp}>Recuperar senha</button>
                            <button className="btn btn-ghost btn-sm" onClick={doResetSftp}
                              style={{ color: 'var(--warning)' }}>Nova senha</button>
                          </div>
                        )}
                        {sftpCreds && (
                          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                            {[
                              { label: 'Usuário', value: sftpCreds.username },
                              { label: 'Senha',   value: sftpCreds.password, blur: true },
                            ].map(({ label, value, blur }) => (
                              <div key={label} style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '8px 12px', borderBottom: '1px solid var(--border)',
                              }}>
                                <span style={{ fontSize: 11, color: 'var(--text2)', width: 52 }}>{label}</span>
                                <code style={{
                                  flex: 1, fontSize: 12, fontFamily: 'monospace',
                                  filter: blur && !sftpVisible ? 'blur(4px)' : 'none',
                                }}>{value}</code>
                                {blur && (
                                  <button className="btn btn-ghost btn-sm" onClick={() => setSftpVisible(v => !v)}>
                                    {sftpVisible ? 'Ocultar' : 'Mostrar'}
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    <Row>
                      <Field label="Faixa horária" flex={1}>
                        <input className="form-input" placeholder="00:00-23:59"
                          value={editing.faixa_horaria || '00:00-23:59'}
                          onChange={e => set('faixa_horaria', e.target.value)} />
                      </Field>
                      <Field label="Prefixo de arquivo" flex={1}>
                        <input className="form-input font-mono" placeholder="CAM01"
                          value={editing.prefixo_arquivo || ''}
                          onChange={e => set('prefixo_arquivo', e.target.value)} />
                      </Field>
                    </Row>
                  </FormSection>
                </>
              )}

              {/* ── Funções ───────────────────────────────────────────── */}
              {tab === 'funcoes' && (
                <FormSection label="Módulos de análise">
                  {/* LPR */}
                  <Toggle label="Leitura de Placa (LPR)"
                    sub="Recebe placas via SFTP (OCR local) ou diretamente da API da câmera"
                    checked={!!editing.rec_lpr} onChange={v => set('rec_lpr', v)} color="var(--primary)" />
                  {editing.rec_lpr && (
                    <div style={{ marginLeft: 46, paddingLeft: 14, borderLeft: '2px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <Field label="Fonte LPR">
                        <select className="form-input" value={editing.protocolo_lpr || 'sftp'} onChange={e => set('protocolo_lpr', e.target.value)}>
                          <option value="sftp">SFTP + OCR local (PaddleOCR)</option>
                          <option value="intelbras_api">Intelbras API — long-polling (eventManager.cgi)</option>
                        </select>
                        {editing.protocolo_lpr === 'intelbras_api' && (
                          <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 6, background: 'rgba(16,185,129,.08)', border: '1px solid rgba(16,185,129,.25)', fontSize: 11, color: 'var(--text2)' }}>
                            Requer IP, usuário e senha configurados na aba <strong>API HTTP</strong>. O sistema abrirá uma conexão contínua com a câmera e receberá as placas em tempo real via <code>TrafficJunction</code>.
                          </div>
                        )}
                      </Field>
                      <Toggle label="Alerta Sonoro LPR"
                        sub="Emite bip no Dashboard a cada nova placa detectada por esta câmera"
                        checked={!!editing.beep_lpr} onChange={v => set('beep_lpr', v)} color="var(--success, #22c55e)" />
                      <Row>
                        <Field label="Tipo" flex={1}>
                          <select className="form-input" value={editing.tipo || 'lpr'} onChange={e => set('tipo', e.target.value)}>
                            <option value="lpr">Via principal</option>
                            <option value="perimetro">Perímetro</option>
                            <option value="acesso">Controle de acesso</option>
                            <option value="mobile">Móvel</option>
                          </select>
                        </Field>
                        <Field label="Sentido" flex={1}>
                          <select className="form-input" value={editing.sentido || 'ambos'} onChange={e => set('sentido', e.target.value)}>
                            <option value="entrada">Entrada</option>
                            <option value="saida">Saída</option>
                            <option value="ambos">Ambos</option>
                          </select>
                        </Field>
                      </Row>
                      <Toggle label="Anti-duplicata"
                        sub="Ignora mesma placa dentro da janela configurada"
                        checked={!!editing.rec_deteccao_unica} onChange={v => set('rec_deteccao_unica', v)} color="var(--primary)" />
                      <Row>
                        <Field label="Janela dedup (seg)" flex={1}>
                          <input className="form-input" type="number" min={5} max={3600}
                            value={editing.janela_dedup_seg ?? 60} onChange={e => set('janela_dedup_seg', +e.target.value)} />
                        </Field>
                        <Field label="Intervalo captura (seg)" flex={1}>
                          <input className="form-input" type="number" min={0}
                            value={editing.intervalo_captura_seg ?? 0} onChange={e => set('intervalo_captura_seg', +e.target.value)} />
                        </Field>
                      </Row>
                    </div>
                  )}

                  <div style={{ height: 1, background: 'var(--border)' }} />

                  {/* Pessoas */}
                  <Toggle label="Contagem de Pessoas"
                    sub="YOLOv8 · requer URL RTSP/RTMP configurada"
                    checked={!!editing.rec_contagem_pessoas} onChange={v => set('rec_contagem_pessoas', v)} color="var(--warning)" />
                  {editing.rec_contagem_pessoas && (
                    <div style={{ marginLeft: 46, paddingLeft: 14, borderLeft: '2px solid var(--border)' }}>
                      <Field label="Limite de lotação (pessoas)" hint="Dispara alerta quando atingido">
                        <input className="form-input" type="number" min={1} placeholder="Ex: 50"
                          value={editing.limite_pessoas || ''}
                          onChange={e => set('limite_pessoas', +e.target.value || undefined as unknown as null)} />
                      </Field>
                    </div>
                  )}

                  <div style={{ height: 1, background: 'var(--border)' }} />

                  {/* EPI */}
                  <Toggle label="Análise de EPI / PPE"
                    sub="YOLOv8 · capacete e colete · câmera envia JPGs para /epi"
                    checked={!!editing.rec_epi} onChange={v => set('rec_epi', v)} color="var(--cyan,#06b6d4)" />
                  {editing.rec_epi && (
                    <div style={{ marginLeft: 46, paddingLeft: 14, borderLeft: '2px solid var(--border)' }}>
                      <Field label="Zona de interesse (ROI)">
                        <input className="form-input" placeholder="Plataforma de carga, zona norte"
                          value={editing.zona_interesse || ''}
                          onChange={e => set('zona_interesse', e.target.value)} />
                      </Field>
                    </div>
                  )}
                </FormSection>
              )}
            </div>

            {/* Footer */}
            <div style={{
              padding: '14px 24px', borderTop: '1px solid var(--border)',
              flexShrink: 0, display: 'flex', gap: 10, background: 'var(--surface)',
            }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setModal(false)}>
                Cancelar
              </button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={save}
                disabled={saving || !editing.nome || !editing.local}>
                {saving
                  ? <><span className="spinner" style={{ width: 13, height: 13 }} /> Salvando...</>
                  : isEditing ? 'Salvar alterações' : 'Cadastrar câmera'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
