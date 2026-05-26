"""
/app/services/telegram_svc.py
SuricathaIA — Telegram Bot Service

Responsável por toda a comunicação com a API do Telegram:
  - Lê configuração do banco (configuracoes.telegram_config)
  - Fallback para variáveis de ambiente (.env)
  - Gerencia envio de mensagens, fotos e verificação de bot
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

import httpx
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent.parent / ".env")

log = logging.getLogger("suricatha.telegram")

DB_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db",
)

TIMEOUT = 10
TELEGRAM_API = "https://api.telegram.org"


# ── Config management ─────────────────────────────────────────────────────────

def get_config() -> dict:
    """
    Lê a configuração Telegram do banco de dados.
    Fallback para variáveis de ambiente se o banco não tiver config.
    Retorna dict com: token, chat_id, parse_mode.
    """
    try:
        conn = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT valor FROM configuracoes WHERE chave='telegram_config'"
                )
                row = cur.fetchone()
                if row and row["valor"]:
                    cfg = dict(row["valor"])
                    return {
                        "token":      cfg.get("token")      or os.getenv("TELEGRAM_BOT_TOKEN", ""),
                        "chat_id":    cfg.get("chat_id")    or os.getenv("TELEGRAM_CHAT_ID",   ""),
                        "parse_mode": cfg.get("parse_mode", "Markdown"),
                    }
        finally:
            conn.close()
    except Exception as exc:
        log.warning("Erro ao ler config Telegram do banco: %s", exc)

    return {
        "token":      os.getenv("TELEGRAM_BOT_TOKEN", ""),
        "chat_id":    os.getenv("TELEGRAM_CHAT_ID",   ""),
        "parse_mode": os.getenv("TELEGRAM_PARSE_MODE", "Markdown"),
    }


def save_config(token: str, chat_id: str, parse_mode: str = "Markdown") -> None:
    """Persiste a configuração Telegram no banco de dados."""
    cfg = {"token": token, "chat_id": chat_id, "parse_mode": parse_mode}
    conn = psycopg2.connect(DB_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO configuracoes(chave, valor, atualizado_em)
                VALUES('telegram_config', %s::jsonb, NOW())
                ON CONFLICT(chave) DO UPDATE
                SET valor=EXCLUDED.valor, atualizado_em=NOW()
            """, (json.dumps(cfg),))
        conn.commit()
    finally:
        conn.close()


def is_configured(cfg: Optional[dict] = None) -> bool:
    c = cfg or get_config()
    return bool(c.get("token") and c.get("chat_id"))


# ── Bot info / status ─────────────────────────────────────────────────────────

def get_bot_info(cfg: Optional[dict] = None) -> dict:
    """
    Verifica o token chamando getMe.
    Retorna dict com: ok, bot_name, bot_username, error.
    """
    c = cfg or get_config()
    if not c.get("token"):
        return {"ok": False, "error": "Token não configurado"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(f"{TELEGRAM_API}/bot{c['token']}/getMe")
            r.raise_for_status()
            data = r.json()
            if data.get("ok"):
                bot = data["result"]
                return {
                    "ok":           True,
                    "bot_name":     bot.get("first_name", ""),
                    "bot_username": bot.get("username", ""),
                    "bot_id":       bot.get("id"),
                }
            return {"ok": False, "error": data.get("description", "Token inválido")}
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def get_chat_info(cfg: Optional[dict] = None) -> dict:
    """Verifica o chat_id chamando getChat."""
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Token e Chat ID obrigatórios"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(
                f"{TELEGRAM_API}/bot{c['token']}/getChat",
                params={"chat_id": c["chat_id"]},
            )
            r.raise_for_status()
            data = r.json()
            if data.get("ok"):
                chat = data["result"]
                return {
                    "ok":    True,
                    "title": chat.get("title") or chat.get("first_name", ""),
                    "type":  chat.get("type", ""),
                }
            return {"ok": False, "error": data.get("description", "Chat ID inválido")}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ── Messaging ─────────────────────────────────────────────────────────────────

def send_message(text: str, cfg: Optional[dict] = None,
                 chat_id: Optional[str] = None) -> dict:
    """Envia mensagem de texto via Telegram Bot API."""
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Telegram não configurado"}

    target_chat = chat_id or c["chat_id"]
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.post(
                f"{TELEGRAM_API}/bot{c['token']}/sendMessage",
                json={
                    "chat_id":    target_chat,
                    "text":       text,
                    "parse_mode": c.get("parse_mode", "Markdown"),
                },
            )
            r.raise_for_status()
            data = r.json()
            if data.get("ok"):
                log.info("[TELEGRAM] Mensagem enviada para chat %s", target_chat)
                return {"ok": True, "message_id": data["result"].get("message_id")}
            return {"ok": False, "error": data.get("description", "Erro desconhecido")}
    except httpx.HTTPStatusError as e:
        log.error("[TELEGRAM] HTTP %s: %s", e.response.status_code, e.response.text[:200])
        return {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as exc:
        log.error("[TELEGRAM] Erro: %s", exc)
        return {"ok": False, "error": str(exc)}


def send_photo(image_url: str, caption: str = "", cfg: Optional[dict] = None) -> dict:
    """Envia foto via Telegram Bot API."""
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Telegram não configurado"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.post(
                f"{TELEGRAM_API}/bot{c['token']}/sendPhoto",
                json={
                    "chat_id": c["chat_id"],
                    "photo":   image_url,
                    "caption": caption,
                    "parse_mode": c.get("parse_mode", "Markdown"),
                },
            )
            r.raise_for_status()
            data = r.json()
            if data.get("ok"):
                return {"ok": True}
            return {"ok": False, "error": data.get("description", "Erro desconhecido")}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
