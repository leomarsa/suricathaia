"""
/app/services/reports.py
SuricathaIA — Relatórios Agendados por Câmera
Gera relatórios diários/horários e envia via Telegram e/ou salva em arquivo.
"""

import os
import csv
import time
import json
import logging
import threading
import io
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
import psycopg2
from psycopg2.extras import RealDictCursor

log = logging.getLogger("suricatha.reports")

REPORT_DIR       = Path(os.getenv("REPORT_DIR",  "/opt/suricatha/reports"))
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
REPORT_HOUR      = int(os.getenv("REPORT_HOUR", "6"))   # hora UTC do relatório diário

PG_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db"
)


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    return psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)


# ── Coleta de dados ───────────────────────────────────────────────────────────
def _fetch_daily_stats(date_str: str) -> dict:
    """Coleta estatísticas de detecções do dia para todas as câmeras."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            # Totais gerais
            cur.execute("""
                SELECT
                    count(*)                                   AS total,
                    count(*) FILTER (WHERE validado)           AS validadas,
                    count(*) FILTER (WHERE watchlist_hit)      AS wl_hits,
                    count(*) FILTER (WHERE divergencia)        AS divergencias,
                    coalesce(avg(confianca_final),0)::numeric(5,3)  AS conf_media,
                    coalesce(avg(tempo_processo_ms),0)::int    AS tempo_medio_ms,
                    count(*) FILTER (WHERE NOT sincronizado)   AS sync_pendentes
                FROM deteccoes
                WHERE detectado_em::date = %s
            """, (date_str,))
            totais = dict(cur.fetchone())

            # Por câmera
            cur.execute("""
                SELECT
                    c.nome                                     AS camera,
                    c.local,
                    count(d.id)                                AS total,
                    count(d.id) FILTER (WHERE d.validado)      AS validadas,
                    count(d.id) FILTER (WHERE d.watchlist_hit) AS wl_hits,
                    coalesce(avg(d.confianca_final),0)::numeric(5,3) AS conf_media
                FROM cameras c
                LEFT JOIN deteccoes d
                    ON d.camera_id = c.id
                    AND d.detectado_em::date = %s
                WHERE c.ativa
                GROUP BY c.id, c.nome, c.local
                ORDER BY total DESC
            """, (date_str,))
            por_camera = [dict(r) for r in cur.fetchall()]

            # Top 10 placas mais frequentes
            cur.execute("""
                SELECT placa, count(*) AS ocorrencias
                FROM deteccoes
                WHERE detectado_em::date = %s AND placa IS NOT NULL
                GROUP BY placa
                ORDER BY ocorrencias DESC
                LIMIT 10
            """, (date_str,))
            top_placas = [dict(r) for r in cur.fetchall()]

            # Watchlist hits detalhados
            cur.execute("""
                SELECT
                    d.placa,
                    w.tipo,
                    w.prioridade,
                    c.nome AS camera,
                    TO_CHAR(d.detectado_em, 'HH24:MI:SS') AS horario
                FROM deteccoes d
                JOIN watchlist w ON w.id = d.watchlist_id
                LEFT JOIN cameras c ON c.id = d.camera_id
                WHERE d.detectado_em::date = %s AND d.watchlist_hit
                ORDER BY w.prioridade DESC, d.detectado_em
            """, (date_str,))
            wl_hits = [dict(r) for r in cur.fetchall()]

        return {
            "date"      : date_str,
            "totais"    : totais,
            "por_camera": por_camera,
            "top_placas": top_placas,
            "wl_hits"   : wl_hits,
        }
    finally:
        conn.close()


def _fetch_hourly_stats(camera_id: Optional[int] = None) -> dict:
    """Estatísticas da última hora, opcionalmente por câmera."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            where = "AND camera_id = %s" if camera_id else ""
            params = [camera_id] if camera_id else []

            cur.execute(f"""
                SELECT
                    count(*)                              AS total,
                    count(*) FILTER (WHERE validado)      AS validadas,
                    count(*) FILTER (WHERE watchlist_hit) AS wl_hits,
                    coalesce(avg(confianca_final),0)::numeric(5,3) AS conf_media,
                    coalesce(avg(tempo_processo_ms),0)::int AS tempo_medio_ms
                FROM deteccoes
                WHERE detectado_em >= NOW() - INTERVAL '1 hour' {where}
            """, params)
            return dict(cur.fetchone())
    finally:
        conn.close()


