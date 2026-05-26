import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Automacao {
  id: number; nome: string; descricao: string | null; ativo: boolean
  tipo_evento: string; condicoes: Record<string, unknown>; canais: CanalCfg
  mensagem_custom: string | null; cooldown_min: number
  horario_inicio: string | null; horario_fim: string | null
  dias_semana: number[] | null
  total_disparos: number; ultimo_disparo: string | null
  criado_em: string
}

interface CanalCfg { telegram?: boolean; whatsapp?: string[] }

interface Camera { id: number; nome: string; ativa: boolean }

// ── Constants ─────────────────────────────────────────────────────────────────

const EVENTOS: Record<string, { label: string; color: string; icon: string; desc: string }> = {
  watchlist_hit:    { label: 'Watchlist Hit',     color: '#ef4444', icon: '🚨', desc: 'Placa detectada que está na watchlist' },
  camera_offline:   { label: 'Câmera Offline',    color: '#f59e0b', icon: '📵', desc: 'Câmera sem detecções por X minutos' },
  pessoa_detectada: { label: 'Pessoa Detectada',  color: '#8b5cf6', icon: '👤', desc: 'Pessoa detectada acima do threshold' },
  epi_violacao:     { label: 'Violação EPI',      color: '#f97316', icon: '🦺', desc: 'Equipamento de proteção ausente' },
  lpr_qualquer:     { label: 'Leitura LPR',       color: '#3b82f6', icon: '📸', desc: 'Qualquer leitura de placa (LPR)' },
}

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const VARS: Record<string, string[]> = {
  watchlist_hit:    ['{placa}', '{tipo}', '{camera}', '{confianca}', '{hora}', '{data}'],
  camera_offline:   ['{camera}', '{minutos}', '{hora}', '{data}'],
  pessoa_detectada: ['{camera}', '{total}', '{plural}', '{hora}', '{data}'],
  epi_violacao:     ['{camera}', '{epi_tipo}', '{hora}', '{data}'],
  lpr_qualquer:     ['{placa}', '{camera}', '{confianca}', '{hora}', '{data}'],
}

// ── API ───────────────────────────────────────────────────────────────────────

const hdr = () => ({ 'Content-Type': 'application/json', 'X-API-Key': localStorage.getItem('api_key') || '' })

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(path, { ...opts, headers: { ...hdr(), ...(opts?.headers || {}) } })
  if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || JSON.stringify(e)) }
  return r.json()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'agora'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min atrás`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h atrás`
  return d.toLocaleDateString('pt-BR')
}

function Ico({ d, size = 15 }: { d: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)} style={{
      width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 2,
      background: value ? '#22c55e' : 'var(--border)', transition: 'background .2s', position: 'relative',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: value ? 18 : 2, width: 16, height: 16,
        borderRadius: '50%', background: '#fff', transition: 'left .2s',
      }} />
    </button>
  )
}

// ── Event type badge ──────────────────────────────────────────────────────────

function EventBadge({ tipo }: { tipo: string }) {
  const e = EVENTOS[tipo]
  if (!e) return <span style={{ fontSize: 11, color: 'var(--text2)' }}>{tipo}</span>
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
      color: e.color, background: `${e.color}18`,
    }}>
      {e.icon} {e.label}
    </span>
  )
}

// ── Channel icons ─────────────────────────────────────────────────────────────

function ChannelPills({ canais }: { canais: CanalCfg }) {
  const pills = []
  if (canais?.telegram) pills.push({ label: 'Telegram', color: '#229ED9', bg: '#229ED918' })
  const phones = canais?.whatsapp || []
  if (phones.length) pills.push({ label: `WhatsApp (${phones.length})`, color: '#25D366', bg: '#25D36618' })
  if (!pills.length) return <span style={{ fontSize: 11, color: 'var(--text2)' }}>Sem canais</span>
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {pills.map(p => (
        <span key={p.label} style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 8, color: p.color, background: p.bg }}>
          {p.label}
        </span>
      ))}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: 'var(--text2)' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>⚡</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Nenhuma automação configurada</div>
      <div style={{ fontSize: 13, marginBottom: 20 }}>Crie regras para receber alertas automáticos por WhatsApp ou Telegram.</div>
      <button onClick={onNew} style={{ ...solidBtn('#6366f1') }}>
        <Ico d="M12 5v14 M5 12h14" size={14} /> Nova Automação
      </button>
    </div>
  )
}

