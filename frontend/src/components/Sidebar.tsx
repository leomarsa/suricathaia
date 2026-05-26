import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth, type Perfil } from '../hooks/useAuth'
import logoSuricatha from '../assets/logo-suricatha.png'

// ── Icon ─────────────────────────────────────────────────────────────────────

function Icon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  )
}

// ── Nav structure ─────────────────────────────────────────────────────────────

type NavItem = {
  path: string
  label: string
  icon: string
  allowedRoles?: Perfil[]
  viewerBlock?: boolean
}

type NavGroup = {
  id: string
  label: string | null
  items: NavItem[]
  viewerBlock?: boolean
  adminOnly?: boolean
}

const NAV: NavGroup[] = [
  {
    id: 'home',
    label: null,
    items: [
      { path: '/',        label: 'Dashboard', icon: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10' },
      { path: '/portaria', label: 'Portaria',  icon: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M8 22v-5h8v5 M12 3v4 M9 7h6' },
    ],
  },
  {
    id: 'seguranca',
    label: 'Segurança',
    items: [
      { path: '/cctv',      label: 'Play CCTV',   icon: 'M23 7l-7 5 7 5V7z M1 5h14a2 2 0 012 2v10a2 2 0 01-2 2H1a2 2 0 01-2-2V7a2 2 0 012-2z' },
      { path: '/alarme',    label: 'Alarme CCTV', icon: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0 M12 2v1' },
      { path: '/watchlist', label: 'Watchlist',   icon: 'M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11', viewerBlock: true },
    ],
  },
  {
    id: 'inteligencia',
    label: 'Inteligência',
    items: [
      { path: '/deteccoes',  label: 'Leitura LPR',  icon: 'M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z' },
      { path: '/pessoas',    label: 'Pessoas',       icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z' },
      { path: '/epi',        label: 'EPI / PPE',     icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
      { path: '/telemetria', label: 'Telemétrica',   icon: 'M1 3h4l2.68 13.39a2 2 0 001.97 1.61h9.72a2 2 0 001.97-1.61L23 6H6', allowedRoles: ['admin', 'gerente'] },
    ],
  },
  {
    id: 'analise',
    label: 'Análise',
    items: [
      { path: '/analytics',  label: 'Analytics',   icon: 'M18 20V10 M12 20V4 M6 20v-6' },
      { path: '/relatorios', label: 'Relatórios',  icon: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8' },
    ],
  },
  {
    id: 'automacoes',
    label: 'Automações',
    viewerBlock: true,
    items: [
      { path: '/automacoes', label: 'Automações', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
      { path: '/whatsapp',   label: 'WhatsApp',   icon: 'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z' },
      { path: '/telegram',   label: 'Telegram',   icon: 'M22 2L11 13 M22 2L15 22l-4-9-9-4 22-7z' },
    ],
  },
  {
    id: 'config',
    label: 'Configuração',
    viewerBlock: true,
    items: [
      { path: '/cameras',       label: 'Câmeras',       icon: 'M23 7l-7 5 7 5V7z M1 5h14a2 2 0 012 2v10a2 2 0 01-2 2H1a2 2 0 01-2-2V7a2 2 0 012-2z' },
      { path: '/api-intelbras', label: 'Intelbras API', icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4' },
      { path: '/api-hikvision', label: 'Hikvision API', icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4' },
    ],
  },
  {
    id: 'admin',
    label: 'Administração',
    adminOnly: true,
    items: [
      { path: '/usuarios', label: 'Usuários',    icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75' },
      { path: '/sistema',  label: 'Sistema',     icon: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z' },
    ],
  },
]

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador', gerente: 'Gerente', operador: 'Operador', viewer: 'Visualizador',
}

function getInitials(nome: string) {
  return nome.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase() || '?'
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

interface SidebarProps {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  navBadges?: Record<string, string>
}

export default function Sidebar({ theme, onToggleTheme, navBadges = {} }: SidebarProps) {
  const loc  = useLocation()
  const nav  = useNavigate()
  const { op, perfil, isAdmin } = useAuth()

  // Rail (collapsed) mode
  const [rail, setRail] = useState(() => localStorage.getItem('sb_rail') === '1')

  // Collapsed groups (set of group ids)
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('sb_closed') || '[]')) }
    catch { return new Set() }
  })

  // Group item heights for animation
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Apply rail mode to DOM so CSS vars cascade
  useEffect(() => {
    if (rail) document.documentElement.setAttribute('data-sidebar-rail', '')
    else document.documentElement.removeAttribute('data-sidebar-rail')
    localStorage.setItem('sb_rail', rail ? '1' : '0')
  }, [rail])

  // Ensure active group is always visible
  useEffect(() => {
    for (const g of NAV) {
      if (g.items.some(i => i.path === loc.pathname)) {
        setClosedGroups(prev => {
          if (!prev.has(g.id)) return prev
          const next = new Set(prev); next.delete(g.id)
          return next
        })
        break
      }
    }
  }, [loc.pathname])

  const toggleGroup = (id: string) => {
    setClosedGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      localStorage.setItem('sb_closed', JSON.stringify([...next]))
      return next
    })
  }

  const logout = () => {
    localStorage.removeItem('api_key')
    localStorage.removeItem('operador')
    nav('/login')
  }

  const name = op?.nome || ''

  return (
    <aside className="sidebar">

      {/* ── Brand ──────────────────────────────────────────────────────────── */}
      <div className="sidebar-brand">
        <img src={logoSuricatha} alt="SuricathaIA" className="sidebar-brand-logo" />
        <div className="sidebar-brand-mark">S</div>
      </div>

      {/* ── Nav ────────────────────────────────────────────────────────────── */}
      <nav className="sidebar-nav">
        {NAV.map((group, gi) => {
          // Permission gates
          if (group.adminOnly && !isAdmin) return null
          if (group.viewerBlock && perfil === 'viewer') return null

          const visibleItems = group.items.filter(item => {
            if (item.viewerBlock && perfil === 'viewer') return false
            if (item.allowedRoles && !item.allowedRoles.includes(perfil)) return false
            return true
          })
          if (visibleItems.length === 0) return null

          const isClosed = closedGroups.has(group.id)
          const hasActiveBadge = visibleItems.some(i => navBadges[i.path])
          const groupHeight = groupRefs.current[group.id]?.scrollHeight

          return (
            <div key={group.id}>
              {gi > 0 && <div className="nav-section-divider" />}

              {/* Group header (only for named groups, not in rail mode) */}
              {group.label && (
                <div
                  className="nav-group-header"
                  onClick={() => toggleGroup(group.id)}
                >
                  <span className="nav-section-label nav-label">{group.label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {isClosed && hasActiveBadge && (
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
                    )}
                    <svg
                      className={`nav-group-arrow${isClosed ? ' closed' : ''}`}
                      width={11} height={11} viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M18 15l-6-6-6 6" />
                    </svg>
                  </div>
                </div>
              )}

              {/* Group items */}
              <div
                className={`nav-group-items${group.label && isClosed ? ' closed' : ''}`}
                ref={el => { groupRefs.current[group.id] = el }}
                style={group.label && isClosed ? { maxHeight: 0 } : { maxHeight: groupHeight || 999 }}
              >
                {visibleItems.map(item => {
                  const active = loc.pathname === item.path
                  const badgeColor = !active ? navBadges[item.path] : undefined

                  return (
                    <button
                      key={item.path}
                      className={`nav-item${active ? ' active' : ''}`}
                      onClick={() => nav(item.path)}
                      title={rail ? item.label : undefined}
                    >
                      <span style={{ position: 'relative', lineHeight: 0, flexShrink: 0 }}>
                        <Icon d={item.icon} size={15} />
                        {badgeColor && (
                          <span style={{
                            position: 'absolute', top: -2, right: -3,
                            width: 6, height: 6, borderRadius: '50%',
                            background: badgeColor,
                            border: '1.5px solid var(--sidebar-bg)',
                            display: 'block',
                          }} />
                        )}
                      </span>
                      <span className="nav-label" style={{ flex: 1 }}>{item.label}</span>
                      {badgeColor && (
                        <span className="nav-label" style={{ width: 5, height: 5, borderRadius: '50%', background: badgeColor, flexShrink: 0, opacity: .7 }} />
                      )}
                      {/* Tooltip shown in rail mode via CSS */}
                      <span className="nav-tooltip">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div className="sidebar-footer">

        {/* User card */}
        {op && (
          <button
            className={`sidebar-user-btn${loc.pathname === '/perfil' ? ' active' : ''}`}
            onClick={() => nav('/perfil')}
            title={rail ? name : undefined}
          >
            <div className="sidebar-avatar">
              {op.avatar
                ? <img src={op.avatar} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : getInitials(name)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sidebar-user-name">{name}</div>
              <div className="sidebar-user-role">{ROLE_LABEL[perfil] ?? perfil}</div>
            </div>
            <svg className="sidebar-rail-hide" width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="rgba(148,163,184,.4)" strokeWidth="2" strokeLinecap="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        )}

        {/* Actions */}
        <div className="sidebar-actions">

          {/* Collapse toggle */}
          <button
            className="sidebar-action-btn"
            onClick={() => setRail(r => !r)}
            title={rail ? 'Expandir menu' : 'Recolher menu'}
            style={{ flex: rail ? 1 : '0 0 34px', minWidth: 0 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: rail ? 'rotate(180deg)' : 'none', transition: 'transform .22s' }}
            >
              <path d={rail ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'} />
            </svg>
            <span>{rail ? '' : 'Recolher'}</span>
          </button>

          {/* Theme toggle */}
          <button
            className="sidebar-action-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          >
            {theme === 'dark' ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
                <span>Claro</span>
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
                </svg>
                <span>Escuro</span>
              </>
            )}
          </button>

          {/* Logout */}
          <button className="sidebar-action-btn danger" onClick={logout} title="Sair">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9"/>
            </svg>
            <span>Sair</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
