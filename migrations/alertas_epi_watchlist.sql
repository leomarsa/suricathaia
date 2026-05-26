-- SuricathaIA — Histórico de alertas EPI e Watchlist LPR

CREATE TABLE IF NOT EXISTS alertas_epi (
    id                     BIGSERIAL PRIMARY KEY,
    camera_id              INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    evento_epi_id          BIGINT  REFERENCES eventos_epi(id) ON DELETE SET NULL,
    camera_nome            TEXT,
    total_pessoas          INTEGER NOT NULL DEFAULT 0,
    sem_capacete           INTEGER NOT NULL DEFAULT 0,
    sem_colete             INTEGER NOT NULL DEFAULT 0,
    percentual_conformidade REAL,
    snapshot_path          TEXT,
    notificado             BOOLEAN NOT NULL DEFAULT FALSE,
    criado_em              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_epi_camera ON alertas_epi(camera_id);
CREATE INDEX IF NOT EXISTS idx_alertas_epi_criado ON alertas_epi(criado_em DESC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alertas_watchlist (
    id          BIGSERIAL PRIMARY KEY,
    camera_id   INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    deteccao_id BIGINT  REFERENCES deteccoes(id) ON DELETE SET NULL,
    camera_nome TEXT,
    placa       TEXT NOT NULL,
    tipo        TEXT,
    prioridade  INTEGER NOT NULL DEFAULT 1,
    confianca   REAL,
    crop_path   TEXT,
    notificado  BOOLEAN NOT NULL DEFAULT FALSE,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_watchlist_camera ON alertas_watchlist(camera_id);
CREATE INDEX IF NOT EXISTS idx_alertas_watchlist_placa  ON alertas_watchlist(placa);
CREATE INDEX IF NOT EXISTS idx_alertas_watchlist_criado ON alertas_watchlist(criado_em DESC);
