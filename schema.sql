-- SuricathaIA — Schema PostgreSQL

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Câmeras ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cameras (
    id          SERIAL PRIMARY KEY,
    uuid        UUID NOT NULL DEFAULT gen_random_uuid(),
    nome        VARCHAR(64)  NOT NULL,
    local       VARCHAR(128) NOT NULL,
    descricao   TEXT,
    ip_sftp     INET,
    ativa       BOOLEAN NOT NULL DEFAULT TRUE,
    latitude    DOUBLE PRECISION,
    longitude   DOUBLE PRECISION,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cameras_uuid_uidx ON cameras(uuid);

-- Câmera padrão (fallback quando prefixo não resolve)
INSERT INTO cameras (id, nome, local) VALUES (1, 'CAM01', 'Entrada Principal')
    ON CONFLICT (id) DO NOTHING;

-- ── Watchlist ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
    id            SERIAL PRIMARY KEY,
    uuid          UUID NOT NULL DEFAULT gen_random_uuid(),
    placa         CHAR(7)  NOT NULL,
    tipo          VARCHAR(16) NOT NULL DEFAULT 'suspeito'
                  CHECK (tipo IN ('suspeito','roubado','bloqueado','vip','monitorado')),
    descricao     TEXT,
    prioridade    SMALLINT NOT NULL DEFAULT 3 CHECK (prioridade BETWEEN 1 AND 5),
    ativa         BOOLEAN NOT NULL DEFAULT TRUE,
    alerta_sonoro BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS watchlist_placa_uidx ON watchlist(placa);

-- ── Detecções ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deteccoes (
    id                BIGSERIAL PRIMARY KEY,
    uuid              UUID NOT NULL DEFAULT gen_random_uuid(),
    camera_id         INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    placa_raw_1       VARCHAR(10),
    confianca_1       REAL,
    placa_raw_2       VARCHAR(10),
    confianca_2       REAL,
    placa             VARCHAR(10),
    confianca_final   REAL,
    validado          BOOLEAN NOT NULL DEFAULT FALSE,
    divergencia       BOOLEAN NOT NULL DEFAULT FALSE,
    watchlist_hit     BOOLEAN NOT NULL DEFAULT FALSE,
    watchlist_id      INTEGER REFERENCES watchlist(id) ON DELETE SET NULL,
    arquivo_original  VARCHAR(256),
    caminho_storage   TEXT,
    raw_texts         TEXT[],
    tempo_processo_ms INTEGER,
    detectado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sincronizado      BOOLEAN NOT NULL DEFAULT FALSE,
    erro              TEXT
);

CREATE INDEX IF NOT EXISTS deteccoes_placa_idx      ON deteccoes(placa);
CREATE INDEX IF NOT EXISTS deteccoes_detectado_idx  ON deteccoes(detectado_em DESC);
CREATE INDEX IF NOT EXISTS deteccoes_wl_hit_idx     ON deteccoes(watchlist_hit) WHERE watchlist_hit;

-- ── Trigger: verifica watchlist após INSERT ───────────────────────────────────
CREATE OR REPLACE FUNCTION fn_check_watchlist()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.placa IS NOT NULL THEN
        SELECT id INTO NEW.watchlist_id
        FROM watchlist
        WHERE placa = NEW.placa AND ativa
        LIMIT 1;

        NEW.watchlist_hit := (NEW.watchlist_id IS NOT NULL);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_watchlist ON deteccoes;
CREATE TRIGGER trg_check_watchlist
    BEFORE INSERT ON deteccoes
    FOR EACH ROW EXECUTE FUNCTION fn_check_watchlist();
