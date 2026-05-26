import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSystemStatus, getQueueStats, getUpdateCheck, triggerUpdateCheck, getRtspStatus, reloadRtsp, getEmitente, setEmitente, type SystemStatus, type UpdateCheck, type RtspWorkerStatus, type Emitente } from '../api'
import api from '../api'
import { useAuth } from '../hooks/useAuth'
import { format } from 'date-fns'

function Field({
  label, k, type, form, set, placeholder,
}: {
  label: string
  k: keyof Emitente
  type: string
  form: Emitente
  set: (k: keyof Emitente) => (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
}) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <input
        className="form-input"
        type={type}
        value={(form[k] as string) || ''}
        onChange={set(k)}
        placeholder={placeholder || label}
      />
    </div>
  )
}

function EmpresaCard({
  empresaForm, setEF, saveEmpresa, savingEmp, empMsg, onLogoUpload, onLogoError,
}: {
  empresaForm: Emitente
  setEF: (k: keyof Emitente) => (e: React.ChangeEvent<HTMLInputElement>) => void
  saveEmpresa: () => void
  savingEmp: boolean
  empMsg: { ok: boolean; text: string } | null
  onLogoUpload: (dataUrl: string) => void
  onLogoError: (msg: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { perfil } = useAuth()
  const [loadingImg, setLoadingImg] = useState(false)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    if (!file.type.startsWith('image/')) {
      onLogoError('Arquivo inválido. Use PNG, JPG, SVG ou WebP.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      onLogoError('Imagem muito grande. Máximo 5 MB.')
      return
    }

    setLoadingImg(true)
    const reader = new FileReader()
    reader.onerror = () => { setLoadingImg(false); onLogoError('Erro ao ler o arquivo.') }
    reader.onload = ev => {
      const src = ev.target?.result as string
      if (!src) { setLoadingImg(false); onLogoError('Falha ao processar imagem.'); return }

      // Compress/resize via canvas if > 300 KB
      if (file.size > 300 * 1024 && file.type !== 'image/svg+xml') {
        const img = new Image()
        img.onerror = () => { setLoadingImg(false); onLogoError('Imagem corrompida ou formato não suportado.') }
        img.onload = () => {
          const MAX = 800
          let w = img.width, h = img.height
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX }
            else       { w = Math.round(w * MAX / h); h = MAX }
          }
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
          const compressed = canvas.toDataURL('image/jpeg', 0.85)
          setLoadingImg(false)
          onLogoUpload(compressed)
        }
        img.src = src
      } else {
        setLoadingImg(false)
        onLogoUpload(src)
      }
    }
    reader.readAsDataURL(file)
  }

  const hasLogo = !!empresaForm.logo_url

  return (
    <div style={{ marginTop:16, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, overflow:'hidden' }}>
      <style>{`
        .logo-zone { transition: border-color .18s, background .18s; }
        .logo-zone:hover { border-color: var(--primary) !important; background: var(--surface3) !important; }
        .logo-zone:hover .logo-overlay { opacity: 1 !important; }
        .logo-overlay { opacity: 0; transition: opacity .18s; }
        .emp-upload-btn { transition: background .15s, color .15s; }
        .emp-upload-btn:hover { background: var(--surface2) !important; color: var(--text) !important; }
      `}</style>

      {/* ── Header ── */}
      <div style={{
        display:'flex', alignItems:'center', gap:12,
        padding:'16px 24px', borderBottom:'1px solid var(--border)',
        background:'var(--surface2)',
      }}>
        <div style={{
          width:34, height:34, borderRadius:9, flexShrink:0,
          background:'var(--surface3)', border:'1px solid var(--border)',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2"/>
            <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:'var(--text)' }}>Dados da Empresa</div>
          <div style={{ fontSize:11, color:'var(--text2)' }}>Cabeçalho dos relatórios gerados pelo sistema</div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ display:'grid', gridTemplateColumns:'192px 1fr', padding:'24px', gap:0 }}>

        {/* ── Logo column ── */}
        <div style={{ paddingRight:24, borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:10 }}>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display:'none' }} />

          {/* Upload zone */}
          <div
            className="logo-zone"
            onClick={() => !loadingImg && fileRef.current?.click()}
            style={{
              width:'100%', aspectRatio:'1/1', borderRadius:10, cursor: loadingImg ? 'wait' : 'pointer',
              border:`1px dashed ${hasLogo ? 'var(--border)' : 'var(--border2)'}`,
              background: hasLogo ? 'var(--surface2)' : 'var(--surface2)',
              display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
              overflow:'hidden', position:'relative',
            }}
          >
            {loadingImg ? (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
                <span className="spinner" style={{ width:22, height:22 }} />
                <span style={{ fontSize:11, color:'var(--text2)' }}>Processando…</span>
              </div>
            ) : hasLogo ? (
              <>
                <img
                  src={empresaForm.logo_url} alt="logo"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display='none' }}
                  style={{ width:'100%', height:'100%', objectFit:'contain', padding:14 }}
                />
                <div className="logo-overlay" style={{
                  position:'absolute', inset:0,
                  background:'rgba(0,0,0,.55)', backdropFilter:'blur(2px)',
                  display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:6,
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                  </svg>
                  <span style={{ fontSize:11, color:'#fff', fontWeight:600 }}>Trocar logo</span>
                </div>
              </>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:16, textAlign:'center' }}>
                <div style={{ width:40, height:40, borderRadius:10, background:'var(--surface3)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity:.6 }}>
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                </div>
                <span style={{ fontSize:11, color:'var(--text2)', fontWeight:500 }}>Logotipo</span>
                <span style={{ fontSize:10, color:'var(--text3)' }}>PNG, JPG, SVG</span>
              </div>
            )}
          </div>

          {/* Action buttons */}
          {perfil !== 'viewer' && (
            <>
              <button className="btn btn-ghost emp-upload-btn" onClick={() => fileRef.current?.click()}
                style={{ width:'100%', justifyContent:'center', fontSize:12, padding:'6px 0' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                </svg>
                {hasLogo ? 'Trocar imagem' : 'Enviar imagem'}
              </button>
              {hasLogo && (
                <button onClick={() => onLogoUpload('')} style={{
                  width:'100%', padding:'5px 0', border:'none', borderRadius:7,
                  background:'transparent', cursor:'pointer', fontSize:11, color:'var(--text3)',
                  fontFamily:'inherit', transition:'color .15s',
                }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color='var(--danger)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color='var(--text3)' }}
                >
                  Remover
                </button>
              )}
            </>
          )}
        </div>

        {/* ── Fields column ── */}
        <div style={{ paddingLeft:24, display:'flex', flexDirection:'column', gap:14 }}>
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:14 }}>
            <Field label="Razão Social" k="nome_empresa" type="text" form={empresaForm} set={setEF} />
            <Field label="CNPJ" k="cnpj" type="text" form={empresaForm} set={setEF} placeholder="00.000.000/0001-00" />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:14 }}>
            <Field label="Endereço" k="endereco" type="text" form={empresaForm} set={setEF} />
            <Field label="Cidade / UF" k="cidade_uf" type="text" form={empresaForm} set={setEF} placeholder="São Paulo / SP" />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
            <Field label="Telefone" k="telefone" type="text" form={empresaForm} set={setEF} placeholder="(11) 99999-9999" />
            <Field label="E-mail" k="email" type="email" form={empresaForm} set={setEF} />
          </div>
          <Field label="Slogan" k="slogan" type="text" form={empresaForm} set={setEF} placeholder="Segurança inteligente em tempo real" />
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'14px 24px', borderTop:'1px solid var(--border)',
        background:'var(--surface2)',
      }}>
        <div style={{ fontSize:12 }}>
          {empMsg ? (
            <span style={{ color: empMsg.ok ? 'var(--success)' : 'var(--danger)', display:'flex', alignItems:'center', gap:6 }}>
              {empMsg.ok
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              }
              {empMsg.text}
            </span>
          ) : (
            <span style={{ color:'var(--text3)', fontSize:11 }}>
              Formatos suportados: PNG, JPG, SVG, WebP
            </span>
          )}
        </div>
        {perfil !== 'viewer' && (
          <button className="btn btn-primary" onClick={saveEmpresa} disabled={savingEmp} style={{ minWidth:130 }}>
            {savingEmp
              ? <><span className="spinner" style={{width:12,height:12,marginRight:6}}/>Salvando…</>
              : 'Salvar'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function Sistema() {
  const nav = useNavigate()
  const { can, perfil } = useAuth()
  useEffect(() => { if (!can.sistema.read) nav('/', { replace:true }) }, [perfil])

  const [status, setStatus]       = useState<SystemStatus | null>(null)
  const [queue, setQueue]         = useState<Record<string,unknown> | null>(null)
  const [updates, setUpdates]     = useState<UpdateCheck | null>(null)
  const [rtsp, setRtsp]           = useState<RtspWorkerStatus[]>([])
  const [loading, setLoading]     = useState(true)
  const [checking, setChecking]   = useState(false)
  const [reloading, setReloading] = useState(false)
  const [waTest, setWaTest]       = useState<string | null>(null)
  const [testing, setTesting]     = useState(false)

  const [, setEmpresa]                = useState<Emitente>({})
  const [empresaForm, setEmpresaForm] = useState<Emitente>({})
  const [savingEmp, setSavingEmp]     = useState(false)
  const [empMsg, setEmpMsg]           = useState<{ok:boolean;text:string}|null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [s, q, u, r] = await Promise.all([
        getSystemStatus(), getQueueStats(), getUpdateCheck(), getRtspStatus(),
      ])
      setStatus(s.data); setQueue(q.data); setUpdates(u.data)
      setRtsp(r.data.workers || [])
    } finally { setLoading(false) }
  }

  const handleRtspReload = async () => {
    setReloading(true)
    try { const r = await reloadRtsp(); setRtsp(r.data.workers || []) }
    finally { setReloading(false) }
  }

  const handleCheckNow = async () => {
    setChecking(true)
    try {
      const r = await triggerUpdateCheck()
      setUpdates(r.data)
    } finally { setChecking(false) }
  }

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])

  useEffect(() => {
    getEmitente().then(r => { setEmpresa(r.data); setEmpresaForm(r.data) }).catch(() => {})
  }, [])

  const setEF = (k: keyof Emitente) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEmpresaForm(f => ({ ...f, [k]: e.target.value }))

  const saveEmpresa = async () => {
    setSavingEmp(true); setEmpMsg(null)
    try {
      const r = await setEmitente(empresaForm)
      setEmpresa(r.data)
      setEmpMsg({ ok: true, text: 'Dados salvos com sucesso!' })
    } catch {
      setEmpMsg({ ok: false, text: 'Erro ao salvar. Verifique os dados.' })
    } finally { setSavingEmp(false) }
  }

  const testWhatsApp = async () => {
    setTesting(true); setWaTest(null)
    try {
      const r = await api.post('/api/v1/whatsapp/test')
      setWaTest(`✅ Conectado — instância: ${r.data.instance}, estado: ${r.data.state}`)
    } catch(e: unknown) {
      setWaTest(`❌ ${(e as {response?:{data?:{detail?:{error?:string}}}}).response?.data?.detail?.error || 'Falha na conexão'}`)
    } finally { setTesting(false) }
  }

  const testWaSend = async () => {
    setTesting(true)
    try {
      await api.post('/api/v1/whatsapp/send-test')
      setWaTest('✅ Mensagem de teste enviada!')
    } catch(e: unknown) {
      setWaTest(`❌ ${(e as {response?:{data?:{detail?:string}}}).response?.data?.detail || 'Falha no envio'}`)
    } finally { setTesting(false) }
  }

  const hColor = (ok: boolean | undefined) =>
    ok === true ? 'var(--success)' : ok === false ? 'var(--danger)' : 'var(--warning)'

  const healthy = status?.saude === 'saudavel'

  type QueuePriority = { enqueued?: number; done?: number; errors?: number; tempo_medio_ms?: number; tempo_max_ms?: number }

  return (
    <div className="page">
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <div className="page-title">Saúde do Sistema</div>
          <div className="page-subtitle">Atualização automática a cada 15s</div>
        </div>
        <button className="btn btn-ghost" onClick={load}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 109-9M3 12V3h9"/>
          </svg>
          Atualizar
        </button>
      </div>

      {loading && !status ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : (
        <>
          {/* Saúde geral */}
          <div className="card mb-24" style={{
            borderColor: healthy ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)',
            background: healthy ? 'rgba(34,197,94,.04)' : 'rgba(239,68,68,.04)',
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:16 }}>
              <div style={{
                width:52, height:52, borderRadius:14,
                background: healthy ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)',
                display:'flex', alignItems:'center', justifyContent:'center', fontSize:28, flexShrink:0,
              }}>
                {healthy ? '✅' : '⚠️'}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:17, fontWeight:700 }}>
                  {healthy ? 'Sistema Saudável' : 'Sistema Degradado'}
                </div>
                {status?.falhas && status.falhas.length > 0 && (
                  <div style={{ color:'var(--danger)', fontSize:12, marginTop:3 }}>
                    Falhas: {status.falhas.join(', ')}
                  </div>
                )}
              </div>
              <div style={{ fontSize:11, color:'var(--text2)', textAlign:'right' }}>
                {status?.timestamp ? new Date(status.timestamp).toLocaleTimeString('pt-BR') : ''}
              </div>
            </div>
          </div>

          <div className="grid-3 mb-24">
            {/* Banco */}
            <div className="card">
              <div className="card-title">🗄️ Banco de Dados</div>
              {status?.componentes.banco && (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ color: hColor((status.componentes.banco as {ok?:boolean}).ok), fontWeight:600, fontSize:13 }}>
                    {(status.componentes.banco as {ok?:boolean}).ok ? '✔ Online' : '✘ Offline'}
                  </div>
                  {[
                    ['Leituras LPR 24h', (status.componentes.banco as Record<string,unknown>).deteccoes_24h],
                    ['Total leituras LPR', (status.componentes.banco as Record<string,unknown>).total_deteccoes],
                    ['Câmeras ativas', (status.componentes.banco as Record<string,unknown>).cameras_ativas],
                    ['Alertas 24h', (status.componentes.banco as Record<string,unknown>).alertas_24h],
                  ].map(([label, val]) => (
                    <div key={String(label)} style={{ display:'flex', justifyContent:'space-between' }}>
                      <span style={{ fontSize:12, color:'var(--text2)' }}>{String(label)}</span>
                      <span style={{ fontWeight:600, fontSize:13 }}>{String(val ?? '—')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Armazenamento */}
            <div className="card">
              <div className="card-title">💾 Armazenamento</div>
              {status?.componentes.armazenamento && (() => {
                const a = status.componentes.armazenamento as Record<string,unknown>
                const pct = Number(a.uso_pct) || 0
                return (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ color: hColor((a as {ok?:boolean}).ok), fontWeight:600, fontSize:13 }}>
                      {(a as {ok?:boolean}).ok ? '✔ OK' : '✘ Erro'}
                    </div>
                    <div>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                        <span style={{ fontSize:12, color:'var(--text2)' }}>Uso</span>
                        <span style={{ fontWeight:700, color: pct>85?'var(--danger)':pct>70?'var(--warning)':'var(--text)' }}>{pct}%</span>
                      </div>
                      <div className="progress">
                        <div className="progress-bar" style={{
                          width:`${pct}%`,
                          background: pct>85?'var(--danger)':pct>70?'var(--warning)':'var(--primary)',
                        }}/>
                      </div>
                    </div>
                    {[
                      ['Total', `${a.total_gb} GB`],
                      ['Usado', `${a.usado_gb} GB`],
                      ['Livre', `${a.livre_gb} GB`],
                    ].map(([label, val]) => (
                      <div key={String(label)} style={{ display:'flex', justifyContent:'space-between' }}>
                        <span style={{ fontSize:12, color:'var(--text2)' }}>{label}</span>
                        <span style={{ fontWeight:600, fontSize:13 }}>{String(val)}</span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>

            {/* Modelos */}
            <div className="card">
              <div className="card-title">🤖 Modelos de IA</div>
              {status?.componentes.modelos && Object.entries(status.componentes.modelos).map(([k, v]) => (
                <div key={k} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                  <span style={{ fontSize:12, color:'var(--text2)' }}>{k}</span>
                  <span className={`badge ${(v as {ok?:boolean}).ok ? 'badge-green' : 'badge-red'}`}>
                    {(v as {ok?:boolean}).ok ? `${(v as {tamanho_kb?:number}).tamanho_kb}KB` : 'Ausente'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Fila */}
          {queue && (
            <div className="card mb-24">
              <div className="card-title">⚡ Fila de Processamento</div>
              <div className="grid-3" style={{ marginBottom:16 }}>
                {(['LPR','PESSOAS','EPI'] as const).map(label => {
                  const s = (queue[label] || {}) as QueuePriority
                  const labelColor = label==='LPR' ? 'var(--primary)' : label==='PESSOAS' ? 'var(--warning)' : 'var(--cyan,#06b6d4)'
                  return (
                    <div key={label} style={{ background:'var(--bg)', borderRadius:10, padding:14, border:'1px solid var(--border)' }}>
                      <div style={{ fontWeight:700, marginBottom:12, color:labelColor, fontSize:13 }}>{label}</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                        {[
                          ['Processados', s.done, 'var(--success)'],
                          ['Enfileirados', s.enqueued, 'var(--text)'],
                          ['Erros', s.errors, (s.errors??0)>0?'var(--danger)':'var(--text2)'],
                          ['Tempo médio', `${s.tempo_medio_ms}ms`, 'var(--text2)'],
                          ['Tempo máx', `${s.tempo_max_ms}ms`, 'var(--text2)'],
                        ].map(([k, v, c]) => (
                          <div key={String(k)} style={{ display:'flex', justifyContent:'space-between' }}>
                            <span style={{ fontSize:11, color:'var(--text2)' }}>{String(k)}</span>
                            <span style={{ fontSize:12, fontWeight:600, color: c as string }}>{String(v ?? 0)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div style={{ fontSize:12, color:'var(--text2)', display:'flex', gap:20, flexWrap:'wrap' }}>
                <span>Descartados: <strong style={{color:'var(--text)'}}>{String(queue.dropped ?? 0)}</strong></span>
                <span>LPR workers: <strong style={{color:'var(--text)'}}>{String((queue.pools as Record<string,unknown>)?.lpr_workers ?? '—')}</strong></span>
                <span>Analytics workers: <strong style={{color:'var(--text)'}}>{String((queue.pools as Record<string,unknown>)?.analytics_workers ?? '—')}</strong></span>
              </div>
            </div>
          )}

          {/* Alertas */}
          <div className="card">
            <div className="card-title">🔔 Canais de Alerta</div>
            <div className="grid-2">
              <div style={{ padding:16, background:'var(--bg)', borderRadius:10, border:'1px solid var(--border)' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                  <span className={`badge ${status?.componentes.alertas && (status.componentes.alertas as {telegram?:boolean}).telegram ? 'badge-green' : 'badge-gray'}`}>
                    {status?.componentes.alertas && (status.componentes.alertas as {telegram?:boolean}).telegram ? '✔ Configurado' : '— Não configurado'}
                  </span>
                  <span style={{ fontWeight:600, fontSize:13 }}>Telegram</span>
                </div>
                <p style={{ fontSize:11, color:'var(--text2)' }}>
                  Configure <code style={{ background:'var(--surface2)', padding:'1px 5px', borderRadius:4 }}>TELEGRAM_BOT_TOKEN</code> e{' '}
                  <code style={{ background:'var(--surface2)', padding:'1px 5px', borderRadius:4 }}>TELEGRAM_CHAT_ID</code> no .env
                </p>
              </div>
              <div style={{ padding:16, background:'var(--bg)', borderRadius:10, border:'1px solid var(--border)' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                  <span className={`badge ${status?.componentes.alertas && (status.componentes.alertas as {whatsapp?:boolean}).whatsapp ? 'badge-green' : 'badge-gray'}`}>
                    {status?.componentes.alertas && (status.componentes.alertas as {whatsapp?:boolean}).whatsapp ? '✔ Configurado' : '— Não configurado'}
                  </span>
                  <span style={{ fontWeight:600, fontSize:13 }}>WhatsApp (Evolution API)</span>
                </div>
                {perfil !== 'viewer' && (
                  <div style={{ display:'flex', gap:8, marginTop:10 }}>
                    <button className="btn btn-ghost btn-sm" onClick={testWhatsApp} disabled={testing}>
                      {testing ? <span className="spinner" style={{width:12,height:12}}/> : 'Testar Conexão'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={testWaSend} disabled={testing}>
                      Enviar Teste
                    </button>
                  </div>
                )}
                {waTest && (
                  <div style={{
                    marginTop:10, fontSize:12,
                    color: waTest.startsWith('✅') ? 'var(--success)' : 'var(--danger)',
                    padding:'6px 10px', borderRadius:6,
                    background: waTest.startsWith('✅') ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
                  }}>
                    {waTest}
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* ── Workers RTSP Contagem de Pessoas ── */}
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
              <div>
                <div style={{ fontWeight:700, fontSize:14 }}>Streams RTSP — Contagem de Pessoas</div>
                <div style={{ fontSize:11, color:'var(--text2)', marginTop:2 }}>
                  Captura a cada {import.meta.env.VITE_RTSP_INTERVAL ?? '5'}s · YOLOv8n
                </div>
              </div>
              {perfil !== 'viewer' && (
                <button className="btn btn-ghost btn-sm" onClick={handleRtspReload} disabled={reloading}>
                  {reloading ? <span className="spinner" style={{width:12,height:12}}/> : '↻ Recarregar câmeras'}
                </button>
              )}
            </div>

            {rtsp.length === 0 ? (
              <div style={{ fontSize:13, color:'var(--text2)', padding:'12px 0' }}>
                Nenhum worker RTSP ativo
              </div>
            ) : (
              <div style={{ display:'flex', flexWrap:'wrap', gap:10 }}>
                {rtsp.map(w => (
                  <div key={w.cam_id} style={{
                    background:'var(--surface2)', border:`1px solid ${w.stream_ok ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.2)'}`,
                    borderRadius:10, padding:'12px 16px', minWidth:160, flex:1,
                  }}>
                    <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:8 }}>
                      <div style={{
                        width:8, height:8, borderRadius:'50%',
                        background: w.stream_ok ? 'var(--success)' : 'var(--danger)',
                        boxShadow: w.stream_ok ? '0 0 6px var(--success)' : 'none',
                      }}/>
                      <span style={{ fontSize:12, fontWeight:700 }}>
                        {w.cam_nome || `Câmera ${w.cam_id}`}
                      </span>
                      <span style={{ fontSize:10, color:'var(--text2)', marginLeft:'auto' }}>
                        {w.stream_ok ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    <div style={{ fontSize:22, fontWeight:800, color: w.last_count > 0 ? 'var(--primary)' : 'var(--text3)', marginBottom:2 }}>
                      {w.last_count}
                      <span style={{ fontSize:12, fontWeight:400, color:'var(--text2)', marginLeft:4 }}>pessoas</span>
                    </div>
                    <div style={{ fontSize:10, color:'var(--text2)' }}>
                      {w.errors > 0 && <span style={{ color:'var(--danger)' }}>{w.errors} erro(s) · </span>}
                      {w.alive ? 'Worker ativo' : 'Worker parado'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Empresa ── */}
          <EmpresaCard
            empresaForm={empresaForm}
            setEF={setEF}
            saveEmpresa={saveEmpresa}
            savingEmp={savingEmp}
            empMsg={empMsg}
            onLogoUpload={(dataUrl) => { setEmpresaForm(f => ({ ...f, logo_url: dataUrl })); setEmpMsg(null) }}
            onLogoError={(msg) => setEmpMsg({ ok: false, text: msg })}
          />

          {/* ── Check de Atualização ── */}
          {updates && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
                <div>
                  <div style={{ fontWeight:700, fontSize:14 }}>Check de Atualização</div>
                  <div style={{ fontSize:11, color:'var(--text2)', marginTop:2 }}>
                    Último check: {format(new Date(updates.timestamp), 'dd/MM/yyyy HH:mm:ss')}
                    {updates.elapsed_s && ` · ${updates.elapsed_s}s`}
                  </div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{
                    fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:20,
                    background: updates.saude_geral === 'ok' ? 'rgba(34,197,94,.12)' : updates.saude_geral === 'aviso' ? 'rgba(234,179,8,.12)' : 'rgba(239,68,68,.12)',
                    color: updates.saude_geral === 'ok' ? 'var(--success)' : updates.saude_geral === 'aviso' ? 'var(--warning)' : 'var(--danger)',
                    border: `1px solid ${updates.saude_geral === 'ok' ? 'rgba(34,197,94,.3)' : updates.saude_geral === 'aviso' ? 'rgba(234,179,8,.3)' : 'rgba(239,68,68,.3)'}`,
                  }}>
                    {updates.saude_geral.toUpperCase()}
                  </span>
                  {perfil !== 'viewer' && (
                    <button className="btn btn-ghost btn-sm" onClick={handleCheckNow} disabled={checking}>
                      {checking ? <span className="spinner" style={{width:12,height:12}}/> : '↻ Verificar agora'}
                    </button>
                  )}
                </div>
              </div>

              {/* Versão */}
              <div style={{ display:'flex', flexWrap:'wrap', gap:10, marginBottom:14 }}>
                {[
                  {
                    label: 'Versão Atual', valor: updates.versao.versao_atual,
                    ok: updates.versao.atualizado,
                    sub: updates.versao.atualizado ? 'Atualizado' : `Nova: ${updates.versao.versao_disponivel}`,
                  },
                  {
                    label: 'Watchdog', valor: updates.watchdog.ok ? 'Rodando' : 'Parado',
                    ok: updates.watchdog.ok,
                    sub: updates.watchdog.mensagem.substring(0, 40),
                  },
                  {
                    label: 'SFTP Pendentes',
                    valor: String((updates.sftp_pendentes.detalhes?.total_pendentes as number) ?? 0),
                    ok: updates.sftp_pendentes.ok,
                    sub: updates.sftp_pendentes.mensagem.substring(0, 40),
                  },
                  {
                    label: 'Disco',
                    valor: `${(updates.disco.detalhes?.pct as number) ?? 0}%`,
                    ok: updates.disco.ok,
                    sub: updates.disco.mensagem.substring(0, 40),
                  },
                  {
                    label: 'Banco',
                    valor: updates.banco.ok ? 'Conectado' : 'Falha',
                    ok: updates.banco.ok,
                    sub: updates.banco.mensagem.substring(0, 40),
                  },
                  {
                    label: 'Modelos IA',
                    valor: updates.modelos.ok ? 'OK' : 'Problema',
                    ok: updates.modelos.ok,
                    sub: updates.modelos.mensagem.substring(0, 40),
                  },
                ].map(item => (
                  <div key={item.label} style={{
                    background:'var(--surface2)', border:'1px solid var(--border)',
                    borderRadius:10, padding:'10px 14px', minWidth:130, flex:1,
                  }}>
                    <div style={{ fontSize:10, color:'var(--text2)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.05em', marginBottom:4 }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize:18, fontWeight:700, color: item.ok ? 'var(--success)' : 'var(--danger)' }}>
                      {item.valor}
                    </div>
                    <div style={{ fontSize:10, color:'var(--text2)', marginTop:3 }}>{item.sub}</div>
                  </div>
                ))}
              </div>

              {/* Alertas */}
              {updates.alertas.length > 0 && (
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {updates.alertas.map((a, i) => (
                    <div key={i} style={{
                      display:'flex', alignItems:'center', gap:8,
                      background:'rgba(234,179,8,.07)', border:'1px solid rgba(234,179,8,.2)',
                      borderRadius:8, padding:'8px 12px', fontSize:12, color:'var(--warning)',
                    }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/>
                      </svg>
                      {a}
                    </div>
                  ))}
                </div>
              )}

              {updates.alertas.length === 0 && (
                <div style={{ fontSize:12, color:'var(--success)', display:'flex', alignItems:'center', gap:6 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                  Tudo atualizado e funcionando normalmente
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
