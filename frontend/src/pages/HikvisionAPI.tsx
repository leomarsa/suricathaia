export default function HikvisionAPI() {
  type Param  = { name: string; tipo: string; desc: string }
  type Endpoint = {
    method: string; url: string; desc: string
    params?: Param[]
    body?: string
    exemplo?: string
    resposta?: string
    nota?: string
  }
  type Section = { id: string; title: string; icon: string; endpoints: Endpoint[] }

  const sections: Section[] = [
    {
      id: 'autenticacao', title: 'Autenticação (Digest / Sessão)', icon: '🔐',
      endpoints: [
        {
          method: 'GET',
          url: '/ISAPI/Security/sessionLogin/capabilities?username={user}',
          desc: 'Passo 1: obtém parâmetros criptográficos para hash da senha — salt, challenge, iterations e flag isIrreversible.',
          resposta: `<SessionLoginCap>\n  <sessionID>abc123</sessionID>\n  <challenge>abc</challenge>\n  <iterations>1000</iterations>\n  <isIrreversible>true</isIrreversible>\n  <salt>AABBCC</salt>\n</SessionLoginCap>`,
        },
        {
          method: 'POST',
          url: '/ISAPI/Security/sessionLogin?timeStamp={ts}',
          desc: 'Passo 2: autentica com senha SHA-256 calculada a partir do challenge retornado no passo 1. Retorna sessionID para uso nos cookies.',
          body: `<SessionLogin>\n  <userName>admin</userName>\n  <password>{sha256_hash}</password>\n  <sessionID>abc123</sessionID>\n  <isSessionIDValidLongTerm>false</isSessionIDValidLongTerm>\n  <sessionIDVersion>2</sessionIDVersion>\n</SessionLogin>`,
          resposta: `<SessionLogin>\n  <statusCode>200</statusCode>\n  <statusString>OK</statusString>\n  <sessionID>NEWID456</sessionID>\n</SessionLogin>`,
          nota: 'Cookie de sessão: versão 1 → WebSession={sessionID}; versão 2 → WebSession={sessionID} (formato ligeiramente diferente)',
        },
        {
          method: 'GET',
          url: '/ISAPI/Security/userCheck?timeStamp={ts}',
          desc: 'Verifica o status do usuário antes do login: conta ativada, senha fraca, nível de risco.',
          resposta: `<SessionUserCheck>\n  <statusCode>200</statusCode>\n  <isActivated>true</isActivated>\n  <isPasswordRisk>false</isPasswordRisk>\n</SessionUserCheck>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/Security/sessionLogout',
          desc: 'Encerra a sessão atual. Deve ser chamado ao finalizar para liberar recursos.',
          resposta: `<ResponseStatus>\n  <statusCode>1</statusCode>\n  <statusString>OK</statusString>\n</ResponseStatus>`,
        },
        {
          method: 'GET',
          url: '/ISAPI/Security/token?format=json',
          desc: 'Obtém token para conexão WebSocket (WebSocket Streaming API).',
          resposta: `{"token":{"value":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}}`,
        },
        {
          method: 'GET',
          url: '/ISAPI/Security/capabilities',
          desc: 'Retorna capacidades de segurança: limites de usuários, suporte a RSA, tamanho máximo de senha, import/export.',
          params: [{ name: 'username', tipo: 'string', desc: 'Opcional — retorna capabilities específicas do usuário' }],
        },
      ],
    },
    {
      id: 'streaming', title: 'Streaming de Vídeo', icon: '📹',
      endpoints: [
        {
          method: 'RTSP',
          url: 'rtsp://{user}:{pass}@{ip}:{porta}/Streaming/Channels/{channelId}',
          desc: 'Stream RTSP direto da câmera ou via NVR. channelId: 101 = canal 1 stream principal, 102 = canal 1 sub-stream, 201 = canal 2 principal, etc.',
          params: [
            { name: 'channelId', tipo: 'int', desc: 'N × 100 + stream (1=principal, 2=sub). Ex: canal 3 principal = 301' },
          ],
          exemplo: `# Câmera standalone — canal 1 stream principal\nrtsp://admin:Senha@123@192.168.1.64:554/Streaming/Channels/101\n\n# NVR — canal 3 sub-stream\nrtsp://admin:Senha@123@192.168.1.50:554/Streaming/Channels/302`,
        },
        {
          method: 'GET',
          url: '/ISAPI/Streaming/channels/{channelId}/picture',
          desc: 'Captura snapshot JPEG do canal. Requer autenticação Digest ou cookie de sessão.',
          params: [
            { name: 'channelId', tipo: 'int', desc: 'N × 100 + 1 (stream principal). Ex: canal 2 = 201' },
          ],
          exemplo: `curl --digest -u admin:Senha@123 \\\n  "http://192.168.1.64/ISAPI/Streaming/channels/101/picture" \\\n  -o snapshot.jpg`,
        },
        {
          method: 'WS',
          url: 'ws://{ip}/ISAPI/Streaming/channels/{channelId}/preview?access_token={token}',
          desc: 'WebSocket para preview de vídeo em tempo real (recebe frames FrameData). Token obtido via /ISAPI/Security/token.',
        },
      ],
    },
    {
      id: 'device', title: 'Informações do Dispositivo', icon: '💡',
      endpoints: [
        {
          method: 'GET',
          url: '/ISAPI/System/deviceInfo',
          desc: 'Retorna informações completas do hardware: modelo, número de série, MAC, versão de firmware e encoder.',
          resposta: `<DeviceInfo>\n  <deviceName>IPCamera</deviceName>\n  <deviceID>1</deviceID>\n  <model>DS-2CD2T45G0P-I</model>\n  <serialNumber>DS-2CD2T45G027...\n  <macAddress>44:2c:05:xx:xx:xx</macAddress>\n  <firmwareVersion>V5.7.15</firmwareVersion>\n  <firmwareReleasedDate>build 221219</firmwareReleasedDate>\n  <deviceType>IPCamera</deviceType>\n</DeviceInfo>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/System/deviceInfo',
          desc: 'Atualiza configurações do dispositivo (nome, ID, etc.).',
          body: `<DeviceInfo>\n  <deviceName>CAM-PORTARIA-01</deviceName>\n</DeviceInfo>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/System/reboot',
          desc: 'Reinicializa o dispositivo remotamente. Sem body. Aguardar ~60 s para reconexão.',
          resposta: `<ResponseStatus>\n  <statusCode>1</statusCode>\n  <statusString>OK</statusString>\n</ResponseStatus>`,
        },
        {
          method: 'GET',
          url: '/ISAPI/System/time',
          desc: 'Retorna modo de sincronização de hora (NTP ou manual), horário local e fuso horário.',
          resposta: `<Time>\n  <timeMode>NTP</timeMode>\n  <localTime>2026-04-20T14:30:00</localTime>\n  <timeZone>CST-3:00:00</timeZone>\n</Time>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/System/time',
          desc: 'Define hora manual ou muda para modo NTP.',
          body: `<Time>\n  <timeMode>manual</timeMode>\n  <localTime>2026-04-20T14:30:00</localTime>\n  <timeZone>CST-3:00:00</timeZone>\n</Time>`,
        },
        {
          method: 'GET',
          url: '/ISAPI/System/Network/ssh',
          desc: 'Retorna se SSH está habilitado no dispositivo.',
          resposta: `<SSH><enabled>false</enabled></SSH>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/System/Network/ssh',
          desc: 'Habilita ou desabilita acesso SSH.',
          body: `<SSH><enabled>true</enabled></SSH>`,
        },
      ],
    },
    {
      id: 'canais', title: 'Gerenciamento de Canais (NVR)', icon: '📡',
      endpoints: [
        {
          method: 'GET',
          url: '/ISAPI/ContentMgmt/InputProxy/channels',
          desc: 'Lista todos os canais configurados no NVR com endereço IP, protocolo, credenciais e configurações de ANR.',
          resposta: `<InputProxyChannelList>\n  <InputProxyChannel>\n    <id>1</id>\n    <name>CAM-01</name>\n    <ip>192.168.1.101</ip>\n    <managePort>8000</managePort>\n    <protocol>HIKVISION</protocol>\n    <streamType>auto</streamType>\n    <userName>admin</userName>\n    <enableAnr>false</enableAnr>\n  </InputProxyChannel>\n</InputProxyChannelList>`,
        },
        {
          method: 'GET',
          url: '/ISAPI/ContentMgmt/InputProxy/channels/status',
          desc: 'Retorna status online/offline de cada canal e avaliação de segurança da senha.',
          resposta: `<InputProxyChannelStatusList>\n  <InputProxyChannelStatus>\n    <id>1</id>\n    <online>true</online>\n    <securityStatus>notRisk</securityStatus>\n  </InputProxyChannelStatus>\n</InputProxyChannelStatusList>`,
        },
        {
          method: 'POST',
          url: '/ISAPI/ContentMgmt/InputProxy/channels',
          desc: 'Adiciona uma nova câmera IP ao NVR. Retorna o ID do canal criado.',
          body: `<InputProxyChannel>\n  <id>2</id>\n  <ip>192.168.1.102</ip>\n  <managePort>8000</managePort>\n  <userName>admin</userName>\n  <password>Senha@123</password>\n  <protocol>HIKVISION</protocol>\n  <streamType>auto</streamType>\n</InputProxyChannel>`,
          resposta: `<ResponseStatus>\n  <statusCode>1</statusCode>\n  <statusString>OK</statusString>\n  <id>2</id>\n</ResponseStatus>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/ContentMgmt/InputProxy/channels/{channelId}',
          desc: 'Atualiza configurações de um canal existente (IP, credenciais, protocolo).',
          params: [{ name: 'channelId', tipo: 'int', desc: 'ID do canal (1-based)' }],
        },
        {
          method: 'DELETE',
          url: '/ISAPI/ContentMgmt/InputProxy/channels/{channelId}',
          desc: 'Remove um canal do NVR. Pode buscar pelo channelId ou pelo endereço IP da câmera.',
          params: [
            { name: 'channelId', tipo: 'int',    desc: 'ID numérico do canal' },
          ],
        },
        {
          method: 'GET',
          url: '/ISAPI/ContentMgmt/InputProxy/search',
          desc: 'Descobre câmeras Hikvision na rede (busca Unicast/Multicast). Retorna lista de dispositivos com IP, protocolo e status de ativação.',
        },
      ],
    },
    {
      id: 'ptz', title: 'Controle PTZ', icon: '🎯',
      endpoints: [
        {
          method: 'PUT',
          url: '/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{channelId}/continuous',
          desc: 'Move câmera PTZ conectada ao NVR (proxy). Enviar pan/tilt/zoom = 0 para parar. Valores positivos/negativos definem direção.',
          params: [
            { name: 'channelId', tipo: 'int', desc: 'ID do canal do NVR' },
          ],
          body: `<PTZData>\n  <pan>5</pan>      <!-- -100 a 100; positivo=direita -->\n  <tilt>0</tilt>    <!-- -100 a 100; positivo=cima -->\n  <zoom>0</zoom>    <!-- -100 a 100; positivo=zoom in -->\n</PTZData>`,
          exemplo: `# Mover para a direita\ncurl --digest -u admin:senha \\\n  -X PUT -H "Content-Type: text/xml" \\\n  -d '<PTZData><pan>5</pan><tilt>0</tilt><zoom>0</zoom></PTZData>' \\\n  "http://192.168.1.50/ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/continuous"\n\n# Parar\ncurl --digest -u admin:senha \\\n  -X PUT -H "Content-Type: text/xml" \\\n  -d '<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>' \\\n  "http://192.168.1.50/ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/continuous"`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/PTZCtrl/channels/1/continuous',
          desc: 'Controle PTZ direto na câmera (sem NVR). Mesma estrutura PTZData.',
        },
        {
          method: 'PUT',
          url: '/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{channelId}/autoPan',
          desc: 'Ativa/desativa Auto Pan (rotação horizontal automática contínua).',
          body: `<autoPanData><autoPan>true</autoPan></autoPanData>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/PTZCtrl/channels/1/auxcontrols/1',
          desc: 'Controla auxiliares PTZ: luz branca (LIGHT) e limpador (WIPER).',
          body: `<PTZAux>\n  <id>1</id>\n  <type>LIGHT</type>   <!-- LIGHT | WIPER -->\n  <status>on</status>  <!-- on | off -->\n</PTZAux>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/ContentMgmt/InputProxy/channels/{channelId}/video/iris',
          desc: 'Ajusta íris do canal via NVR proxy.',
          body: `<IrisData><iris>50</iris></IrisData>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/ContentMgmt/InputProxy/channels/{channelId}/video/focus',
          desc: 'Ajusta foco do canal via NVR proxy.',
          body: `<FocusData><focus>50</focus></FocusData>`,
        },
      ],
    },
    {
      id: 'usuarios', title: 'Gerenciamento de Usuários', icon: '👤',
      endpoints: [
        {
          method: 'GET',
          url: '/ISAPI/Security/users',
          desc: 'Lista todos os usuários cadastrados com ID, nome, nível de acesso e bindings de IP/MAC.',
          resposta: `<UserList>\n  <User>\n    <id>1</id>\n    <userName>admin</userName>\n    <userLevel>Administrator</userLevel>\n  </User>\n  <User>\n    <id>2</id>\n    <userName>operador</userName>\n    <userLevel>Operator</userLevel>\n  </User>\n</UserList>`,
        },
        {
          method: 'POST',
          url: '/ISAPI/Security/users',
          desc: 'Cria novo usuário. userLevel: Administrator | Operator | Viewer.',
          body: `<User>\n  <id>3</id>\n  <userName>monitoramento</userName>\n  <loginPassword>Senha@123</loginPassword>\n  <password>Senha@123</password>\n  <userLevel>Viewer</userLevel>\n</User>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/Security/users/{userId}',
          desc: 'Atualiza dados de um usuário existente (senha, nível de acesso).',
          params: [{ name: 'userId', tipo: 'int', desc: 'ID do usuário' }],
        },
        {
          method: 'DELETE',
          url: '/ISAPI/Security/users/{userId}',
          desc: 'Remove usuário. Requer loginPassword do admin no parâmetro de query.',
          params: [
            { name: 'userId',        tipo: 'int',    desc: 'ID do usuário a remover' },
            { name: 'loginPassword', tipo: 'string', desc: 'Senha do admin (hash SHA-256)' },
          ],
        },
      ],
    },
    {
      id: 'storage', title: 'Armazenamento (HDD / NAS)', icon: '💾',
      endpoints: [
        {
          method: 'GET',
          url: '/ISAPI/ContentMgmt/Storage',
          desc: 'Lista HDs e NAS configurados com capacidade, espaço livre, status e modo de trabalho.',
          resposta: `<storage>\n  <hddList>\n    <hdd>\n      <id>1</id>\n      <hddName>HDD1</hddName>\n      <hddPath>/dev/sda</hddPath>\n      <hddStatus>ok</hddStatus>\n      <capacity>4000000</capacity>\n      <freeSpace>3200000</freeSpace>\n    </hdd>\n  </hddList>\n  <workMode>group</workMode>\n</storage>`,
        },
        {
          method: 'PUT',
          url: '/ISAPI/ContentMgmt/Storage/hdd/{id}/format',
          desc: 'Formata o HD especificado. Operação demorada — timeout recomendado de 60 s. Acompanhar progresso com /formatStatus.',
          params: [{ name: 'id', tipo: 'int', desc: 'ID do HD (1-based)' }],
          nota: 'ATENÇÃO: todos os dados gravados serão apagados permanentemente.',
        },
        {
          method: 'GET',
          url: '/ISAPI/ContentMgmt/Storage/hdd/{id}/formatStatus',
          desc: 'Retorna progresso da formatação em andamento (0–100%).',
          params: [{ name: 'id', tipo: 'int', desc: 'ID do HD' }],
          resposta: `<formatStatus>\n  <formatingStatus>formatting</formatingStatus>\n  <percent>42</percent>\n</formatStatus>`,
        },
      ],
    },
    {
      id: 'gravacoes', title: 'Busca de Gravações', icon: '🎬',
      endpoints: [
        {
          method: 'POST',
          url: '/ISAPI/ContentMgmt/record/tracks/{trackId}/dailyDistribution',
          desc: 'Retorna mapa mensal de dias com gravação disponível. trackId = channelId × 100 + streamType (1=principal, 2=sub).',
          params: [
            { name: 'trackId', tipo: 'int', desc: 'channelId × 100 + streamType. Ex: canal 1 principal = 101' },
          ],
          body: `<trackDailyParam>\n  <year>2026</year>\n  <monthOfYear>4</monthOfYear>\n</trackDailyParam>`,
          resposta: `<CMSearchResult>\n  <trackDailyDistribution>\n    <dayList>\n      <day>19</day><record>true</record><recordType>timing</recordType>\n      <day>20</day><record>true</record>\n    </dayList>\n  </trackDailyDistribution>\n</CMSearchResult>`,
        },
        {
          method: 'POST',
          url: '/ISAPI/ContentMgmt/search',
          desc: 'Busca gravações por canal e intervalo de tempo. Suporta paginação via searchResultPosition + maxResults.',
          body: `<CMSearchDescription>\n  <searchID>1</searchID>\n  <trackList>\n    <trackID>101</trackID>\n  </trackList>\n  <timeSpanList>\n    <timeSpan>\n      <startTime>2026-04-20T10:00:00</startTime>\n      <endTime>2026-04-20T12:00:00</endTime>\n    </timeSpan>\n  </timeSpanList>\n  <maxResults>50</maxResults>\n  <searchResultPosition>0</searchResultPosition>\n  <metadataList>\n    <metadataDescriptor>//recordType.meta.std-cgi/dav</metadataDescriptor>\n  </metadataList>\n</CMSearchDescription>`,
          resposta: `<CMSearchResult>\n  <searchID>1</searchID>\n  <responseStatus>true</responseStatus>\n  <responseStatusStrg>OK</responseStatusStrg>\n  <numOfMatches>3</numOfMatches>\n  <matchList>\n    <searchMatchItem>\n      <sourceID>tracks/101</sourceID>\n      <timeSpan>\n        <startTime>2026-04-20T10:00:00</startTime>\n        <endTime>2026-04-20T10:30:00</endTime>\n      </timeSpan>\n      <mediaSegmentDescriptor>\n        <contentType>video/mp4</contentType>\n        <playbackURI>rtsp://192.168.1.50/...\n      </mediaSegmentDescriptor>\n    </searchMatchItem>\n  </matchList>\n</CMSearchResult>`,
        },
      ],
    },
    {
      id: 'eventos', title: 'Eventos e Alertas', icon: '🔔',
      endpoints: [
        {
          method: 'GET',
          url: '/ISAPI/Event/notification/alertStream',
          desc: 'Inscrição em alertas em tempo real via HTTP long-polling (multipart/mixed). Retorna eventos: detecção de movimento, cruzamento de linha, intrusão, etc.',
          exemplo: `curl --digest -u admin:Senha@123 \\\n  "http://192.168.1.64/ISAPI/Event/notification/alertStream" \\\n  --no-buffer\n\n# Resposta (streaming):\n--boundary\r\nContent-Type: application/xml\r\n\r\n<EventNotificationAlert>\n  <ipAddress>192.168.1.64</ipAddress>\n  <portNo>80</portNo>\n  <channelID>1</channelID>\n  <dateTime>2026-04-20T14:30:00</dateTime>\n  <activePostCount>1</activePostCount>\n  <eventType>VMD</eventType>\n  <eventState>active</eventState>\n  <eventDescription>Motion Detection</eventDescription>\n</EventNotificationAlert>`,
        },
        {
          method: 'GET',
          url: '/ISAPI/WLAlarm/capabilities',
          desc: 'Retorna suporte a detecção inteligente: VCA, face, placa (ANPR), contagem de pessoas.',
        },
        {
          method: 'GET',
          url: '/ISAPI/Smart/LineDetection/1',
          desc: 'Configuração de detecção de cruzamento de linha virtual no canal 1.',
        },
        {
          method: 'GET',
          url: '/ISAPI/Smart/FieldDetection/1',
          desc: 'Configuração de detecção de intrusão em área (cerca virtual) no canal 1.',
        },
      ],
    },
  ]

  const methodColor = (m: string) => {
    if (m === 'GET')    return { bg: 'rgba(59,130,246,.15)',  color: '#60a5fa' }
    if (m === 'POST')   return { bg: 'rgba(16,185,129,.15)',  color: '#34d399' }
    if (m === 'PUT')    return { bg: 'rgba(245,158,11,.15)',  color: '#fbbf24' }
    if (m === 'DELETE') return { bg: 'rgba(239,68,68,.15)',   color: '#f87171' }
    if (m === 'RTSP')   return { bg: 'rgba(139,92,246,.15)',  color: '#a78bfa' }
    if (m === 'WS')     return { bg: 'rgba(20,184,166,.15)',  color: '#2dd4bf' }
    return { bg: 'rgba(100,116,139,.15)', color: '#94a3b8' }
  }

  return (
    <div className="page">

      {/* Intro */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ fontSize: 32 }}>🔴</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
              Documentação da API ISAPI — Câmeras & NVR Hikvision
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
              API REST/XML nativa da Hikvision (protocolo <strong>ISAPI</strong> — Integrated Smart API).
              Compatível com câmeras DS-2CD/DS-2DE, NVRs DS-7600/DS-7700/DS-9600 e DVRs.
              Baseada em análise do repositório{' '}
              <a href="https://github.com/ChenLuoi/hikvision-api" target="_blank" rel="noreferrer"
                style={{ color: 'var(--primary)' }}>ChenLuoi/hikvision-api</a>.<br />
              Autenticação: <strong>HTTP Digest Auth</strong> (RFC 2617) ou <strong>Cookie de sessão</strong>.
              Porta padrão HTTP: <code style={{ fontSize: 11 }}>80</code> ·
              HTTPS: <code style={{ fontSize: 11 }}>443</code> ·
              RTSP: <code style={{ fontSize: 11 }}>554</code> ·
              SDK: <code style={{ fontSize: 11 }}>8000</code>.
              Corpo das requisições em <strong>XML</strong>.
            </div>
          </div>
        </div>

        {/* Quick nav */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 16 }}>
          {sections.map(s => (
            <a key={s.id} href={`#hik-${s.id}`}
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

      {/* Method legend */}
      <div className="card" style={{ marginBottom: 16, padding: '10px 16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>MÉTODOS:</span>
          {[
            { m: 'GET',    label: 'Leitura' },
            { m: 'POST',   label: 'Criação' },
            { m: 'PUT',    label: 'Atualização / Ação' },
            { m: 'DELETE', label: 'Remoção' },
            { m: 'RTSP',   label: 'Streaming' },
            { m: 'WS',     label: 'WebSocket' },
          ].map(({ m, label }) => {
            const mc = methodColor(m)
            return (
              <span key={m} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                <span style={{ padding: '1px 7px', borderRadius: 4, background: mc.bg, color: mc.color, fontWeight: 700, fontSize: 10 }}>{m}</span>
                <span style={{ color: 'var(--text2)' }}>{label}</span>
              </span>
            )
          })}
        </div>
      </div>

      {/* Sections */}
      {sections.map(sec => (
        <div key={sec.id} id={`hik-${sec.id}`} className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{sec.icon}</span>
            {sec.title}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sec.endpoints.map((ep, i) => {
              const mc = methodColor(ep.method)
              return (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', background: 'var(--surface2)' }}>
                    <span style={{
                      fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 4,
                      background: mc.bg, color: mc.color, letterSpacing: '.5px', flexShrink: 0,
                    }}>
                      {ep.method}
                    </span>
                    <code style={{ fontSize: 11, color: 'var(--text)', wordBreak: 'break-all' }}>
                      {ep.url}
                    </code>
                  </div>

                  {/* Body */}
                  <div style={{ padding: '10px 13px' }}>
                    <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: (ep.params || ep.body || ep.exemplo || ep.resposta || ep.nota) ? 10 : 0 }}>
                      {ep.desc}
                    </div>

                    {ep.nota && (
                      <div style={{
                        fontSize: 11, color: '#fbbf24', background: 'rgba(245,158,11,.08)',
                        border: '1px solid rgba(245,158,11,.2)', borderRadius: 6,
                        padding: '6px 10px', marginBottom: 10,
                      }}>
                        ⚠️ {ep.nota}
                      </div>
                    )}

                    {ep.params && (
                      <div style={{ marginBottom: (ep.body || ep.exemplo || ep.resposta) ? 10 : 0 }}>
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

                    {ep.body && (
                      <div style={{ marginBottom: (ep.exemplo || ep.resposta) ? 10 : 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>Request Body (XML)</div>
                        <pre style={{
                          background: 'rgba(0,0,0,.2)', padding: '8px 12px', borderRadius: 6,
                          fontSize: 10, color: '#fca5a5', margin: 0, overflowX: 'auto',
                          lineHeight: 1.6, whiteSpace: 'pre-wrap',
                        }}>{ep.body}</pre>
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
      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>⚠️ Notas e Boas Práticas</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
          <div>• <strong>XML em todas as requisições:</strong> header obrigatório <code>Content-Type: text/xml</code> nos métodos POST/PUT.</div>
          <div>• <strong>Digest Auth vs. Cookie:</strong> Digest é mais simples para scripts. Cookie é preferido para sessões longas — obter via <code>POST /ISAPI/Security/sessionLogin</code> e usar <code>Cookie: WebSession=…</code>.</div>
          <div>• <strong>Hash da senha:</strong> Para login via sessão, a senha deve ser SHA-256(userName + password), depois PBKDF com o salt/challenge retornado. Versão 1 usa MD5; versão 2 usa SHA-256.</div>
          <div>• <strong>trackId para gravações:</strong> channelId × 100 + streamType. Canal 2, stream principal = 201. Canal 2, sub-stream = 202.</div>
          <div>• <strong>Streaming RTSP — porta RTMP:</strong> Hikvision também suporta RTMP em alguns modelos. URL: <code>rtmp://&#123;ip&#125;/live/ch&#123;N&#125;/0</code>.</div>
          <div>• <strong>statusCode=1 = sucesso:</strong> Respostas ResponseStatus com statusCode="1" indicam sucesso. Outros valores indicam erro — verificar subStatusCode para detalhes.</div>
          <div>• <strong>ONVIF:</strong> Além da ISAPI, todos os dispositivos Hikvision suportam ONVIF Profile S/T/G. O endpoint WSD é <code>http://&#123;ip&#125;/onvif/device_service</code>.</div>
          <div>• <strong>SDK Hikvision (HCNetSDK):</strong> Para integrações avançadas (busca por face, ANPR, acesso a cartões), usar o HCNetSDK via TCP na porta 8000.</div>
        </div>
      </div>
    </div>
  )
}
