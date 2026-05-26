export type Perfil = 'admin' | 'gerente' | 'operador' | 'viewer'

export interface Operador {
  nome:   string
  email:  string
  perfil: Perfil
  avatar?: string | null
}

export interface Permissions {
  cameras:   { read: boolean; create: boolean; edit: boolean; delete: boolean; test: boolean }
  watchlist: { read: boolean; create: boolean; delete: boolean }
  sistema:   { read: boolean; test: boolean }
  usuarios:  { read: boolean; create: boolean; edit: boolean; delete: boolean; resetSenha: boolean }
  portaria:  { read: boolean; write: boolean }
}

// Permissões do admin são sempre completas e imutáveis
const ADMIN_PERMS: Permissions = {
  cameras:   { read:true, create:true,  edit:true,  delete:true,  test:true  },
  watchlist: { read:true, create:true,  delete:true  },
  sistema:   { read:true, test:true  },
  usuarios:  { read:true, create:true,  edit:true,  delete:true,  resetSenha:true  },
  portaria:  { read:true, write:true },
}

// Permissões padrão (usadas se não houver configuração salva)
const DEFAULT_PERM_MAP = {
  gerente: {
    watchlist_ver:    true,
    watchlist_editar: true,
    cameras_ver:      true,
    cameras_crud:     true,
    cameras_testar:   true,
    sistema:          true,
    usuarios:         false,
    portaria_ver:     true,
    portaria_editar:  true,
  },
  operador: {
    watchlist_ver:    true,
    watchlist_editar: true,
    cameras_ver:      true,
    cameras_crud:     false,
    cameras_testar:   true,
    sistema:          true,
    usuarios:         false,
    portaria_ver:     true,
    portaria_editar:  true,
  },
  viewer: {
    watchlist_ver:    true,
    watchlist_editar: false,
    cameras_ver:      true,
    cameras_crud:     false,
    cameras_testar:   false,
    sistema:          true,
    usuarios:         false,
    portaria_ver:     true,
    portaria_editar:  false,
  },
}

export type PermMap = typeof DEFAULT_PERM_MAP

// Converte o mapa chave→bool em objeto Permissions estruturado
export function permMapToPermissions(map: PermMap[keyof PermMap]): Permissions {
  return {
    cameras: {
      read:   map.cameras_ver,
      create: map.cameras_crud,
      edit:   map.cameras_crud,
      delete: map.cameras_crud,
      test:   map.cameras_testar,
    },
    watchlist: {
      read:   map.watchlist_ver,
      create: map.watchlist_editar,
      delete: map.watchlist_editar,
    },
    sistema: {
      read: map.sistema,
      test: map.sistema,
    },
    usuarios: {
      read:       map.usuarios,
      create:     map.usuarios,
      edit:       map.usuarios,
      delete:     map.usuarios,
      resetSenha: map.usuarios,
    },
    portaria: {
      read:  map.portaria_ver,
      write: map.portaria_editar,
    },
  }
}

export function getPermMap(): PermMap {
  try {
    const raw = localStorage.getItem('perm_matrix')
    if (raw) return JSON.parse(raw) as PermMap
  } catch { /* use default */ }
  return DEFAULT_PERM_MAP
}

export function savePermMap(map: PermMap): void {
  localStorage.setItem('perm_matrix', JSON.stringify(map))
}

function getOperador(): Operador | null {
  try {
    const raw = localStorage.getItem('operador')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function useAuth() {
  const op     = getOperador()
  const perfil = (op?.perfil ?? 'viewer') as Perfil

  let can: Permissions
  if (perfil === 'admin') {
    can = ADMIN_PERMS
  } else {
    const map = getPermMap()
    const entry = map[perfil as 'operador' | 'viewer'] ?? DEFAULT_PERM_MAP.viewer
    can = permMapToPermissions(entry)
  }

  return { op, perfil, can, isAdmin: perfil === 'admin', isGerente: perfil === 'gerente' }
}