# ── Formatação ────────────────────────────────────────────────────────────────
def _format_daily_telegram(data: dict) -> str:
    t = data["totais"]
    lines = [
        f"📊 *RELATÓRIO DIÁRIO — {data['date']}*",
        f"",
        f"🔢 Total de detecções: *{t['total']}*",
        f"✅ Validadas: *{t['validadas']}*",
        f"🎯 Confiança média: *{float(t['conf_media'])*100:.1f}%*",
        f"⏱ Tempo médio OCR: *{t['tempo_medio_ms']}ms*",
        f"",
    ]

    if t["wl_hits"]:
        lines.append(f"🚨 *Alertas Watchlist: {t['wl_hits']}*")
        for hit in data["wl_hits"][:5]:
            stars = "⭐" * hit["prioridade"]
            lines.append(f"  • `{hit['placa']}` {hit['tipo']} {stars} — "
                         f"{hit['camera']} às {hit['horario']}")
        lines.append("")

    if data["por_camera"]:
        lines.append("📷 *Por câmera:*")
        for c in data["por_camera"]:
            if c["total"] > 0:
                lines.append(f"  • {c['camera']} ({c['local']}): "
                             f"*{c['total']}* det | {c['wl_hits']} alertas")
        lines.append("")

    if data["top_placas"]:
        lines.append("🏆 *Top placas:*")
        for p in data["top_placas"][:5]:
            lines.append(f"  • `{p['placa']}` — {p['ocorrencias']}x")

    return "\n".join(lines)


# ── Exportação CSV ────────────────────────────────────────────────────────────
def _export_csv(data: dict) -> Path:
    """Salva relatório CSV em /opt/suricatha/reports/."""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / f"relatorio_{data['date']}.csv"

    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    d.id, d.placa, d.confianca_final, d.validado,
                    d.divergencia, d.watchlist_hit,
                    c.nome AS camera, c.local AS camera_local,
                    d.arquivo_original, d.caminho_storage,
                    d.tempo_processo_ms, d.detectado_em
                FROM deteccoes d
                LEFT JOIN cameras c ON c.id = d.camera_id
                WHERE d.detectado_em::date = %s
                ORDER BY d.detectado_em
            """, (data["date"],))
            rows = cur.fetchall()
    finally:
        conn.close()

    with open(path, "w", newline="", encoding="utf-8") as f:
        if rows:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)

    log.info("[SURICATHA-LOG] %s - CSV exportado: %s (%d linhas)",
             _ts(), path, len(rows))
    return path


# ── Envio Telegram ────────────────────────────────────────────────────────────
def _send_telegram_text(text: str):
    try:
        from services.telegram_svc import send_message, is_configured
        if not is_configured():
            return
        result = send_message(text)
        if not result.get("ok"):
            log.error("[SURICATHA-LOG] %s - Telegram report erro: %s", _ts(), result.get("error"))
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Telegram report erro: %s", _ts(), exc)


def _send_telegram_document(path: Path, caption: str):
    try:
        from services.telegram_svc import get_config, is_configured
        import httpx as _httpx
        cfg = get_config()
        if not is_configured(cfg):
            return
        with _httpx.Client(timeout=30) as client:
            with open(path, "rb") as f:
                client.post(
                    f"https://api.telegram.org/bot{cfg['token']}/sendDocument",
                    data={"chat_id": cfg["chat_id"], "caption": caption},
                    files={"document": (path.name, f, "text/csv")},
                )
        log.info("[SURICATHA-LOG] %s - CSV enviado via Telegram", _ts())
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Telegram document erro: %s", _ts(), exc)


# ── Geração de relatório ──────────────────────────────────────────────────────
def generate_daily_report(date_str: Optional[str] = None):
    """
    Gera e envia relatório diário.
    date_str: 'YYYY-MM-DD' — padrão: ontem
    """
    if date_str is None:
        date_str = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")

    log.info("[SURICATHA-LOG] %s - Gerando relatório diário: %s", _ts(), date_str)

    data = _fetch_daily_stats(date_str)

    # Telegram
    msg = _format_daily_telegram(data)
    _send_telegram_text(msg)

    # CSV
    csv_path = _export_csv(data)
    _send_telegram_document(csv_path, f"📎 Detecções completas — {date_str}")

    # JSON para auditoria
    json_path = REPORT_DIR / f"relatorio_{date_str}.json"
    json_path.write_text(json.dumps(data, default=str, ensure_ascii=False, indent=2))

    log.info("[SURICATHA-LOG] %s - Relatório diário concluído", _ts())
    return data


# ── Scheduler ─────────────────────────────────────────────────────────────────
class ReportScheduler:
    """
    Roda em background thread.
    - Relatório diário: todo dia às REPORT_HOUR horas UTC
    - Pode ser estendido para relatórios horários por câmera
    """

    def __init__(self):
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="report-scheduler"
        )

    def start(self):
        self._thread.start()
        log.info("[SURICATHA-LOG] %s - ReportScheduler iniciado (diário às %02d:00 UTC)",
                 _ts(), REPORT_HOUR)

    def stop(self):
        self._stop.set()

    def _run(self):
        last_report_date = None

        while not self._stop.is_set():
            now  = datetime.now(timezone.utc)
            hour = now.hour
            date = now.strftime("%Y-%m-%d")

            # Dispara relatório do dia anterior na hora configurada
            if hour == REPORT_HOUR and date != last_report_date:
                last_report_date = date
                try:
                    generate_daily_report()
                except Exception as exc:
                    log.error("[SURICATHA-LOG] %s - Scheduler erro: %s", _ts(), exc)

            # Verifica a cada 5 minutos
            self._stop.wait(timeout=300)
