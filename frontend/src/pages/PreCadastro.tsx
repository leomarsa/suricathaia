import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import logoSuricatha from '../assets/logo-suricatha.png'
import { formatCpf, validateCpf, normalizeCpf } from '../utils/cpf'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
  document.body.appendChild(ta)
  ta.focus(); ta.select()
  try { document.execCommand('copy'); done() } catch (_) {}
  document.body.removeChild(ta)
}

// ── Estilos base ──────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: '100%', padding: '11px 14px', borderRadius: 10, fontSize: 14,
  border: '1.5px solid #e2e8f0', background: '#fff',
  color: '#0f172a', outline: 'none', boxSizing: 'border-box',
  transition: 'border-color .15s, box-shadow .15s',
}

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode
}) {
  return (
    <div>
      <label style={{
        fontSize: 12, fontWeight: 700, color: '#475569',
        letterSpacing: '.04em', textTransform: 'uppercase',
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
      }}>
        {label}
        {required && <span style={{ color: '#ef4444', fontWeight: 900 }}>*</span>}
        {hint && <span style={{ fontSize: 10, fontWeight: 400, textTransform: 'none', color: '#94a3b8', letterSpacing: 0 }}>{hint}</span>}
      </label>
      {children}
    </div>
  )
}

// ── Foto Picker ───────────────────────────────────────────────────────────────

function FotoPicker({ label: l, hint, icon, value, onChange, capture = 'environment' }: {
  label: string; hint?: string; icon: string; value: File | null
  onChange: (f: File | null) => void; capture?: 'user' | 'environment'
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    if (!value) { setPreview(null); return }
    const url = URL.createObjectURL(value)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [value])

  const isSelfie = capture === 'user'

  return (
    <div>
      <label style={{
        fontSize: 12, fontWeight: 700, color: '#475569',
        letterSpacing: '.04em', textTransform: 'uppercase', display: 'block', marginBottom: 6,
      }}>
        {l}
        {hint && <span style={{ fontSize: 10, fontWeight: 400, textTransform: 'none', color: '#94a3b8', letterSpacing: 0, marginLeft: 6 }}>{hint}</span>}
      </label>
      <div
        onClick={() => ref.current?.click()}
        style={{
          border: `2px dashed ${preview ? '#10b981' : isSelfie ? '#6366f1' : '#cbd5e1'}`,
          borderRadius: 12,
          background: preview ? '#f0fdf4' : isSelfie ? '#f5f3ff' : '#f8fafc',
          cursor: 'pointer', overflow: 'hidden', minHeight: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all .15s',
        }}
      >
        {preview ? (
          <div style={{ position: 'relative', width: '100%' }}>
            <img src={preview} alt=""
              style={{
                width: '100%', maxHeight: 180, objectFit: 'cover', display: 'block',
                ...(isSelfie ? { objectPosition: 'top' } : {}),
              }}
            />
            <button
              onClick={e => { e.stopPropagation(); onChange(null) }}
              style={{
                position: 'absolute', top: 8, right: 8,
                background: '#ef4444', color: '#fff', border: 'none',
                width: 28, height: 28, borderRadius: '50%', cursor: 'pointer',
                fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,.25)',
              }}
            >×</button>
            <div style={{
              position: 'absolute', bottom: 8, left: 8,
              background: 'rgba(16,185,129,.92)', color: '#fff',
              fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
              Foto tirada
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '24px 16px', color: isSelfie ? '#6366f1' : '#94a3b8' }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%',
              background: isSelfie ? 'rgba(99,102,241,.1)' : 'rgba(148,163,184,.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: 26 }}>{icon}</span>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: isSelfie ? '#4f46e5' : '#475569', marginBottom: 3 }}>
                {isSelfie ? '📷 Abrir câmera frontal' : '📷 Abrir câmera'}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                {isSelfie ? 'Posicione seu rosto no centro' : 'Fotografe frente e verso do documento'}
              </div>
            </div>
          </div>
        )}
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture={capture}
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; onChange(f ?? null); e.target.value = '' }}
      />
    </div>
  )
}

// ── Barra de progresso dos steps ──────────────────────────────────────────────

function StepBar({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 28 }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          flex: 1, height: 4, borderRadius: 4,
          background: i < step ? '#10b981' : i === step ? '#6366f1' : '#e2e8f0',
          transition: 'background .3s',
        }} />
      ))}
    </div>
  )
}

// ── Tela de Confirmação ───────────────────────────────────────────────────────

