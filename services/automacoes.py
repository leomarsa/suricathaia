"""
/app/services/automacoes.py
SuricathaIA — Motor de Automação de Alertas

Monitora eventos do sistema e dispara notificações via WhatsApp/Telegram
conforme regras configuradas em automacoes_alertas.

Tipos de evento suportados:
  watchlist_hit     — placa detectada que está na watchlist
  camera_offline    — câmera sem detecções por X minutos
  pessoa_detectada  — contagem de pessoas acima do threshold
  epi_violacao      — violação de EPI detectada
  lpr_qualquer      — qualquer leitura LPR (filtro por câmera opcional)
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent.parent / ".env")

log = logging.getLogger("suricatha.automacoes")

DB_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db",
)

POLL_INTERVAL = 30   # seconds between checks
RULE_RELOAD   = 60   # seconds between rule reloads


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    return psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)


# ── Message builder ───────────────────────────────────────────────────────────

_DEFAULT_MSGS = {
    "watchlist_hit": (
        "🚨 *ALERTA WATCHLIST — SURICATHA IA*\n\n"
        "🚗 Placa: `{placa}`\n"
        "📋 Tipo: {tipo}\n"
        "📷 Câmera: {camera}\n"
        "🎯 Confiança: {confianca}%\n"
        "🕐 Horário: {hora} · {data}"
    ),
    "camera_offline": (
        "⚠️ *CÂMERA OFFLINE — SURICATHA IA*\n\n"
        "📷 Câmera: {camera}\n"
        "⏱️ Sem detecções há {minutos} minutos\n"
        "🕐 {hora} · {data}"
    ),
    "pessoa_detectada": (
        "👤 *PESSOA DETECTADA — SURICATHA IA*\n\n"
        "📷 Câmera: {camera}\n"
        "👥 Total: {total} {plural}\n"
        "🕐 {hora} · {data}"
    ),
    "epi_violacao": (
        "🦺 *VIOLAÇÃO EPI — SURICATHA IA*\n\n"
        "📷 Câmera: {camera}\n"
        "⚠️ EPI ausente: {epi_tipo}\n"
        "🕐 {hora} · {data}"
    ),
    "lpr_qualquer": (
        "📸 *LEITURA LPR — SURICATHA IA*\n\n"
        "🚗 Placa: `{placa}`\n"
        "📷 Câmera: {camera}\n"
        "🎯 Confiança: {confianca}%\n"
        "🕐 {hora} · {data}"
    ),
}


def _build_msg(rule: dict, ctx: dict) -> str:
    template = rule.get("mensagem_custom") or _DEFAULT_MSGS.get(rule["tipo_evento"], "{evento}")
    hora = time.strftime("%H:%M:%S")
    data = time.strftime("%d/%m/%Y")
    total = ctx.get("total", 1)
    return (
        template
        .replace("{placa}",    ctx.get("placa", ""))
        .replace("{tipo}",     ctx.get("tipo", "").upper())
        .replace("{camera}",   ctx.get("camera", ""))
        .replace("{confianca}", f"{ctx.get('confianca', 0):.1f}")
        .replace("{total}",    str(total))
        .replace("{plural}",   "pessoa" if total == 1 else "pessoas")
        .replace("{epi_tipo}", ctx.get("epi_tipo", ""))
        .replace("{minutos}",  str(ctx.get("minutos", 0)))
        .replace("{hora}",     hora)
        .replace("{data}",     data)
        .replace("{evento}",   rule.get("tipo_evento", ""))
    )


# ── Schedule check ────────────────────────────────────────────────────────────

def _in_schedule(rule: dict) -> bool:
    import datetime
    now = datetime.datetime.now()
    dias = rule.get("dias_semana")
    if dias:
        # 0=Dom, 1=Seg…6=Sab; Python weekday: 0=Mon…6=Sun
        wd = (now.weekday() + 1) % 7
        if wd not in dias:
            return False
    hi = rule.get("horario_inicio")
    hf = rule.get("horario_fim")
    if hi and hf:
        t = now.time().replace(second=0, microsecond=0)
        if not (hi <= t <= hf):
            return False
    return True


# ── Dispatch channels ─────────────────────────────────────────────────────────

def _dispatch(rule: dict, msg: str) -> list[str]:
    canais = rule.get("canais") or {}
    sent = []

    # Telegram
    if canais.get("telegram"):
        try:
            from services.telegram_svc import send_message, is_configured
            if is_configured():
                r = send_message(msg)
                if r.get("ok"):
                    sent.append("telegram")
                    log.info("[AUTO] Telegram enviado — regra '%s'", rule["nome"])
                else:
                    log.warning("[AUTO] Telegram falhou: %s", r.get("error"))
        except Exception as exc:
            log.warning("[AUTO] Telegram erro: %s", exc)

    # WhatsApp
    phones = canais.get("whatsapp") or []
    if phones:
        try:
            from services.whatsapp_evo import send_text, is_configured
            if is_configured():
                plain = msg.replace("*", "").replace("`", "")
                for phone in phones:
                    r = send_text(phone.strip(), plain)
                    if r.get("ok"):
                        sent.append(f"whatsapp:{phone}")
                        log.info("[AUTO] WhatsApp enviado para %s — regra '%s'", phone, rule["nome"])
                    else:
                        log.warning("[AUTO] WhatsApp falhou para %s: %s", phone, r.get("error"))
        except Exception as exc:
            log.warning("[AUTO] WhatsApp erro: %s", exc)

    return sent


# ── Record to history ─────────────────────────────────────────────────────────

def _record(conn, rule_id: int, tipo: str, ctx: dict, sent: list, msg: str):
    import json
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO automacoes_historico
                    (automacao_id, tipo_evento, contexto, canais_enviados, mensagem)
                VALUES (%s, %s, %s::jsonb, %s, %s)
            """, (rule_id, tipo, json.dumps(ctx), sent, msg))
        conn.commit()
    except Exception as exc:
        log.warning("[AUTO] Falha ao registrar histórico: %s", exc)
        conn.rollback()