// ── Form defaults ─────────────────────────────────────────────────────────────

const defaultForm = (): Partial<Automacao> => ({
  nome: '', descricao: '', ativo: true, tipo_evento: '',
  condicoes: {}, canais: { telegram: false, whatsapp: [] },
  mensagem_custom: '', cooldown_min: 5,
  horario_inicio: null, horario_fim: null, dias_semana: null,
})

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Automacoes() {
  const [list, setList]       = useState<Automacao[]>([])
  const [cameras, setCameras] = useState<Camera[]>([])
  const [loading, setLoading] = useState(true)
  const [panel, setPanel]     = useState<'closed' | 'new' | 'edit'>('closed')
  const [form, setForm]       = useState<Partial<Automacao>>(defaultForm())
  const [saving, setSaving]   = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const [step, setStep]       = useState(0)
  const [waInput, setWaInput] = useState('')
  const [schedOn, setSchedOn] = useState(false)
  const [histItem, setHistItem] = useState<Automacao | null>(null)
  const [hist, setHist]         = useState<unknown[]>([])
  const [histLoading, setHistLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, c] = await Promise.all([
        apiFetch('/api/v1/automacoes'),
        apiFetch('/api/v1/cameras'),
      ])
      setList(a); setCameras(c)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function openNew() {
    setForm(defaultForm()); setStep(0); setWaInput(''); setSchedOn(false)
    setSaveErr(''); setPanel('new')
  }

  function openEdit(a: Automacao) {
    setForm({ ...a })
    setWaInput('')
    setSchedOn(!!(a.horario_inicio || a.horario_fim || a.dias_semana?.length))
    setStep(0); setSaveErr(''); setPanel('edit')
  }

  async function openHist(a: Automacao) {
    setHistItem(a); setHistLoading(true)
    try { setHist(await apiFetch(`/api/v1/automacoes/${a.id}/historico`)) }
    catch { setHist([]) } finally { setHistLoading(false) }
  }

  function setF<K extends keyof Automacao>(k: K, v: Automacao[K]) {
    setForm(f => ({ ...f, [k]: v }))
  }

  function setCond(k: string, v: unknown) {
    setForm(f => ({ ...f, condicoes: { ...(f.condicoes || {}), [k]: v } }))
  }

  function setCanal(k: string, v: unknown) {
    setForm(f => ({ ...f, canais: { ...(f.canais || {}), [k]: v } }))
  }

  function addPhone() {
    const p = waInput.trim()
    if (!p) return
    const phones = (form.canais?.whatsapp || []) as string[]
    if (!phones.includes(p)) setCanal('whatsapp', [...phones, p])
    setWaInput('')
  }

  function removePhone(p: string) {
    setCanal('whatsapp', ((form.canais?.whatsapp || []) as string[]).filter(x => x !== p))
  }

  function toggleDia(d: number) {
    const cur = (form.dias_semana || []) as number[]
    setF('dias_semana', cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d])
  }

  async function toggle(a: Automacao) {
    try {
      await apiFetch(`/api/v1/automacoes/${a.id}/toggle`, { method: 'PATCH' })
      setList(l => l.map(x => x.id === a.id ? { ...x, ativo: !x.ativo } : x))
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)) }
  }

  async function del(a: Automacao) {
    if (!confirm(`Remover "${a.nome}"?`)) return
    try { await apiFetch(`/api/v1/automacoes/${a.id}`, { method: 'DELETE' }); load() }
    catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)) }
  }

  async function save() {
    if (!form.nome?.trim()) { setSaveErr('Nome é obrigatório'); return }
    if (!form.tipo_evento) { setSaveErr('Selecione um tipo de evento'); return }
    const canais = form.canais || {}
    if (!canais.telegram && !(canais.whatsapp as string[] || []).length) {
      setSaveErr('Configure ao menos um canal de envio'); return
    }
    setSaving(true); setSaveErr('')
    const payload = {
      ...form,
      horario_inicio: schedOn ? (form.horario_inicio || null) : null,
      horario_fim:    schedOn ? (form.horario_fim    || null) : null,
      dias_semana:    schedOn ? (form.dias_semana    || null) : null,
    }
    try {
      if (panel === 'edit' && form.id) {
        await apiFetch(`/api/v1/automacoes/${form.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await apiFetch('/api/v1/automacoes', { method: 'POST', body: JSON.stringify(payload) })
      }
      setPanel('closed'); load()
    } catch (e: unknown) { setSaveErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  const cond = (form.condicoes || {}) as Record<string, unknown>
  const cams = cameras.filter(c => c.ativa)
  const selCams = (cond.camera_ids as number[] || [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '28px 32px', maxWidth: 820, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <style>{`
        .auto-card:hover { border-color: var(--primary) !important; }
        .auto-row-btn { background: transparent; border: none; cursor: pointer; padding: 4px 8px; border-radius: 5px; color: var(--text2); font-size: 12px; display: flex; align-items: center; gap: 4px; }
        .auto-row-btn:hover { background: var(--surface2); color: var(--text); }
        .step-dot { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; cursor: pointer; flex-shrink: 0; transition: all .15s; }
        .cam-chip { padding: 3px 8px; border-radius: 6px; font-size: 11px; cursor: pointer; border: 1px solid var(--border); transition: all .15s; }
        .cam-chip.sel { background: var(--primary); color: #fff; border-color: var(--primary); }
        .cam-chip:not(.sel) { background: var(--surface2); color: var(--text2); }
        .var-tag { padding: 2px 7px; border-radius: 5px; font-size: 11px; font-family: monospace; background: var(--surface2); color: var(--text2); cursor: pointer; border: 1px solid var(--border); }
        .var-tag:hover { border-color: var(--primary); color: var(--primary); }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: 'var(--text)', letterSpacing: '-.01em' }}>
            Automações de Alerta
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text2)' }}>
            Regras para envio automático de notificações por eventos do sistema
          </p>
        </div>
        <button onClick={openNew} style={solidBtn('#6366f1')}>
          <Ico d="M12 5v14 M5 12h14" size={14} /> Nova Automação
        </button>
      </div>

      {/* ── Stats strip ── */}
      {list.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Total', val: list.length },
            { label: 'Ativas', val: list.filter(a => a.ativo).length, color: '#22c55e' },
            { label: 'Disparos hoje', val: list.reduce((s, a) => s + (a.total_disparos || 0), 0) },
          ].map(s => (
            <div key={s.label} style={{
              flex: 1, background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 10, padding: '10px 16px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: s.color || 'var(--text)' }}>{s.val}</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── List ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)', fontSize: 13 }}>Carregando…</div>
      ) : list.length === 0 ? (
        <Empty onNew={openNew} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map(a => {
            return (
              <div key={a.id} className="auto-card" style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '14px 16px',
                transition: 'border-color .15s', opacity: a.ativo ? 1 : .6,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  {/* Toggle */}
                  <div style={{ paddingTop: 2 }}>
                    <Toggle value={a.ativo} onChange={() => toggle(a)} />
                  </div>

                  {/* Main content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{a.nome}</span>
                      <EventBadge tipo={a.tipo_evento} />
                    </div>
                    {a.descricao && (
                      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>{a.descricao}</div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <ChannelPills canais={a.canais} />
                      <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                        Cooldown {a.cooldown_min}min
                      </span>
                      {(a.horario_inicio || a.horario_fim) && (
                        <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                          ⏰ {a.horario_inicio}–{a.horario_fim}
                        </span>
                      )}
                      {a.ultimo_disparo && (
                        <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                          Último: {fmtDate(a.ultimo_disparo)}
                        </span>
                      )}
                      {(a.total_disparos || 0) > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                          {a.total_disparos} disparo{a.total_disparos !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <button className="auto-row-btn" onClick={() => openHist(a)} title="Histórico">
                      <Ico d="M12 8v4l3 3 M12 2a10 10 0 100 20A10 10 0 0012 2z" size={13} />
                    </button>
                    <button className="auto-row-btn" onClick={() => openEdit(a)} title="Editar">
                      <Ico d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" size={13} />
                    </button>
                    <button className="auto-row-btn" onClick={() => del(a)} title="Excluir"
                      style={{ color: '#ef4444' }}>
                      <Ico d="M3 6h18 M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2" size={13} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Slide panel — new/edit ── */}
      {panel !== 'closed' && (
        <>
          <div onClick={() => setPanel('closed')} style={{
            position: 'fixed', inset: 0, background: '#00000055', zIndex: 200,
          }} />
          <div style={{
            position: 'fixed', right: 0, top: 0, bottom: 0, width: 460,
            background: 'var(--surface)', borderLeft: '1px solid var(--border)',
            zIndex: 201, display: 'flex', flexDirection: 'column', overflowY: 'auto',
            animation: 'slideIn .22s ease',
          }}>
            {/* Panel header */}
            <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--text)' }}>
                {panel === 'new' ? 'Nova Automação' : 'Editar Automação'}
              </div>
              <button onClick={() => setPanel('closed')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', padding: 4, lineHeight: 0 }}>
                <Ico d="M18 6L6 18 M6 6l12 12" size={16} />
              </button>
            </div>

            {/* Steps nav */}
            <div style={{ padding: '12px 20px', display: 'flex', gap: 6, alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              {['Evento', 'Condições', 'Canais', 'Mensagem', 'Agendamento'].map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div className="step-dot" onClick={() => setStep(i)} style={{
                    background: step === i ? 'var(--primary)' : step > i ? '#22c55e' : 'var(--surface2)',
                    color: step >= i ? '#fff' : 'var(--text2)',
                    boxShadow: step === i ? '0 0 0 3px var(--primary)22' : undefined,
                  }}>{i + 1}</div>
                  <span style={{ fontSize: 11, color: step === i ? 'var(--primary)' : 'var(--text2)', fontWeight: step === i ? 600 : 400 }}>{s}</span>
                  {i < 4 && <span style={{ color: 'var(--border)', margin: '0 2px' }}>·</span>}
                </div>
              ))}
            </div>

            {/* Step content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

              {/* ── STEP 0: Evento ── */}
              {step === 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <FField label="Nome da Automação" required>
                    <input style={pinp} value={form.nome || ''} onChange={e => setF('nome', e.target.value)} placeholder="ex: Alerta veículo suspeito" />
                  </FField>
                  <FField label="Descrição">
                    <input style={pinp} value={form.descricao || ''} onChange={e => setF('descricao', e.target.value)} placeholder="Opcional" />
                  </FField>
                  <div>
                    <div style={plbl}>Tipo de Evento *</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                      {Object.entries(EVENTOS).map(([k, ev]) => (
                        <button key={k} onClick={() => setF('tipo_evento', k)} style={{
                          padding: '10px 12px', borderRadius: 8, border: `1.5px solid ${form.tipo_evento === k ? ev.color : 'var(--border)'}`,
                          background: form.tipo_evento === k ? `${ev.color}12` : 'var(--surface2)',
                          cursor: 'pointer', textAlign: 'left', transition: 'all .15s',
                        }}>
                          <div style={{ fontSize: 16, marginBottom: 3 }}>{ev.icon}</div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: form.tipo_evento === k ? ev.color : 'var(--text)' }}>{ev.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{ev.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ── STEP 1: Condições ── */}
              {step === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div>
                    <div style={plbl}>Câmeras (deixe vazio para todas)</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {cams.map(c => (
                        <button key={c.id} className={`cam-chip ${selCams.includes(c.id) ? 'sel' : ''}`}
                          onClick={() => setCond('camera_ids', selCams.includes(c.id) ? selCams.filter(x => x !== c.id) : [...selCams, c.id])}>
                          {c.nome}
                        </button>
                      ))}
                    </div>
                  </div>

                  {form.tipo_evento === 'watchlist_hit' && (
                    <>
                      <FField label="Tipos de watchlist (vazio = todos)">
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          {['suspeito', 'roubado', 'bloqueado', 'vip', 'monitorado'].map(t => {
                            const sel = ((cond.tipos as string[]) || []).includes(t)
                            return (
                              <button key={t} className={`cam-chip ${sel ? 'sel' : ''}`}
                                onClick={() => setCond('tipos', sel ? ((cond.tipos as string[]) || []).filter(x => x !== t) : [...((cond.tipos as string[]) || []), t])}>
                                {t}
                              </button>
                            )
                          })}
                        </div>
                      </FField>
                    </>
                  )}

                  {form.tipo_evento === 'pessoa_detectada' && (
                    <FField label="Mínimo de pessoas">
                      <input type="number" min={1} style={pinp}
                        value={(cond.min_pessoas as number) || 1}
                        onChange={e => setCond('min_pessoas', Number(e.target.value))} />
                    </FField>
                  )}

                  {form.tipo_evento === 'camera_offline' && (
                    <FField label="Minutos sem detecção">
                      <input type="number" min={1} style={pinp}
                        value={(cond.minutos_sem_deteccao as number) || 10}
                        onChange={e => setCond('minutos_sem_deteccao', Number(e.target.value))} />
                    </FField>
                  )}

                  <FField label="Cooldown entre alertas (minutos)">
                    <input type="number" min={1} style={pinp}
                      value={form.cooldown_min || 5}
                      onChange={e => setF('cooldown_min', Number(e.target.value))} />
                  </FField>
                </div>
              )}

              {/* ── STEP 2: Canais ── */}
              {step === 2 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {/* Telegram */}
                  <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: form.canais?.telegram ? 8 : 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 18 }}>✈️</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Telegram</div>
                          <div style={{ fontSize: 11, color: 'var(--text2)' }}>Envia para o canal/grupo configurado</div>
                        </div>
                      </div>
                      <Toggle value={!!form.canais?.telegram} onChange={v => setCanal('telegram', v)} />
                    </div>
                  </div>

                  {/* WhatsApp */}
                  <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <span style={{ fontSize: 18 }}>📱</span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>WhatsApp</div>
                        <div style={{ fontSize: 11, color: 'var(--text2)' }}>Adicione os números que receberão o alerta</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      <input style={{ ...pinp, flex: 1 }} placeholder="5565999990001"
                        value={waInput} onChange={e => setWaInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addPhone()} />
                      <button onClick={addPhone} style={solidBtn('#25D366', '7px 12px')}>
                        <Ico d="M12 5v14 M5 12h14" size={13} />
                      </button>
                    </div>
                    {((form.canais?.whatsapp || []) as string[]).map(p => (
                      <div key={p} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 8px', background: 'var(--surface)', borderRadius: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text)' }}>{p}</span>
                        <button onClick={() => removePhone(p)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 2, lineHeight: 0 }}>
                          <Ico d="M18 6L6 18 M6 6l12 12" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── STEP 3: Mensagem ── */}
              {step === 3 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ fontSize: 12, color: 'var(--text2)', padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8 }}>
                    Deixe em branco para usar a mensagem padrão do sistema.
                    Use as variáveis abaixo clicando nelas para inserir.
                  </div>
                  {form.tipo_evento && (
                    <div>
                      <div style={plbl}>Variáveis disponíveis</div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                        {(VARS[form.tipo_evento] || []).map(v => (
                          <button key={v} className="var-tag" onClick={() => setF('mensagem_custom', ((form.mensagem_custom || '') + v) as Automacao['mensagem_custom'])}>
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <FField label="Mensagem personalizada">
                    <textarea style={{ ...pinp, minHeight: 140, resize: 'vertical', fontFamily: 'inherit' }}
                      placeholder="Deixe vazio para mensagem padrão…"
                      value={form.mensagem_custom || ''}
                      onChange={e => setF('mensagem_custom', e.target.value)} />
                  </FField>
                  {form.mensagem_custom && (
                    <div>
                      <div style={plbl}>Prévia</div>
                      <div style={{ marginTop: 6, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--text)', fontFamily: 'monospace' }}>
                        {form.mensagem_custom
                          .replace('{placa}', 'ABC1234').replace('{tipo}', 'SUSPEITO')
                          .replace('{camera}', 'Câmera 01').replace('{confianca}', '98.5')
                          .replace('{total}', '3').replace('{plural}', 'pessoas')
                          .replace('{epi_tipo}', 'capacete').replace('{minutos}', '15')
                          .replace('{hora}', '14:30:00').replace('{data}', '20/04/2026')}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── STEP 4: Agendamento ── */}
              {step === 4 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface2)' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Restringir horário</div>
                      <div style={{ fontSize: 11, color: 'var(--text2)' }}>Só dispara dentro de um intervalo de tempo</div>
                    </div>
                    <Toggle value={schedOn} onChange={setSchedOn} />
                  </div>

                  {schedOn && (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <FField label="Início">
                          <input type="time" style={pinp} value={form.horario_inicio || ''}
                            onChange={e => setF('horario_inicio', e.target.value || null)} />
                        </FField>
                        <FField label="Fim">
                          <input type="time" style={pinp} value={form.horario_fim || ''}
                            onChange={e => setF('horario_fim', e.target.value || null)} />
                        </FField>
                      </div>
                      <div>
                        <div style={plbl}>Dias da semana (vazio = todos)</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          {DIAS.map((d, i) => {
                            const sel = ((form.dias_semana || []) as number[]).includes(i)
                            return (
                              <button key={i} className={`cam-chip ${sel ? 'sel' : ''}`}
                                style={{ padding: '4px 10px' }} onClick={() => toggleDia(i)}>
                                {d}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </>
                  )}

                  {!schedOn && (
                    <div style={{ fontSize: 12, color: 'var(--text2)', textAlign: 'center', padding: '20px 0' }}>
                      Sem restrição — dispara a qualquer hora e dia.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Panel footer */}
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                {saveErr && <span style={{ fontSize: 12, color: '#ef4444' }}>✕ {saveErr}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {step > 0 && (
                  <button onClick={() => setStep(s => s - 1)} style={ghostBtn}>
                    ← Anterior
                  </button>
                )}
                {step < 4 ? (
                  <button onClick={() => setStep(s => s + 1)} style={solidBtn('#6366f1')}>
                    Próximo →
                  </button>
                ) : (
                  <button onClick={save} disabled={saving} style={solidBtn('#22c55e')}>
                    {saving ? 'Salvando…' : panel === 'new' ? '✓ Criar Automação' : '✓ Salvar'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── History modal ── */}
      {histItem && (
        <>
          <div onClick={() => setHistItem(null)} style={{ position: 'fixed', inset: 0, background: '#00000055', zIndex: 300 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            width: 540, maxHeight: '80vh', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 12, zIndex: 301,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--text)' }}>
                Histórico — {histItem.nome}
              </div>
              <button onClick={() => setHistItem(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', lineHeight: 0 }}>
                <Ico d="M18 6L6 18 M6 6l12 12" size={15} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
              {histLoading ? (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text2)', fontSize: 13 }}>Carregando…</div>
              ) : hist.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text2)', fontSize: 13 }}>Nenhum disparo registrado.</div>
              ) : hist.map((h: unknown, i) => {
                const row = h as Record<string, unknown>
                const ctx = (row.contexto || {}) as Record<string, unknown>
                return (
                  <div key={i} style={{ padding: '10px 0', borderBottom: i < hist.length - 1 ? '1px solid var(--border)' : undefined }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {(row.canais_enviados as string[] || []).map(c => (
                          <span key={c} style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 6,
                            color: c.startsWith('whatsapp') ? '#25D366' : '#229ED9',
                            background: c.startsWith('whatsapp') ? '#25D36618' : '#229ED918' }}>
                            {c.startsWith('whatsapp') ? 'WhatsApp' : 'Telegram'}
                          </span>
                        ))}
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                        {fmtDate(row.disparado_em as string)}
                      </span>
                    </div>
                    {ctx.camera ? <div style={{ fontSize: 12, color: 'var(--text2)' }}>📷 {String(ctx.camera)}</div> : null}
                    {ctx.placa   ? <div style={{ fontSize: 12, color: 'var(--text2)' }}>🚗 {String(ctx.placa)}</div> : null}
                    {ctx.total   ? <div style={{ fontSize: 12, color: 'var(--text2)' }}>👥 {Number(ctx.total)} pessoas</div> : null}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ ...plbl, display: 'block', marginBottom: 5 }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const plbl: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--text2)',
  textTransform: 'uppercase', letterSpacing: '.06em',
}

const pinp: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7, fontSize: 13,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', boxSizing: 'border-box', outline: 'none',
}

function solidBtn(bg: string, pad = '7px 16px'): React.CSSProperties {
  return {
    padding: pad, borderRadius: 7, border: 'none', cursor: 'pointer',
    background: bg, color: '#fff', fontSize: 13, fontWeight: 600,
    display: 'inline-flex', alignItems: 'center', gap: 6,
  }
}

const ghostBtn: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)',
  background: 'transparent', cursor: 'pointer', fontSize: 13, color: 'var(--text2)',
}