function Confirmacao({ token, nome, empresa, visitado, motivo }: {
  token: string; nome: string; empresa: string; visitado: string; motivo: string
}) {
  const [copied, setCopied] = useState(false)
  const tokenFmt = `${token.slice(0, 4)}-${token.slice(4)}`

  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2500) }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(tokenFmt).then(done).catch(() => fallbackCopy(tokenFmt, done))
    } else {
      fallbackCopy(tokenFmt, done)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: 'linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 50%,#f0f9ff 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        width: '100%', maxWidth: 460, background: '#fff',
        borderRadius: 24, boxShadow: '0 20px 60px rgba(0,0,0,.12)',
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          background: 'linear-gradient(135deg,#10b981,#059669)',
          padding: '32px 28px 28px',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: 'rgba(255,255,255,.2)', border: '2px solid rgba(255,255,255,.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, marginBottom: 16,
          }}>✓</div>
          <div style={{ color: 'rgba(255,255,255,.75)', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Pré-cadastro confirmado!
          </div>
          <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>{nome}</div>
          {empresa && <div style={{ color: 'rgba(255,255,255,.7)', fontSize: 14, marginTop: 6 }}>{empresa}</div>}
        </div>

        <div style={{ padding: '28px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Token */}
          <div style={{
            textAlign: 'center', padding: '24px 20px', borderRadius: 16,
            background: '#f8fafc', border: '2px dashed #e2e8f0',
          }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#64748b',
              letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 12,
            }}>
              Seu código de entrada
            </div>
            <div style={{
              fontSize: 42, fontWeight: 900, color: '#0f172a', lineHeight: 1,
              fontFamily: 'JetBrains Mono, monospace', letterSpacing: '.15em', marginBottom: 16,
            }}>
              {tokenFmt}
            </div>
            <button onClick={copy} style={{
              padding: '9px 24px', borderRadius: 9, border: 'none', cursor: 'pointer',
              background: copied ? '#10b981' : '#0f172a',
              color: '#fff', fontSize: 13, fontWeight: 700, transition: 'background .2s',
            }}>
              {copied ? '✓  Copiado!' : 'Copiar código'}
            </button>
          </div>

          {/* Instrução */}
          <div style={{
            padding: '14px 16px', borderRadius: 12,
            background: '#fffbeb', border: '1px solid #fde68a',
          }}>
            <div style={{ fontSize: 13, color: '#92400e', fontWeight: 700, marginBottom: 6 }}>
              📋 O que fazer ao chegar?
            </div>
            <div style={{ fontSize: 13, color: '#78350f', lineHeight: 1.7 }}>
              Apresente este código ou mostre esta tela para o porteiro. Sua entrada será confirmada rapidamente.
            </div>
          </div>

          {/* Detalhes da visita */}
          {(visitado || motivo) && (
            <div style={{
              padding: '14px 16px', borderRadius: 12,
              background: '#f8fafc', border: '1px solid #e2e8f0',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                Detalhes da visita
              </div>
              {visitado && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 60 }}>Visitar</span>
                  <span style={{ fontSize: 13, color: '#0f172a', fontWeight: 600 }}>{visitado}</span>
                </div>
              )}
              {motivo && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 60 }}>Motivo</span>
                  <span style={{ fontSize: 13, color: '#0f172a' }}>{motivo}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 60 }}>Data</span>
                <span style={{ fontSize: 13, color: '#0f172a' }}>
                  {new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}
                </span>
              </div>
            </div>
          )}

          <button onClick={() => window.location.reload()} style={{
            padding: '12px', borderRadius: 12, border: '1.5px solid #e2e8f0',
            background: '#fff', fontSize: 13, fontWeight: 600, color: '#64748b', cursor: 'pointer',
          }}>
            Fazer novo pré-cadastro
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Formulário principal (3 steps) ───────────────────────────────────────────

type Step = 0 | 1 | 2

