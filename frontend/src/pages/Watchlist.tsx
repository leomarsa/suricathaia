import { useEffect, useState } from 'react'
import { getWatchlist, addWatchlist, removeWatchlist, type WatchlistItem } from '../api'
import { format } from 'date-fns'
import { useAuth } from '../hooks/useAuth'

const TIPOS = ['suspeito','roubado','bloqueado','vip','monitorado']
const TIPO_COLOR: Record<string,string> = {
  suspeito:'badge-yellow', roubado:'badge-red', bloqueado:'badge-red',
  vip:'badge-blue', monitorado:'badge-gray'
}

export default function Watchlist() {
  const [items, setItems]     = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState(false)
  const [form, setForm]       = useState({ placa:'', tipo:'suspeito', descricao:'', prioridade:3 })
  const [saving, setSaving]   = useState(false)
  const [search, setSearch]   = useState('')
  const { can } = useAuth()

  const load = async () => {
    setLoading(true)
    try { const r = await getWatchlist(); setItems(r.data) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    if (form.placa.length !== 7) return alert('Placa deve ter exatamente 7 caracteres')
    setSaving(true)
    try {
      await addWatchlist({ ...form, placa: form.placa.toUpperCase() })
      setModal(false)
      setForm({ placa:'', tipo:'suspeito', descricao:'', prioridade:3 })
      load()
    } catch(e: unknown) {
      alert((e as {response?:{data?:{detail?:string}}}).response?.data?.detail || 'Erro ao adicionar')
    } finally { setSaving(false) }
  }

  const remove = async (placa: string) => {
    if (!confirm(`Remover ${placa} da watchlist?`)) return
    await removeWatchlist(placa); load()
  }

  const filtered = items.filter(i =>
    !search || i.placa.includes(search.toUpperCase()) || i.tipo.includes(search.toLowerCase())
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Watchlist</div>
          <div className="page-subtitle">{items.length} placa(s) monitorada(s)</div>
        </div>
        {can.watchlist.create && (
          <button className="btn btn-primary" onClick={() => setModal(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Adicionar Placa
          </button>
        )}
      </div>

      <div className="card mb-16">
        <input className="form-input" style={{ maxWidth:280 }}
          placeholder="🔍  Buscar placa ou tipo..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Placa</th><th>Tipo</th><th>Prioridade</th>
                  <th>Descrição</th><th>Adicionado</th>
                  {can.watchlist.delete && <th>Ação</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => (
                  <tr key={item.id}>
                    <td className="font-mono" style={{ fontWeight:700, fontSize:16, letterSpacing:1 }}>
                      {item.placa}
                    </td>
                    <td>
                      <span className={`badge ${TIPO_COLOR[item.tipo]||'badge-gray'}`}>
                        {item.tipo}
                      </span>
                    </td>
                    <td>
                      <span style={{ color:'var(--warning)', fontSize:13 }}>
                        {'★'.repeat(item.prioridade)}{'☆'.repeat(5-item.prioridade)}
                      </span>
                    </td>
                    <td style={{ color:'var(--text2)', fontSize:12 }}>{item.descricao || '—'}</td>
                    <td style={{ fontSize:11, color:'var(--text2)', whiteSpace:'nowrap' }}>
                      {format(new Date(item.criado_em),'dd/MM/yy HH:mm')}
                    </td>
                    {can.watchlist.delete && (
                      <td>
                        <button className="btn btn-danger btn-sm" onClick={() => remove(item.placa)}>
                          Remover
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state" style={{ padding:'32px 0' }}>
                        <div className="empty-state-icon">🛡️</div>
                        <div>Nenhuma placa na watchlist</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal */}
      {can.watchlist.create && modal && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setModal(false)}>
          <div className="modal">
            <div className="modal-title">Adicionar à Watchlist</div>
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <div className="form-group">
                <label className="form-label">Placa (7 caracteres) *</label>
                <input
                  className="form-input font-mono"
                  style={{ fontSize:22, letterSpacing:4, textTransform:'uppercase', textAlign:'center', height:52 }}
                  maxLength={7}
                  placeholder="ABC1D23"
                  value={form.placa}
                  onChange={e => setForm(p=>({...p,placa:e.target.value.toUpperCase()}))}
                />
                <div style={{ fontSize:11, color: form.placa.length === 7 ? 'var(--success)' : 'var(--text3)', textAlign:'center' }}>
                  {form.placa.length}/7 caracteres
                </div>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Tipo</label>
                  <select className="form-input" value={form.tipo}
                    onChange={e => setForm(p=>({...p,tipo:e.target.value}))}>
                    {TIPOS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Prioridade (1–5)</label>
                  <input className="form-input" type="number" min={1} max={5}
                    value={form.prioridade}
                    onChange={e => setForm(p=>({...p,prioridade:+e.target.value}))} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Descrição</label>
                <input className="form-input" placeholder="Ex: Veículo furtado em 15/01/2024"
                  value={form.descricao}
                  onChange={e => setForm(p=>({...p,descricao:e.target.value}))} />
              </div>
              <div style={{ display:'flex', gap:12, marginTop:4 }}>
                <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => setModal(false)}>
                  Cancelar
                </button>
                <button className="btn btn-primary" style={{ flex:1 }} onClick={save}
                  disabled={saving || form.placa.length !== 7}>
                  {saving ? <><span className="spinner" style={{width:14,height:14}}/> Adicionando...</> : 'Adicionar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
