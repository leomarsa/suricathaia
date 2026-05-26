-- ═══════════════════════════════════════════════════════════════════════
--  SuricathaIA — Módulo de Gestão de Portaria
--  Migração: visitantes, anfitrioes, visitas, audit_logs
-- ═══════════════════════════════════════════════════════════════════════

-- ── Visitantes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visitantes (
    id               SERIAL PRIMARY KEY,
    nome             VARCHAR(128) NOT NULL,
    documento        VARCHAR(32)  NOT NULL,
    tipo_documento   VARCHAR(16)  NOT NULL DEFAULT 'CPF'
                     CHECK (tipo_documento IN ('CPF','RG','CNH','Passaporte','RNE','Outro')),
    empresa          VARCHAR(128),
    foto_url         TEXT,
    status_blacklist BOOLEAN      NOT NULL DEFAULT FALSE,
    observacoes      TEXT,
    criado_em        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    atualizado_em    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS visitantes_doc_uidx ON visitantes(documento);
CREATE INDEX        IF NOT EXISTS visitantes_nome_idx  ON visitantes(lower(nome));

-- ── Anfitriões ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS anfitrioes (
    id            SERIAL PRIMARY KEY,
    nome          VARCHAR(128) NOT NULL,
    departamento  VARCHAR(64),
    ramal         VARCHAR(20),
    email         VARCHAR(128),
    ativo         BOOLEAN     NOT NULL DEFAULT TRUE,
    criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS anfitrioes_nome_idx ON anfitrioes(lower(nome));

-- ── Visitas ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visitas (
    id              BIGSERIAL PRIMARY KEY,
    visitante_id    INTEGER     NOT NULL REFERENCES visitantes(id) ON DELETE RESTRICT,
    anfitriao_id    INTEGER     REFERENCES anfitrioes(id) ON DELETE SET NULL,
    placa_veiculo   VARCHAR(10),
    lpr_deteccao_id BIGINT      REFERENCES deteccoes(id) ON DELETE SET NULL,
    data_entrada    TIMESTAMPTZ,
    data_saida      TIMESTAMPTZ,
    status          VARCHAR(16) NOT NULL DEFAULT 'agendado'
                    CHECK (status IN ('agendado','aguardando','em_visita','saiu','cancelado')),
    motivo          VARCHAR(256),
    observacoes     TEXT,
    criado_por      VARCHAR(128),
    criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS visitas_visitante_idx   ON visitas(visitante_id);
CREATE INDEX IF NOT EXISTS visitas_status_idx      ON visitas(status);
CREATE INDEX IF NOT EXISTS visitas_placa_idx       ON visitas(placa_veiculo) WHERE placa_veiculo IS NOT NULL;
CREATE INDEX IF NOT EXISTS visitas_entrada_idx     ON visitas(data_entrada DESC);

-- ── Audit Logs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    tabela      VARCHAR(64)  NOT NULL,
    operacao    VARCHAR(16)  NOT NULL
                CHECK (operacao IN ('INSERT','UPDATE','DELETE','CHECKIN','CHECKOUT','LOGIN')),
    registro_id BIGINT,
    dados_antes JSONB,
    dados_depois JSONB,
    usuario_id  VARCHAR(128),
    ip_cliente  VARCHAR(64),
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_tabela_op_idx ON audit_logs(tabela, operacao);
CREATE INDEX IF NOT EXISTS audit_ts_idx        ON audit_logs(criado_em DESC);

-- ── Dados iniciais (anfitriões de exemplo) ────────────────────────────────────
INSERT INTO anfitrioes (nome, departamento, ramal, email) VALUES
    ('Recepção Geral',  'Administrativo', '100', NULL)
ON CONFLICT DO NOTHING;
