-- /app/migrations/telemetria.sql
-- SuricathaIA — Video Telemétrica: Gestão de Frota

CREATE TABLE IF NOT EXISTS motoristas (
    id          SERIAL PRIMARY KEY,
    nome        TEXT NOT NULL,
    cpf         TEXT UNIQUE,
    cnh         TEXT,
    categoria   TEXT DEFAULT 'B',
    telefone    TEXT,
    foto_url    TEXT,
    ativo       BOOLEAN DEFAULT TRUE,
    criado_em   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS veiculos (
    id           SERIAL PRIMARY KEY,
    placa        TEXT UNIQUE NOT NULL,
    modelo       TEXT,
    marca        TEXT,
    ano          INTEGER,
    tipo         TEXT DEFAULT 'truck',  -- truck | van | car | moto
    camera_id    INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    motorista_id INTEGER REFERENCES motoristas(id) ON DELETE SET NULL,
    ativo        BOOLEAN DEFAULT TRUE,
    criado_em    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eventos_telemetria (
    id               SERIAL PRIMARY KEY,
    veiculo_id       INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    motorista_id     INTEGER REFERENCES motoristas(id) ON DELETE SET NULL,
    camera_id        INTEGER,
    tipo_evento      TEXT NOT NULL,     -- fadiga | celular | distracao | bocejo
    severidade       TEXT DEFAULT 'medio',  -- baixo | medio | alto | critico
    confianca        FLOAT,
    ear_score        FLOAT,             -- Eye Aspect Ratio no momento da detecção
    mar_score        FLOAT,             -- Mouth Aspect Ratio
    duracao_ms       INTEGER,
    snapshot_path    TEXT,
    detectado_em     TIMESTAMPTZ DEFAULT NOW(),
    tempo_processo_ms INTEGER
);

CREATE TABLE IF NOT EXISTS config_telemetria (
    id                SERIAL PRIMARY KEY,
    camera_id         INTEGER REFERENCES cameras(id) ON DELETE CASCADE UNIQUE,
    ativo             BOOLEAN DEFAULT TRUE,
    ear_threshold     FLOAT DEFAULT 0.25,
    ear_frames_alert  INTEGER DEFAULT 15,
    mar_threshold     FLOAT DEFAULT 0.55,
    phone_conf        FLOAT DEFAULT 0.55,
    cooldown_seg      INTEGER DEFAULT 60,
    notif_sonoro      BOOLEAN DEFAULT TRUE,
    notif_whatsapp    BOOLEAN DEFAULT FALSE,
    notif_telegram    BOOLEAN DEFAULT FALSE,
    destinatarios     JSONB DEFAULT '[]',
    criado_em         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eventos_tel_cam    ON eventos_telemetria(camera_id);
CREATE INDEX IF NOT EXISTS idx_eventos_tel_tipo   ON eventos_telemetria(tipo_evento);
CREATE INDEX IF NOT EXISTS idx_eventos_tel_det    ON eventos_telemetria(detectado_em DESC);
CREATE INDEX IF NOT EXISTS idx_veiculos_camera    ON veiculos(camera_id);
