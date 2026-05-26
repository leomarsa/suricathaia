-- SuricathaIA — Histórico de alertas de lotação de pessoas

CREATE TABLE IF NOT EXISTS alertas_lotacao (
    id              BIGSERIAL PRIMARY KEY,
    camera_id       INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    contagem_id     BIGINT  REFERENCES contagens_pessoas(id) ON DELETE SET NULL,
    camera_nome     TEXT,
    total_pessoas   INTEGER NOT NULL,
    limite_pessoas  INTEGER,
    confianca_media REAL,
    snapshot_path   TEXT,
    notificado      BOOLEAN NOT NULL DEFAULT FALSE,
    criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_lotacao_camera  ON alertas_lotacao(camera_id);
CREATE INDEX IF NOT EXISTS idx_alertas_lotacao_criado  ON alertas_lotacao(criado_em DESC);