# ── Main engine ───────────────────────────────────────────────────────────────

class AutomacoesEngine:
    def __init__(self):
        self._rules: list[dict] = []
        self._rules_lock = threading.Lock()
        self._cooldowns: dict[str, float] = {}   # "rule_id:ctx_key" → last_fired_ts
        self._last_ids = {
            "watchlist": 0,
            "epi":       0,
            "pessoas":   0,
            "lpr":       0,
        }
        self._last_rule_load = 0.0
        self._stop = False

    def start(self):
        t = threading.Thread(target=self._loop, daemon=True, name="automacoes-engine")
        t.start()
        log.info("[AUTO] Motor de automações iniciado")

    def stop(self):
        self._stop = True

    def reload_rules(self):
        """Recarrega as regras do banco imediatamente."""
        try:
            conn = _conn()
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, nome, tipo_evento, condicoes, canais,
                           mensagem_custom, cooldown_min,
                           horario_inicio, horario_fim, dias_semana
                    FROM automacoes_alertas
                    WHERE ativo = TRUE
                    ORDER BY id
                """)
                rows = [dict(r) for r in cur.fetchall()]
            conn.close()
            with self._rules_lock:
                self._rules = rows
            self._last_rule_load = time.time()
            log.info("[AUTO] %d regra(s) ativa(s) carregada(s)", len(rows))
        except Exception as exc:
            log.error("[AUTO] Erro ao carregar regras: %s", exc)

    def _loop(self):
        time.sleep(3)
        self.reload_rules()
        self._init_last_ids()

        while not self._stop:
            try:
                if time.time() - self._last_rule_load > RULE_RELOAD:
                    self.reload_rules()
                self._run_checks()
            except Exception as exc:
                log.error("[AUTO] Erro no loop: %s", exc)
            time.sleep(POLL_INTERVAL)

    def _init_last_ids(self):
        """Inicializa last_ids com os IDs mais recentes do banco."""
        try:
            conn = _conn()
            with conn.cursor() as cur:
                for table, key in [
                    ("deteccoes WHERE watchlist_hit", "watchlist"),
                    ("deteccoes", "lpr"),
                    ("eventos_epi", "epi"),
                    ("contagens_pessoas", "pessoas"),
                ]:
                    cur.execute(f"SELECT COALESCE(MAX(id),0) FROM {table}")
                    self._last_ids[key] = cur.fetchone()[0]
            conn.close()
        except Exception as exc:
            log.warning("[AUTO] Erro ao inicializar last_ids: %s", exc)

    # ── Checks ────────────────────────────────────────────────────────────────

    def _run_checks(self):
        with self._rules_lock:
            rules = list(self._rules)
        if not rules:
            return

        tipos = {r["tipo_evento"] for r in rules}
        try:
            conn = _conn()
            if "watchlist_hit" in tipos:
                self._check_watchlist(conn, rules)
            if "lpr_qualquer" in tipos:
                self._check_lpr(conn, rules)
            if "pessoa_detectada" in tipos:
                self._check_pessoas(conn, rules)
            if "epi_violacao" in tipos:
                self._check_epi(conn, rules)
            if "camera_offline" in tipos:
                self._check_offline(conn, rules)
            conn.close()
        except Exception as exc:
            log.error("[AUTO] Erro nos checks: %s", exc)

    def _check_watchlist(self, conn, rules):
        with conn.cursor() as cur:
            cur.execute("""
                SELECT d.id, d.placa, d.camera_id, c.nome AS camera_nome,
                       d.confianca_final AS confianca, w.tipo AS tipo_watchlist, d.detectado_em
                FROM deteccoes d
                JOIN cameras c ON c.id = d.camera_id
                LEFT JOIN watchlist w ON w.id = d.watchlist_id
                WHERE d.watchlist_hit = TRUE AND d.id > %s
                ORDER BY d.id
                LIMIT 50
            """, (self._last_ids["watchlist"],))
            rows = cur.fetchall()

        for row in rows:
            self._last_ids["watchlist"] = max(self._last_ids["watchlist"], row["id"])
            ctx = {
                "camera":    row["camera_nome"],
                "camera_id": row["camera_id"],
                "placa":     row["placa"],
                "tipo":      row["tipo_watchlist"] or "monitorado",
                "confianca": (row["confianca"] or 0) * 100,
            }
            for rule in rules:
                if rule["tipo_evento"] != "watchlist_hit":
                    continue
                cond = rule.get("condicoes") or {}
                if cond.get("camera_ids") and row["camera_id"] not in cond["camera_ids"]:
                    continue
                tipos_ok = cond.get("tipos") or []
                if tipos_ok and ctx["tipo"] not in tipos_ok:
                    continue
                pmin = cond.get("prioridade_min", 1)
                prioridades = {"monitorado": 1, "suspeito": 2, "bloqueado": 3, "vip": 1, "roubado": 5}
                if prioridades.get(ctx["tipo"], 1) < pmin:
                    continue
                self._maybe_dispatch(conn, rule, ctx, ctx["placa"])

    def _check_lpr(self, conn, rules):
        with conn.cursor() as cur:
            cur.execute("""
                SELECT d.id, d.placa, d.camera_id, c.nome AS camera_nome, d.confianca_final AS confianca
                FROM deteccoes d
                JOIN cameras c ON c.id = d.camera_id
                WHERE d.id > %s
                ORDER BY d.id
                LIMIT 100
            """, (self._last_ids["lpr"],))
            rows = cur.fetchall()

        for row in rows:
            self._last_ids["lpr"] = max(self._last_ids["lpr"], row["id"])
            ctx = {
                "camera":    row["camera_nome"],
                "camera_id": row["camera_id"],
                "placa":     row["placa"],
                "confianca": (row["confianca"] or 0) * 100,
            }
            for rule in rules:
                if rule["tipo_evento"] != "lpr_qualquer":
                    continue
                cond = rule.get("condicoes") or {}
                if cond.get("camera_ids") and row["camera_id"] not in cond["camera_ids"]:
                    continue
                self._maybe_dispatch(conn, rule, ctx, ctx["placa"])

    def _check_pessoas(self, conn, rules):
        with conn.cursor() as cur:
            cur.execute("""
                SELECT cp.id, cp.camera_id, c.nome AS camera_nome, cp.total_pessoas
                FROM contagens_pessoas cp
                JOIN cameras c ON c.id = cp.camera_id
                WHERE cp.id > %s AND cp.total_pessoas > 0
                ORDER BY cp.id
                LIMIT 50
            """, (self._last_ids["pessoas"],))
            rows = cur.fetchall()

        for row in rows:
            self._last_ids["pessoas"] = max(self._last_ids["pessoas"], row["id"])
            ctx = {
                "camera":    row["camera_nome"],
                "camera_id": row["camera_id"],
                "total":     row["total_pessoas"],
            }
            for rule in rules:
                if rule["tipo_evento"] != "pessoa_detectada":
                    continue
                cond = rule.get("condicoes") or {}
                if cond.get("camera_ids") and row["camera_id"] not in cond["camera_ids"]:
                    continue
                if row["total_pessoas"] < (cond.get("min_pessoas") or 1):
                    continue
                self._maybe_dispatch(conn, rule, ctx, str(row["camera_id"]))

    def _check_epi(self, conn, rules):
        with conn.cursor() as cur:
            cur.execute("""
                SELECT e.id, e.camera_id, c.nome AS camera_nome,
                       e.epi_tipo, e.detectado_em
                FROM eventos_epi e
                JOIN cameras c ON c.id = e.camera_id
                WHERE e.id > %s
                ORDER BY e.id
                LIMIT 50
            """, (self._last_ids["epi"],))
            rows = cur.fetchall()

        for row in rows:
            self._last_ids["epi"] = max(self._last_ids["epi"], row["id"])
            ctx = {
                "camera":    row["camera_nome"],
                "camera_id": row["camera_id"],
                "epi_tipo":  row.get("epi_tipo", "desconhecido"),
            }
            for rule in rules:
                if rule["tipo_evento"] != "epi_violacao":
                    continue
                cond = rule.get("condicoes") or {}
                if cond.get("camera_ids") and row["camera_id"] not in cond["camera_ids"]:
                    continue
                tipos_epi = cond.get("tipos_epi") or []
                if tipos_epi and ctx["epi_tipo"] not in tipos_epi:
                    continue
                self._maybe_dispatch(conn, rule, ctx, str(row["camera_id"]))

    def _check_offline(self, conn, rules):
        for rule in rules:
            if rule["tipo_evento"] != "camera_offline":
                continue
            cond = rule.get("condicoes") or {}
            minutos = cond.get("minutos_sem_deteccao") or 10
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT c.id, c.nome,
                           EXTRACT(EPOCH FROM (NOW() - MAX(d.detectado_em)))/60 AS min_ago
                    FROM cameras c
                    LEFT JOIN deteccoes d ON d.camera_id = c.id
                    WHERE c.ativa = TRUE
                    GROUP BY c.id, c.nome
                    HAVING MAX(d.detectado_em) IS NULL
                       OR EXTRACT(EPOCH FROM (NOW() - MAX(d.detectado_em)))/60 > %s
                """, (minutos,))
                rows = cur.fetchall()

            cam_ids = cond.get("camera_ids") or []
            for row in rows:
                if cam_ids and row["id"] not in cam_ids:
                    continue
                ctx = {
                    "camera":    row["nome"],
                    "camera_id": row["id"],
                    "minutos":   int(row["min_ago"] or 0),
                }
                self._maybe_dispatch(conn, rule, ctx, str(row["id"]))

    # ── Dispatch gate ─────────────────────────────────────────────────────────

    def _maybe_dispatch(self, conn, rule: dict, ctx: dict, cooldown_key: str):
        if not _in_schedule(rule):
            return

        ck = f"{rule['id']}:{cooldown_key}"
        last = self._cooldowns.get(ck, 0)
        cooldown_s = (rule.get("cooldown_min") or 5) * 60
        if time.time() - last < cooldown_s:
            return

        msg = _build_msg(rule, ctx)
        sent = _dispatch(rule, msg)
        if sent:
            self._cooldowns[ck] = time.time()
            _record(conn, rule["id"], rule["tipo_evento"], ctx, sent, msg)
            log.info("[AUTO] Regra '%s' disparou → %s", rule["nome"], sent)


# ── Singleton ─────────────────────────────────────────────────────────────────

_engine: Optional[AutomacoesEngine] = None


def get_engine() -> AutomacoesEngine:
    global _engine
    if _engine is None:
        _engine = AutomacoesEngine()
    return _engine


def start_engine() -> AutomacoesEngine:
    eng = get_engine()
    eng.start()
    return eng