export default function PreCadastro() {
  const [step, setStep] = useState<Step>(0)

  const [form, setForm] = useState({
    nome: '', telefone: '', cpf: '', rg: '', cnh: '',
    empresa: '', visitado_texto: '', visitado_setor: '', motivo: '',
  })
  const [fotoRostoFile, setFotoRostoFile] = useState<File | null>(null)
  const [fotoDocFile, setFotoDocFile]     = useState<File | null>(null)
  const [saving, setSaving]               = useState(false)
  const [err, setErr]                     = useState('')
  const [confirmacao, setConfirmacao]     = useState<{
    token: string; nome: string; empresa: string; visitado: string; motivo: string
  } | null>(null)
  const [cpfStatus, setCpfStatus] = useState<'idle'|'checking'|'ok'|'invalid'|'duplicate'>('idle')
  const [cpfDupNome, setCpfDupNome] = useState('')
  const cpfTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Verifica token na URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (token) {
      axios.get(`/api/v1/portaria/publico/confirmacao/${token.toUpperCase()}`)
        .then(r => setConfirmacao({
          token: token.toUpperCase(),
          nome: r.data.visitante_nome,
          empresa: r.data.empresa || '',
          visitado: r.data.visitado_texto || r.data.visitado_nome || '',
          motivo: r.data.motivo || '',
        }))
        .catch(() => {})
    }
  }, [])

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }))

  const onCpfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fmt = formatCpf(e.target.value)
    setForm(p => ({ ...p, cpf: fmt }))
    setCpfStatus('idle'); setCpfDupNome('')
    if (cpfTimer.current) clearTimeout(cpfTimer.current)
    const raw = normalizeCpf(fmt)
    if (raw.length < 11) return
    if (!validateCpf(raw)) { setCpfStatus('invalid'); return }
    setCpfStatus('checking')
    cpfTimer.current = setTimeout(async () => {
      try {
        const r = await axios.get<{ valido: boolean; duplicado: boolean; nome_existente?: string }>(
          '/api/v1/portaria/publico/check-cpf', { params: { cpf: raw } }
        )
        if (!r.data.valido) { setCpfStatus('invalid'); return }
        if (r.data.duplicado) { setCpfStatus('duplicate'); setCpfDupNome(r.data.nome_existente || ''); return }
        setCpfStatus('ok')
      } catch { setCpfStatus('idle') }
    }, 600)
  }

  const focusStyle = (color = '#10b981') => ({
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
      e.target.style.borderColor = color
      e.target.style.boxShadow = `0 0 0 3px ${color}20`
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
      e.target.style.borderColor = '#e2e8f0'
      e.target.style.boxShadow = 'none'
    },
  })

  const nextStep = () => {
    if (step === 0) {
      if (!form.nome.trim())          { setErr('Nome completo é obrigatório'); return }
      if (!form.telefone.trim())      { setErr('Telefone é obrigatório'); return }
      if (!form.rg.trim())            { setErr('RG é obrigatório'); return }
      if (!form.cpf.trim())           { setErr('CPF é obrigatório'); return }
      if (cpfStatus === 'invalid')    { setErr('CPF inválido — verifique os dígitos'); return }
      if (cpfStatus === 'duplicate')  { setErr(`CPF já cadastrado${cpfDupNome ? ` para: ${cpfDupNome}` : ''}. Entre em contato com a recepção.`); return }
      if (cpfStatus === 'checking')   { setErr('Aguarde a verificação do CPF'); return }
    }
    setErr('')
    setStep((step + 1) as Step)
  }

  const prevStep = () => setStep((step - 1) as Step)

  const submit = async () => {
    if (!form.nome.trim()) { setErr('Nome é obrigatório'); return }
    setSaving(true); setErr('')
    try {
      const r = await axios.post('/api/v1/portaria/publico/pre-cadastro', {
        nome:           form.nome.trim(),
        telefone:       form.telefone.trim() || null,
        cpf:            normalizeCpf(form.cpf) || null,
        rg:             form.rg.trim() || null,
        cnh:            form.cnh.trim() || null,
        empresa:        form.empresa.trim() || null,
        visitado_texto: form.visitado_texto.trim() || null,
        visitado_setor: form.visitado_setor.trim() || null,
        motivo:         form.motivo.trim() || null,
      })
      const { token } = r.data

      const uploads: Promise<void>[] = []
      if (fotoRostoFile) {
        const fd = new FormData(); fd.append('foto', fotoRostoFile)
        uploads.push(axios.post(`/api/v1/portaria/publico/upload/rosto/${token}`, fd).then(() => {}))
      }
      if (fotoDocFile) {
        const fd = new FormData(); fd.append('foto', fotoDocFile)
        uploads.push(axios.post(`/api/v1/portaria/publico/upload/documento/${token}`, fd).then(() => {}))
      }
      await Promise.allSettled(uploads)

      setConfirmacao({
        token,
        nome: form.nome.trim(),
        empresa: form.empresa.trim(),
        visitado: [form.visitado_texto.trim(), form.visitado_setor.trim()].filter(Boolean).join(' · '),
        motivo: form.motivo.trim(),
      })
    } catch (e: unknown) {
      const ax = e as { response?: { data?: { detail?: string } } }
      setErr(ax.response?.data?.detail || 'Erro ao enviar. Tente novamente.')
    } finally { setSaving(false) }
  }

  if (confirmacao) {
    return (
      <Confirmacao
        token={confirmacao.token} nome={confirmacao.nome}
        empresa={confirmacao.empresa} visitado={confirmacao.visitado} motivo={confirmacao.motivo}
      />
    )
  }

  const STEP_LABELS = ['Seus dados', 'Sobre a visita', 'Fotos']

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(160deg,#f8fafc 0%,#f0f9ff 40%,#faf5ff 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '32px 16px 64px',
    }}>

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 32, maxWidth: 480 }}>
        <img src={logoSuricatha} alt="SuricathaIA" style={{ height: 38, marginBottom: 16, opacity: .85 }} />
        <div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', lineHeight: 1.2, marginBottom: 8 }}>
          Pré-cadastro de Visita
        </div>
        <div style={{ fontSize: 14, color: '#64748b', lineHeight: 1.6 }}>
          Cadastre-se antes de chegar. Na recepção, sua entrada será confirmada com um clique.
        </div>
      </div>

      {/* Card */}
      <div style={{
        width: '100%', maxWidth: 520, background: '#fff',
        borderRadius: 24, boxShadow: '0 8px 48px rgba(0,0,0,.09)',
        padding: '32px 32px 36px',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{
            fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
            color: step === 0 ? '#10b981' : step === 1 ? '#6366f1' : '#f59e0b',
          }}>
            Passo {step + 1} de 3 · {STEP_LABELS[step]}
          </span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{step + 1}/3</span>
        </div>
        <StepBar step={step} total={3} />

        {/* Error */}
        {err && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 20,
            background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca',
          }}>{err}</div>
        )}

        {/* ── Step 0: Dados pessoais ── */}
        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <Field label="Nome completo" required>
              <input value={form.nome} onChange={set('nome')}
                placeholder="Seu nome e sobrenome" style={inp}
                autoFocus
                {...focusStyle('#10b981')} />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field
                label="CPF"
                required
                hint={
                  cpfStatus === 'checking'  ? '⟳ verificando…' :
                  cpfStatus === 'ok'        ? '✓ disponível'    :
                  cpfStatus === 'invalid'   ? '✗ inválido'      :
                  cpfStatus === 'duplicate' ? '✗ já cadastrado' : undefined
                }
              >
                <input
                  value={form.cpf}
                  onChange={onCpfChange}
                  placeholder="000.000.000-00"
                  inputMode="numeric"
                  style={{
                    ...inp,
                    borderColor: cpfStatus === 'ok' ? '#10b981' : cpfStatus === 'invalid' || cpfStatus === 'duplicate' ? '#ef4444' : undefined,
                    boxShadow:   cpfStatus === 'ok' ? '0 0 0 3px #10b98120' : cpfStatus === 'invalid' || cpfStatus === 'duplicate' ? '0 0 0 3px #ef444420' : undefined,
                  }}
                />
                {cpfStatus === 'duplicate' && cpfDupNome && (
                  <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>
                    Cadastrado como: <strong>{cpfDupNome}</strong>. Entre em contato com a recepção.
                  </div>
                )}
              </Field>
              <Field label="RG" required>
                <input value={form.rg} onChange={set('rg')}
                  placeholder="00.000.000-0" style={inp}
                  {...focusStyle('#10b981')} />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="CNH" hint="opcional">
                <input value={form.cnh} onChange={set('cnh')}
                  placeholder="00000000000" style={inp}
                  inputMode="numeric"
                  {...focusStyle('#10b981')} />
              </Field>
              <Field label="Telefone / WhatsApp" required>
                <input value={form.telefone} onChange={set('telefone')}
                  placeholder="(65) 99999-0000" style={inp}
                  inputMode="tel"
                  {...focusStyle('#10b981')} />
              </Field>
            </div>

            <Field label="Empresa / Organização" hint="opcional">
              <input value={form.empresa} onChange={set('empresa')}
                placeholder="Ex: ACME Ltda" style={inp}
                {...focusStyle('#10b981')} />
            </Field>

            <button onClick={nextStep} style={{
              marginTop: 8, padding: '13px', borderRadius: 12, border: 'none',
              background: 'linear-gradient(135deg,#10b981,#059669)',
              color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              boxShadow: '0 4px 16px rgba(16,185,129,.3)',
            }}>
              Próximo
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
          </div>
        )}

        {/* ── Step 1: Informações da visita ── */}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 12 }}>
              <Field label="Quem você vai visitar" hint="opcional">
                <input value={form.visitado_texto} onChange={set('visitado_texto')}
                  placeholder="Nome do funcionário" style={inp}
                  autoFocus
                  {...focusStyle('#6366f1')} />
              </Field>
              <Field label="Departamento / Setor" hint="opcional">
                <input value={form.visitado_setor} onChange={set('visitado_setor')}
                  placeholder="RH, TI, Financeiro…" style={inp}
                  {...focusStyle('#6366f1')} />
              </Field>
            </div>

            <Field label="Motivo da visita" hint="opcional">
              <input value={form.motivo} onChange={set('motivo')}
                placeholder="Reunião, entrega, assistência técnica, entrevista…" style={inp}
                {...focusStyle('#6366f1')} />
            </Field>

            {/* Resumo do step 0 */}
            <div style={{
              padding: '12px 16px', borderRadius: 12,
              background: '#f0fdf4', border: '1px solid #bbf7d0',
              fontSize: 13, color: '#065f46',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>✓ {form.nome}</div>
              <div style={{ fontSize: 12, color: '#059669' }}>
                {[
                  form.cpf && `CPF ${form.cpf}`,
                  form.rg && `RG ${form.rg}`,
                  form.telefone,
                  form.empresa,
                ].filter(Boolean).join(' · ') || 'Dados pessoais preenchidos'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button onClick={prevStep} style={{
                flex: 1, padding: '12px', borderRadius: 12,
                border: '1.5px solid #e2e8f0', background: '#fff',
                color: '#64748b', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}>
                ← Voltar
              </button>
              <button onClick={nextStep} style={{
                flex: 2, padding: '12px', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
                color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                boxShadow: '0 4px 16px rgba(99,102,241,.3)',
              }}>
                Próximo
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Fotos ── */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: '#fefce8', border: '1px solid #fde68a',
              fontSize: 12, color: '#92400e', lineHeight: 1.6,
            }}>
              <strong>Dica:</strong> Uma selfie e foto do documento agilizam sua identificação na chegada.
              As fotos são opcionais.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <FotoPicker
                label="Sua foto (selfie)" hint="opcional"
                icon="🤳" value={fotoRostoFile} onChange={setFotoRostoFile}
                capture="user"
              />
              <FotoPicker
                label="Documento (RG/CNH)" hint="opcional"
                icon="🪪" value={fotoDocFile} onChange={setFotoDocFile}
                capture="environment"
              />
            </div>

            {/* Resumo final */}
            <div style={{
              padding: '14px 16px', borderRadius: 12,
              background: '#f8fafc', border: '1px solid #e2e8f0',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 4 }}>
                Resumo do cadastro
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{form.nome}</div>
              {form.empresa && <div style={{ fontSize: 12, color: '#475569' }}>{form.empresa}</div>}
              {(form.visitado_texto || form.visitado_setor) && (
                <div style={{ fontSize: 12, color: '#6366f1', marginTop: 2 }}>
                  → {[form.visitado_texto, form.visitado_setor].filter(Boolean).join(' · ')}
                </div>
              )}
              {form.motivo && <div style={{ fontSize: 12, color: '#94a3b8' }}>{form.motivo}</div>}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button onClick={prevStep} style={{
                flex: 1, padding: '12px', borderRadius: 12,
                border: '1.5px solid #e2e8f0', background: '#fff',
                color: '#64748b', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}>
                ← Voltar
              </button>
              <button onClick={submit} disabled={saving} style={{
                flex: 2, padding: '13px', borderRadius: 12, border: 'none',
                background: saving ? '#94a3b8' : 'linear-gradient(135deg,#f59e0b,#d97706)',
                color: '#fff', fontSize: 14, fontWeight: 700,
                cursor: saving ? 'wait' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                boxShadow: saving ? 'none' : '0 4px 16px rgba(245,158,11,.35)',
              }}>
                {saving ? (
                  <>
                    <div style={{
                      width: 16, height: 16, borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,.4)', borderTopColor: '#fff',
                      animation: 'spin .7s linear infinite',
                    }} />
                    Enviando…
                  </>
                ) : (
                  <>
                    Concluir pré-cadastro ✓
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 24, textAlign: 'center', fontSize: 11, color: '#94a3b8', maxWidth: 400 }}>
        Seus dados são utilizados exclusivamente para controle de acesso e segurança desta instituição.
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
