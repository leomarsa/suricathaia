import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL ?? ''

const api = axios.create({ baseURL: BASE })

api.interceptors.request.use(cfg => {
  const key = localStorage.getItem('api_key')
  if (key) cfg.headers.Authorization = `Bearer ${key}`
  return cfg
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('api_key')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

// ── Types ─────────────────────────────────────────────────────────────────────
export interface Deteccao {
  id: number
  uuid: string
  camera_id: number
  camera_nome: string
  placa: string | null
  confianca_final: number
  validado: boolean
  divergencia: boolean
  watchlist_hit: boolean
  watchlist_tipo: string | null
  arquivo_original: string
  caminho_storage: string | null
  crop_url: string | null
  tempo_processo_ms: number
  detectado_em: string
  erro: string | null
  fonte: string | null
}

export interface CameraLprActivity {
  id: number
  nome: string
  local: string
  ativa: boolean
  ultima_imagem_sftp: string | null
  total_imagens_sftp: number
  deteccoes_1h: number
  deteccoes_24h: number
  alertas_24h: number
}

export interface Camera {
  id: number
  uuid: string
  nome: string
  local: string
  descricao: string | null
  // Localização
  latitude: number | null
  longitude: number | null
  // Hardware
  fabricante: string | null
  modelo: string | null
  numero_serie: string | null
  // Stream
  url_base: string | null
  url_stream: string | null
  resolucao: string | null
  fps: number | null
  protocolo: string
  // SFTP
  ip_sftp: string | null
  porta_sftp: number
  usuario_sftp: string | null
  pasta_upload: string | null
  prefixo_arquivo: string | null
  faixa_horaria: string | null
  sftp_provisioned: boolean
  // Pillar LPR
  rec_lpr: boolean
  beep_lpr: boolean
  rec_deteccao_unica: boolean
  janela_dedup_seg: number
  intervalo_captura_seg: number
  tipo: string
  sentido: string
  // Pillar EPI
  rec_epi: boolean
  zona_interesse: string | null
  // Pillar Contagem
  rec_contagem_pessoas: boolean
  limite_pessoas: number | null
  // Status
  ativa: boolean
  status_conexao: string
  ultima_deteccao: string | null
  total_deteccoes: number
  observacoes: string | null
  // HTTP API credentials
  usuario_camera: string | null
  senha_camera:   string | null
  porta_http:     number
  https_camera:   boolean
  // Fonte LPR
  protocolo_lpr:  string
}

export interface SftpCredentials {
  ok: boolean
  username: string
  password: string
}

export interface CameraProvisionResult extends Camera {
  sftp_usuario: string
  sftp_senha: string
  sftp_home: string
  sftp_pilares: string[]
  sftp_avisos?: string[]
  rtmp_url?: string
}

export interface WatchlistItem {
  id: number
  placa: string
  tipo: string
  descricao: string | null
  prioridade: number
  ativa: boolean
  alerta_sonoro: boolean
  criado_em: string
}

export interface Stats {
  total_24h:          number
  total_1h:           number
  validadas_24h:      number
  watchlist_hits_24h: number
  divergencias_24h:   number
  tempo_medio_ms:     number
}

export interface AnalyticsResumo {
  camera_id: number
  camera_nome: string
  camera_local: string
  rec_lpr: boolean
  lpr_deteccoes_24h: number
  lpr_alertas_24h: number
  rec_contagem_pessoas: boolean
  pessoas_total_24h: number
  pessoas_pico_24h: number
  rec_epi: boolean
  epi_eventos_24h: number
  epi_violacoes_24h: number
  epi_conformidade_media: number
}

export interface SystemStatus {
  saude: string
  timestamp: string
  falhas: string[]
  componentes: {
    banco: Record<string, unknown>
    fila: Record<string, unknown>
    modelos: Record<string, unknown>
    armazenamento: Record<string, unknown>
    alertas: Record<string, unknown>
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────
export const getDeteccoes = (params = {}) =>
  api.get<{ total: number; data: Deteccao[] }>('/api/v1/deteccoes', { params })

export const getDeteccaoStats = () =>
  api.get<Stats>('/api/v1/deteccoes/stats')

export interface LprTimelineRow {
  ts: string
  total: number
  com_placa: number
  watchlist: number
  validadas: number
  divergencias: number
  confianca_media: number
}

export const getLprTimeline = (params: { periodo?: string; camera_id?: number } = {}) =>
  api.get<{ periodo: string; pico_leituras: number; data: LprTimelineRow[] }>(
    '/api/v1/deteccoes/timeline', { params }
  )

export const getCameras = () =>
  api.get<{ total: number; data: Camera[] }>('/api/v1/cameras')

export const getCamera = (id: number) =>
  api.get<Camera>(`/api/v1/cameras/${id}`)

export const createCamera = (data: Partial<Camera>) =>
  api.post<CameraProvisionResult>('/api/v1/cameras', data)

export const updateCamera = (id: number, data: Partial<Camera>) =>
  api.patch<Camera>(`/api/v1/cameras/${id}`, data)

export const deleteCamera = (id: number) =>
  api.delete(`/api/v1/cameras/${id}`)

export const testCamera = (id: number) =>
  api.post(`/api/v1/cameras/${id}/test`)

export const testConnection = (ip: string, porta: number) =>
  api.post('/api/v1/cameras/test-connection', { ip, porta })

export const updateSchedulePessoas = (id: number, faixa_horaria: string) =>
  api.patch(`/api/v1/cameras/${id}/schedule-pessoas`, { faixa_horaria })

export const testHttpApi = (params: {
  ip: string; fabricante: string; usuario: string; senha: string
  porta?: number; https?: boolean; channel?: number
}) => api.post<{ ok: boolean; latencia_ms: number; bytes?: number; error?: string }>(
  '/api/v1/cameras/test-http-api', params
)

export const resetSftp = (id: number) =>
  api.post<SftpCredentials>(`/api/v1/cameras/${id}/reset-sftp`)

export const getSftpCredentials = (id: number) =>
  api.get<SftpCredentials>(`/api/v1/cameras/${id}/sftp-credentials`)

export const getLprActivity = () =>
  api.get<CameraLprActivity[]>('/api/v1/cameras/lpr-activity')

export interface IntelbrasStatus {
  camera_id:      number
  camera_nome:    string
  ip:             string
  alive:          boolean
  status:         'connected' | 'reconnecting' | 'error' | 'stopped'
  last_connect_at: string | null
  last_event_at:  string | null
  last_error:     string | null
  last_error_at:  string | null
  total_events:   number
  backoff_s:      number
}

export const getIntelbrasStatus = () =>
  api.get<IntelbrasStatus[]>('/api/v1/cameras/intelbras-status')

export const getWatchlist = () =>
  api.get<WatchlistItem[]>('/api/v1/watchlist')

export const addWatchlist = (data: Partial<WatchlistItem>) =>
  api.post<WatchlistItem>('/api/v1/watchlist', data)

export const removeWatchlist = (placa: string) =>
  api.delete(`/api/v1/watchlist/${placa}`)

export interface ContagemPessoa {
  id: number
  uuid: string
  camera_id: number
  camera_nome: string
  camera_local: string
  arquivo_original: string
  total_pessoas: number
  confianca_media: number | null
  alerta_lotacao: boolean
  tempo_processo_ms: number | null
  detectado_em: string
  erro: string | null
  snapshot_url?: string | null
}

export interface EventoEPI {
  id: number
  uuid: string
  camera_id: number
  camera_nome: string
  camera_local: string
  total_pessoas: number
  com_capacete: number
  sem_capacete: number
  com_colete: number
  sem_colete: number
  conformidade: boolean
  percentual_conformidade: number
  tempo_processo_ms: number | null
  detectado_em: string
  erro: string | null
  snapshot_url?: string | null
}

export interface EpiTimelineRow {
  ts: string
  total_frames: number
  frames_com_pessoas: number
  violacoes: number
  conformes: number
  sem_capacete: number
  sem_colete: number
  conformidade_media: number
}

export const getContagensPessoas = (params = {}) =>
  api.get<{ total: number; data: ContagemPessoa[] }>('/api/v1/analytics/pessoas', { params })

export const getPessoasStats = (params = {}) =>
  api.get('/api/v1/analytics/pessoas/stats', { params })

export const getPessoasTimeline = (params: { periodo?: string; camera_id?: number } = {}) =>
  api.get<{
    periodo: string; pico_global: number
    data: { ts: string; frames: number; frames_total: number; pico: number; media: number; total: number; alertas: number }[]
  }>('/api/v1/analytics/pessoas/timeline', { params })

export const getEventosEPI = (params = {}) =>
  api.get<{ total: number; data: EventoEPI[] }>('/api/v1/analytics/epi', { params })

export const getEPIStats = (params = {}) =>
  api.get('/api/v1/analytics/epi/stats', { params })

export const getEPITimeline = (params: { periodo?: string; camera_id?: number } = {}) =>
  api.get<{ periodo: string; pico_violacoes: number; data: EpiTimelineRow[] }>(
    '/api/v1/analytics/epi/timeline', { params }
  )

export const getAnalyticsResumo = () =>
  api.get<AnalyticsResumo[]>('/api/v1/analytics/resumo')

export interface AlarmTimelineRow {
  ts: string
  disparos: number
  total_pessoas: number
  pico: number
  media_pessoas: number
  cameras_ativas: number
}

export const getAlarmTimeline = (params: { periodo?: string; camera_id?: number } = {}) =>
  api.get<{ periodo: string; pico_global: number; data: AlarmTimelineRow[] }>(
    '/api/v1/alarm/events/timeline', { params }
  )

export interface UpdateComponentStatus {
  ok: boolean
  mensagem: string
  detalhes: Record<string, unknown>
}

export interface UpdateCheck {
  timestamp: string
  saude_geral: 'ok' | 'aviso' | 'critico'
  alertas: string[]
  elapsed_s?: number
  versao: {
    versao_atual: string
    versao_disponivel: string | null
    atualizado: boolean
    novidades: string[]
    url_download: string | null
  }
  watchdog:      UpdateComponentStatus
  sftp_pendentes: UpdateComponentStatus
  modelos:       UpdateComponentStatus
  banco:         UpdateComponentStatus
  disco:         UpdateComponentStatus
}

export const getSystemStatus = () =>
  api.get<SystemStatus>('/api/v1/system/status')

export const getQueueStats = () =>
  api.get('/api/v1/system/queue')

export interface RtspWorkerStatus {
  cam_id:    number
  cam_nome:  string
  stream_ok: boolean
  last_count: number
  alive:     boolean
  errors:    number
}

export const getRtspStatus = () =>
  api.get<{ workers: RtspWorkerStatus[] }>('/api/v1/system/rtsp/status')

export const reloadRtsp = () =>
  api.post<{ ok: boolean; workers: RtspWorkerStatus[] }>('/api/v1/system/rtsp/reload')

export const getUpdateCheck = () =>
  api.get<UpdateCheck>('/api/v1/system/updates')

export const triggerUpdateCheck = () =>
  api.post<UpdateCheck>('/api/v1/system/updates/check')

export const getDailyReport = (date?: string) =>
  api.get('/api/v1/reports/daily', { params: date ? { date } : {} })

export interface DashboardResumo {
  lpr:       { total_24h: number; total_1h: number; validadas_24h: number; alertas_24h: number; tempo_medio_ms: number }
  cameras:   { total_ativas: number; online: number; offline: number; desconhecidas: number }
  pessoas:   { frames_24h: number; total_pessoas_24h: number; pico_24h: number; alertas_24h: number }
  epi:       { eventos_24h: number; violacoes_24h: number; conformidade_media: number }
  watchlist: { total: number }
  sistema:   { disco_uso_pct: number; disco_livre_gb: number; disco_total_gb: number; alertas_telegram: boolean; alertas_whatsapp: boolean }
  updates:   Partial<UpdateCheck>
}

export const getDashboardResumo = () =>
  api.get<DashboardResumo>('/api/v1/dashboard/resumo')

export const login = (apiKey: string) =>
  api.post<{ access_token: string }>('/api/v1/token', { api_key: apiKey })

export interface Emitente {
  nome_empresa?: string
  cnpj?: string
  endereco?: string
  cidade_uf?: string
  telefone?: string
  email?: string
  logo_url?: string
  slogan?: string
}

export const getEmitente = () =>
  api.get<Emitente>('/api/v1/config/emitente')

export const setEmitente = (data: Emitente) =>
  api.put<Emitente>('/api/v1/config/emitente', data)

export interface CustomReportRow {
  id: number
  nome: string
  local: string
  [key: string]: unknown
}

export interface HeatmapCell {
  dia: string
  hora: number
  total: number
  accent?: number
}

export interface CustomReport {
  tipo: string
  periodo: { inicio: string; fim: string }
  lpr?: CustomReportRow[]
  lpr_timeline?: { dia: string; total: number; com_placa: number; watchlist: number; confianca_media: number }[]
  lpr_heatmap?: HeatmapCell[]
  pessoas?: CustomReportRow[]
  pessoas_timeline?: { dia: string; frames: number; total_pessoas: number; pico: number; alertas: number }[]
  pessoas_heatmap?: HeatmapCell[]
  epi?: CustomReportRow[]
  epi_timeline?: { dia: string; eventos: number; total_pessoas: number; violacoes: number; conformidade_media: number }[]
  epi_heatmap?: HeatmapCell[]
}

export const getCustomReport = (params: { tipo?: string; data_inicio?: string; data_fim?: string; camera_id?: number }) =>
  api.get<CustomReport>('/api/v1/reports/custom', { params })
