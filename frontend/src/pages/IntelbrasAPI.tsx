export default function IntelbrasAPI() {
  type Endpoint = {
    method: string; url: string; desc: string
    params?: { name: string; tipo: string; desc: string }[]
    exemplo?: string
    resposta?: string
  }
  type Section = { id: string; title: string; icon: string; endpoints: Endpoint[] }

  const sections: Section[] = [
    {
      id: 'autenticacao', title: 'Autenticação', icon: '🔐',
      endpoints: [
        {
          method: 'DIGEST', url: 'http://{ip}/cgi-bin/...',
          desc: 'Todas as requisições exigem HTTP Digest Authentication (RFC 2617). Credenciais: usuário e senha do admin da câmera. Não usar Basic Auth (rejeitado por padrão).',
          exemplo: `curl --digest -u admin:senha123 http://192.168.1.100/cgi-bin/snapshot.cgi`,
        },
        {
          method: 'GET', url: '/cgi-bin/global.cgi?action=getConfig',
          desc: 'Verifica conectividade e retorna configuração global do dispositivo.',
          resposta: `table.General.LocalNo=1\ntable.General.Name=VIP5460LPR\ntable.General.MachineName=Intelbras`,
        },
      ],
    },
    {
      id: 'streaming', title: 'Streaming de Vídeo', icon: '📹',
      endpoints: [
        {
          method: 'RTSP', url: 'rtsp://{user}:{pass}@{ip}:{porta}/cam/realmonitor?channel=1&subtype=0',
          desc: 'Stream principal (alta resolução). subtype=0 = principal, subtype=1 = sub-stream (menor resolução). Porta padrão: 554.',
          params: [
            { name: 'channel', tipo: 'int', desc: 'Canal da câmera (1 = padrão)' },
            { name: 'subtype', tipo: 'int', desc: '0 = stream principal, 1 = sub-stream' },
          ],
          exemplo: `rtsp://admin:senha123@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0`,
        },
        {
          method: 'RTMP', url: 'rtmp://{ip}:{porta}/bcs/channel{N}_main.bcs?channel={N}&stream=0&user={user}&password={pass}',
          desc: 'Stream via RTMP (para transmissão). Porta padrão: 1935. Modelo VIP 5460 LPR IA suporta RTMP.',
          exemplo: `rtmp://192.168.1.100:1935/bcs/channel0_main.bcs?channel=0&stream=0&user=admin&password=senha123`,
        },
        {
          method: 'GET', url: '/cgi-bin/snapshot.cgi?channel=1',
          desc: 'Captura snapshot JPEG do canal especificado. Retorna imagem diretamente.',
          params: [
            { name: 'channel', tipo: 'int', desc: 'Número do canal (1-based)' },
          ],
          exemplo: `curl --digest -u admin:senha123 "http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1" -o frame.jpg`,
        },
      ],
    },
    {
      id: 'dispositivo', title: 'Informações do Dispositivo', icon: '💡',
      endpoints: [
        {
          method: 'GET', url: '/cgi-bin/magicBox.cgi?action=getSystemInfo',
          desc: 'Retorna informações do sistema: modelo, firmware, número de série.',
          resposta: `serialNumber=2A0B12345678\ndeviceType=IPC\nhardwareVersion=2.680.0008.0.R\nsoftwareVersion=2.820.0010.0.T`,
        },
        {
          method: 'GET', url: '/cgi-bin/magicBox.cgi?action=getDeviceType',
          desc: 'Retorna o tipo do dispositivo (IPC, NVR, etc.).',
          resposta: `type=IPC`,
        },
        {
          method: 'GET', url: '/cgi-bin/magicBox.cgi?action=getCurrentTime',
          desc: 'Retorna a hora atual do dispositivo.',
          resposta: `result=true\ntime=2026-04-20 14:30:00`,
        },
        {
          method: 'GET', url: '/cgi-bin/magicBox.cgi?action=getUpnpInfo',
          desc: 'Retorna status de rede, IP e máscara do dispositivo.',
          resposta: `result=OK\nIPAddress=192.168.1.100\nSubnetMask=255.255.255.0\nGateway=192.168.1.1`,
        },
      ],
    },
    {
      id: 'lpr', title: 'LPR — Reconhecimento de Placas (VIP 5460)', icon: '🚗',
      endpoints: [
        {
          method: 'GET', url: '/cgi-bin/trafficSnap.cgi?action=getConfig',
          desc: 'Retorna configuração do módulo LPR: regiões de interesse, sensibilidade, direção do tráfego.',
          resposta: `table.TrafficSnap.Enable=true\ntable.TrafficSnap.Sensitivity=60\ntable.TrafficSnap.PlateType=Brazil`,
        },
        {
          method: 'GET', url: '/cgi-bin/snapManager.cgi?action=getImageCount&StartTime={ts}&EndTime={ts}',
          desc: 'Conta capturas LPR no intervalo de tempo. Timestamps no formato YYYY-MM-DD HH:MM:SS.',
          params: [
            { name: 'StartTime', tipo: 'string', desc: 'Início do intervalo: YYYY-MM-DD HH:MM:SS' },
            { name: 'EndTime',   tipo: 'string', desc: 'Fim do intervalo: YYYY-MM-DD HH:MM:SS' },
          ],
        },
        {
          method: 'POST', url: '/cgi-bin/snapManager.cgi?action=findFile',
          desc: 'Busca registros LPR no intervalo especificado. Body: parâmetros de busca em URL-encoded form.',
          params: [
            { name: 'object.BeginTime', tipo: 'string', desc: 'Início: YYYY-MM-DD HH:MM:SS' },
            { name: 'object.EndTime',   tipo: 'string', desc: 'Fim: YYYY-MM-DD HH:MM:SS' },
            { name: 'object.LicensePlate', tipo: 'string', desc: 'Placa para filtrar (opcional)' },
          ],
          resposta: `found=3\nrecords[0].FilePath=/mnt/sd/2026-04-20/001/snap/14/20260420142000000001.jpg\nrecords[0].LicensePlate=ABC1234\nrecords[0].Confidence=92`,
        },
        {
          method: 'GET', url: '/cgi-bin/eventManager.cgi?action=attach&codes[0]=TrafficJunction&heartbeat=5',
          desc: 'Inscrição em eventos LPR em tempo real via long-polling. Retorna multipart/x-mixed-replace com eventos.',
          resposta: `--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=TrafficJunction;action=Start;index=0;data={"LicensePlate":"ABC1234","Confidence":95,"Direction":"Approaching"}`,
        },
      ],
    },
    {
      id: 'ptz', title: 'Controle PTZ (VIP 3225 SD IR IA G2)', icon: '🎯',
      endpoints: [
        {
          method: 'GET', url: '/cgi-bin/ptz.cgi?action=start&channel=1&code={code}&arg1={h}&arg2={v}&arg3={zoom}',
          desc: 'Inicia movimento PTZ. Parar o movimento com action=stop.',
          params: [
            { name: 'code',  tipo: 'string', desc: 'Left, Right, Up, Down, ZoomWide, ZoomTele, FocusNear, FocusFar' },
            { name: 'arg1',  tipo: 'int',    desc: 'Velocidade horizontal (0–100)' },
            { name: 'arg2',  tipo: 'int',    desc: 'Velocidade vertical (0–100)' },
            { name: 'arg3',  tipo: 'int',    desc: 'Velocidade de zoom (0–100)' },
          ],
          exemplo: `# Mover para a esquerda\ncurl --digest -u admin:senha "http://192.168.1.100/cgi-bin/ptz.cgi?action=start&channel=1&code=Left&arg1=5&arg2=0&arg3=0"\n# Parar\ncurl --digest -u admin:senha "http://192.168.1.100/cgi-bin/ptz.cgi?action=stop&channel=1&code=Left&arg1=5&arg2=0&arg3=0"`,
        },
        {
          method: 'GET', url: '/cgi-bin/ptz.cgi?action=setPreset&channel=1&index={n}',
          desc: 'Salva preset na posição atual. index = número do preset (1–300).',
        },
        {
          method: 'GET', url: '/cgi-bin/ptz.cgi?action=gotoPreset&channel=1&index={n}',
          desc: 'Move a câmera para o preset especificado.',
          exemplo: `curl --digest -u admin:senha "http://192.168.1.100/cgi-bin/ptz.cgi?action=gotoPreset&channel=1&index=1"`,
        },
        {
          method: 'GET', url: '/cgi-bin/ptz.cgi?action=getCurrentPreset&channel=1',
          desc: 'Retorna a posição atual (pan, tilt, zoom).',
          resposta: `pan=90.50\ntilt=0.00\nzoom=1`,
        },
      ],
    },
    {
      id: 'eventos', title: 'Eventos e Alarmes', icon: '🔔',
      endpoints: [
        {
          method: 'GET', url: '/cgi-bin/eventManager.cgi?action=attach&codes[0]={evento}&heartbeat={seg}',
          desc: 'Long-polling para eventos em tempo real. heartbeat define o intervalo de keep-alive em segundos.',
          params: [
            { name: 'codes[0]', tipo: 'string', desc: 'VideoMotion, VideoLoss, AlarmLocal, CrossLineDetection, CrossRegionDetection, TrafficJunction (LPR), FaceDetection' },
            { name: 'heartbeat', tipo: 'int', desc: 'Intervalo keep-alive em segundos (ex: 5)' },
          ],
          resposta: `--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=VideoMotion;action=Start;index=0;data={}`,
        },
        {
          method: 'GET', url: '/cgi-bin/eventManager.cgi?action=getEventIndexes&code={evento}',
          desc: 'Retorna índices configurados para o tipo de evento.',
          params: [
            { name: 'code', tipo: 'string', desc: 'Tipo do evento (VideoMotion, CrossLineDetection, etc.)' },
          ],
          resposta: `indexes[0]=0`,
        },
        {
          method: 'GET', url: '/cgi-bin/configManager.cgi?action=getConfig&name=MotionDetect',
          desc: 'Retorna configuração de detecção de movimento: regiões, sensibilidade, agendamento.',
          resposta: `table.MotionDetect[0].Enable=true\ntable.MotionDetect[0].Sensitivity=60\ntable.MotionDetect[0].Region[0][0]=1023`,
        },
        {
          method: 'GET', url: '/cgi-bin/configManager.cgi?action=setConfig&MotionDetect[0].Enable={bool}',
          desc: 'Habilita/desabilita detecção de movimento. Substituir {bool} por true ou false.',
        },
      ],
    },
    {
      id: 'rede', title: 'Configuração de Rede', icon: '🌐',
      endpoints: [
        {
          method: 'GET', url: '/cgi-bin/configManager.cgi?action=getConfig&name=Network',
          desc: 'Retorna configuração de rede: IP, gateway, DNS, DHCP.',
          resposta: `table.Network.DHCP=false\ntable.Network.IPAddress=192.168.1.100\ntable.Network.SubnetMask=255.255.255.0\ntable.Network.DefaultGateway=192.168.1.1`,
        },
        {
          method: 'GET', url: '/cgi-bin/configManager.cgi?action=getConfig&name=RTSP',
          desc: 'Retorna configuração do servidor RTSP: porta, autenticação.',
          resposta: `table.RTSP.Port=554\ntable.RTSP.AuthorizationEnable=true`,
        },
        {
          method: 'GET', url: '/cgi-bin/configManager.cgi?action=getConfig&name=RTMP',
          desc: 'Retorna configuração do servidor RTMP (suportado pelo VIP 5460 LPR IA).',
          resposta: `table.RTMP.Port=1935\ntable.RTMP.CustomAddress=\ntable.RTMP.Enable=true`,
        },
      ],
    },
    {
      id: 'nvr', title: 'NVR — NVD 3316 / 3332', icon: '💾',
      endpoints: [
        {
          method: 'RTSP', url: 'rtsp://{user}:{pass}@{ip}:{porta}/cam/realmonitor?channel={n}&subtype=0',
          desc: 'Acesso ao stream de cada canal do NVR. channel = 1 ao 16 (NVD 3316) ou 1 ao 32 (NVD 3332).',
          exemplo: `# Canal 3 do NVR\nrtsp://admin:senha123@192.168.1.50:554/cam/realmonitor?channel=3&subtype=0`,
        },
        {
          method: 'GET', url: '/cgi-bin/snapshot.cgi?channel={n}',
          desc: 'Snapshot de canal específico do NVR.',
        },
        {
          method: 'GET', url: '/cgi-bin/recordFinder.cgi?action=find&begin={ts}&end={ts}&channel={n}',
          desc: 'Busca gravações no NVR por canal e intervalo de tempo.',
          params: [
            { name: 'begin',   tipo: 'string', desc: 'Início: YYYY-MM-DD HH:MM:SS' },
            { name: 'end',     tipo: 'string', desc: 'Fim: YYYY-MM-DD HH:MM:SS' },
            { name: 'channel', tipo: 'int',    desc: 'Canal (1-based)' },
          ],
          resposta: `found=2\nrecords[0].BeginTime=2026-04-20 10:00:00\nrecords[0].EndTime=2026-04-20 10:30:00\nrecords[0].FilePath=/mnt/sd/...`,
        },
        {
          method: 'GET', url: '/cgi-bin/magicBox.cgi?action=getSystemInfo',
          desc: 'Info do NVR: modelo, firmware, número de canais.',
          resposta: `deviceType=NVR\nmodel=NVD3332\nchannelNumber=32\nsoftwareVersion=3.218.0000003.0`,
        },
      ],
    },
  ]

  const methodColor = (m: string) => {
    if (m === 'GET')    return { bg: 'rgba(59,130,246,.15)', color: '#60a5fa' }
    if (m === 'POST')   return { bg: 'rgba(16,185,129,.15)', color: '#34d399' }
    if (m === 'RTSP')   return { bg: 'rgba(139,92,246,.15)', color: '#a78bfa' }
    if (m === 'RTMP')   return { bg: 'rgba(245,158,11,.15)', color: '#fbbf24' }
    if (m === 'DIGEST') return { bg: 'rgba(239,68,68,.15)',  color: '#f87171' }
    return { bg: 'rgba(100,116,139,.15)', color: '#94a3b8' }
  }

  return (
    <div className="page">

      {/* Intro card */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ fontSize: 32 }}>📡</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
              Documentação da API HTTP/CGI — Câmeras Intelbras
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
              Interface HTTP/CGI nativa das câmeras Intelbras (protocolo Intelbras-1 / Dahua SDK).
              Modelos cobertos: <strong>VIP 5460 LPR IA</strong>, <strong>VIP 3430 BD IA</strong>,
              <strong> VIP 3225 SD IR IA G2</strong>, <strong>VIP 3220 SD IR</strong>,
              <strong> NVD 3316 / 3332</strong>.<br />
              Todas as requisições utilizam <strong>HTTP Digest Auth</strong>.
              Porta padrão HTTP: <code style={{ fontSize: 11 }}>80</code> · RTSP: <code style={{ fontSize: 11 }}>554</code> · RTMP: <code style={{ fontSize: 11 }}>1935</code>.
            </div>
          </div>
        </div>

        {/* Quick nav */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 16 }}>
          {sections.map(s => (
            <a key={s.id} href={`#${s.id}`}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 20,
                background: 'var(--surface2)', color: 'var(--text2)',
                textDecoration: 'none', border: '1px solid var(--border)',
                transition: 'color .15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--primary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text2)')}
            >
              {s.icon} {s.title}
            </a>
          ))}
        </div>
      </div>

      {/* Models */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        {[
          { model: 'VIP 5460 LPR IA', tipo: 'LPR / ANPR', proto: 'RTSP · RTMP · HTTP/CGI · ONVIF · Intelbras-1' },
          { model: 'VIP 3430 BD IA',  tipo: 'IP Dome IA',  proto: 'RTSP · HTTP/CGI · ONVIF' },
          { model: 'VIP 3225 SD IR IA G2', tipo: 'Speed Dome PTZ', proto: 'RTSP · HTTP/CGI · ONVIF · PTZ' },
          { model: 'NVD 3316 / 3332', tipo: 'NVR 16/32 ch', proto: 'RTSP · HTTP/CGI · ONVIF' },
        ].map(m => (
          <div className="card" key={m.model} style={{ padding: '12px 14px' }}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>{m.model}</div>
            <div style={{ fontSize: 11, color: 'var(--primary)', marginBottom: 6 }}>{m.tipo}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.6 }}>{m.proto}</div>
          </div>
        ))}
      </div>

      {/* Sections */}
      {sections.map(sec => (
        <div key={sec.id} id={sec.id} className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{sec.icon}</span>
            {sec.title}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sec.endpoints.map((ep, i) => {
              const mc = methodColor(ep.method)
              return (
                <div key={i} style={{
                  border: '1px solid var(--border)', borderRadius: 8,
                  overflow: 'hidden',
                }}>
                  {/* Header */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 13px', background: 'var(--surface2)',
                  }}>
                    <span style={{
                      fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 4,
                      background: mc.bg, color: mc.color, letterSpacing: '.5px',
                      flexShrink: 0,
                    }}>
                      {ep.method}
                    </span>
                    <code style={{ fontSize: 11, color: 'var(--text)', wordBreak: 'break-all' }}>
                      {ep.url}
                    </code>
                  </div>

                  {/* Body */}
                  <div style={{ padding: '10px 13px' }}>
                    <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: ep.params || ep.exemplo || ep.resposta ? 10 : 0 }}>
                      {ep.desc}
                    </div>

                    {ep.params && (
                      <div style={{ marginBottom: ep.exemplo || ep.resposta ? 10 : 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Parâmetros</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {ep.params.map((p, pi) => (
                            <div key={pi} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 11 }}>
                              <code style={{ color: 'var(--primary)', minWidth: 160, flexShrink: 0 }}>{p.name}</code>
                              <span style={{ color: 'var(--text3)', minWidth: 50, flexShrink: 0 }}>{p.tipo}</span>
                              <span style={{ color: 'var(--text2)' }}>{p.desc}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ep.exemplo && (
                      <div style={{ marginBottom: ep.resposta ? 10 : 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>Exemplo</div>
                        <pre style={{
                          background: 'rgba(0,0,0,.2)', padding: '8px 12px', borderRadius: 6,
                          fontSize: 10, color: '#86efac', margin: 0, overflowX: 'auto',
                          lineHeight: 1.6, whiteSpace: 'pre-wrap',
                        }}>{ep.exemplo}</pre>
                      </div>
                    )}

                    {ep.resposta && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>Resposta (exemplo)</div>
                        <pre style={{
                          background: 'rgba(0,0,0,.2)', padding: '8px 12px', borderRadius: 6,
                          fontSize: 10, color: '#93c5fd', margin: 0, overflowX: 'auto',
                          lineHeight: 1.6, whiteSpace: 'pre-wrap',
                        }}>{ep.resposta}</pre>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Notes */}
      <div className="card" style={{ marginBottom: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>⚠️ Notas Importantes</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
          <div>• <strong>Digest Auth obrigatório:</strong> Basic Auth pode ser desabilitado por padrão para segurança. Sempre use <code>--digest</code> no curl ou <code>HTTPDigestAuth</code> no Python/requests.</div>
          <div>• <strong>ONVIF:</strong> Além do HTTP/CGI nativo, todos os modelos suportam ONVIF Profile S (streaming), Profile T (analytics), Profile G (gravação) e Profile M (metadados).</div>
          <div>• <strong>Intelbras-1 (JSON-RPC):</strong> Protocolo proprietário alternativo via <code>POST /RPC2</code> e <code>POST /RPC2_Login</code>. Permite controle avançado mas requer autenticação de sessão (cookie).</div>
          <div>• <strong>LPR eventos em tempo real:</strong> Use <code>eventManager.cgi?action=attach&codes[0]=TrafficJunction</code> com long-polling. A conexão fica aberta e recebe eventos multipart.</div>
          <div>• <strong>SFTP upload:</strong> O VIP 5460 LPR IA pode enviar snapshots de placas via SFTP para o servidor SuricathaIA automaticamente ao detectar uma placa (configurado em Evento → FTP).</div>
          <div>• <strong>Porta HTTPS:</strong> Por padrão 443. Recomendado para ambientes de produção — substitua <code>http://</code> por <code>https://</code> e configure certificado no dispositivo.</div>
        </div>
      </div>
    </div>
  )
}
