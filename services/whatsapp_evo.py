"""
/app/services/whatsapp_evo.py
SuricathaIA — Evolution API WhatsApp Service

Responsável por toda a comunicação com a Evolution API:
  - Lê configuração do banco (configuracoes.whatsapp_evo_config)
  - Fallback para variáveis de ambiente (.env)
  - Gerencia instâncias, QR code, envio de mensagens
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

import httpx
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent.parent / ".env")

log = logging.getLogger("suricatha.whatsapp_evo")

DB_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db",
)

TIMEOUT = 12  # seconds for HTTP requests


# ── Config management ─────────────────────────────────────────────────────────

def get_config() -> dict:
    """
    Lê a configuração Evolution API do banco de dados.
    Fallback para variáveis de ambiente se o banco não tiver config.
    Retorna dict com: url, key, instance, phone, provider.
    """
    try:
        conn = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT valor FROM configuracoes WHERE chave='whatsapp_evo_config'"
                )
                row = cur.fetchone()
                if row and row["valor"]:
                    cfg = dict(row["valor"])
                    # Merge com .env (DB tem prioridade)
                    return {
                        "url":      cfg.get("url")      or os.getenv("EVOLUTION_API_URL",  ""),
                        "key":      cfg.get("key")      or os.getenv("EVOLUTION_API_KEY",  ""),
                        "instance": cfg.get("instance") or os.getenv("EVOLUTION_INSTANCE", ""),
                        "phone":    cfg.get("phone")    or os.getenv("EVOLUTION_PHONE",    ""),
                        "provider": cfg.get("provider", "evolution"),
                    }
        finally:
            conn.close()
    except Exception as exc:
        log.warning("Erro ao ler config WhatsApp do banco: %s", exc)

    # Fallback .env
    return {
        "url":      os.getenv("EVOLUTION_API_URL",  ""),
        "key":      os.getenv("EVOLUTION_API_KEY",  ""),
        "instance": os.getenv("EVOLUTION_INSTANCE", ""),
        "phone":    os.getenv("EVOLUTION_PHONE",    ""),
        "provider": os.getenv("WA_PROVIDER", "evolution"),
    }


def save_config(url: str, key: str, instance: str, phone: str, provider: str = "evolution") -> None:
    """Persiste a configuração no banco de dados."""
    cfg = {"url": url, "key": key, "instance": instance, "phone": phone, "provider": provider}
    conn = psycopg2.connect(DB_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO configuracoes(chave, valor, atualizado_em)
                VALUES('whatsapp_evo_config', %s::jsonb, NOW())
                ON CONFLICT(chave) DO UPDATE
                SET valor=EXCLUDED.valor, atualizado_em=NOW()
            """, (json.dumps(cfg),))
        conn.commit()
    finally:
        conn.close()


def is_configured(cfg: Optional[dict] = None) -> bool:
    c = cfg or get_config()
    return bool(c.get("url") and c.get("key") and c.get("instance"))


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _headers(cfg: dict) -> dict:
    return {"apikey": cfg["key"], "Content-Type": "application/json"}


def _base(cfg: dict) -> str:
    return cfg["url"].rstrip("/")


# ── Instance management ───────────────────────────────────────────────────────

def get_instance_status(cfg: Optional[dict] = None) -> dict:
    """
    Retorna o estado da instância Evolution API.
    States: open (conectado), close (desconectado), connecting (aguardando QR).
    """
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "state": "not_configured", "error": "Evolution API não configurada"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(
                f"{_base(c)}/instance/connectionState/{c['instance']}",
                headers=_headers(c),
            )
            r.raise_for_status()
            data = r.json()

            state = (
                data.get("instance", {}).get("state")
                or data.get("state")
                or data.get("connectionStatus")
                or "unknown"
            )
            return {
                "ok":       state == "open",
                "state":    state,
                "instance": c["instance"],
                "phone":    c["phone"],
                "url":      c["url"],
            }
    except httpx.HTTPStatusError as e:
        return {"ok": False, "state": "error", "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as exc:
        return {"ok": False, "state": "error", "error": str(exc)}


def get_qrcode(cfg: Optional[dict] = None) -> dict:
    """
    Solicita o QR code para conectar a instância ao WhatsApp.
    Retorna dict com base64 do QR code ou erro.
    """
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Evolution API não configurada"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(
                f"{_base(c)}/instance/connect/{c['instance']}",
                headers=_headers(c),
            )
            r.raise_for_status()
            data = r.json()

            # Evolution API retorna: {"code": "...", "base64": "data:image/png;base64,..."}
            qr_base64 = (
                data.get("base64")
                or data.get("qrcode", {}).get("base64")
                or data.get("qr")
            )
            qr_code = (
                data.get("code")
                or data.get("qrcode", {}).get("code")
            )

            if qr_base64 or qr_code:
                return {"ok": True, "base64": qr_base64, "code": qr_code}
            return {"ok": False, "error": "QR code não disponível — instância pode já estar conectada", "raw": data}
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def restart_instance(cfg: Optional[dict] = None) -> dict:
    """Reinicia a instância Evolution API."""
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Evolution API não configurada"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.post(
                f"{_base(c)}/instance/restart/{c['instance']}",
                headers=_headers(c),
            )
            r.raise_for_status()
            return {"ok": True, "message": "Instância reiniciada"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def logout_instance(cfg: Optional[dict] = None) -> dict:
    """Desconecta a instância do WhatsApp (logout)."""
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Evolution API não configurada"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.delete(
                f"{_base(c)}/instance/logout/{c['instance']}",
                headers=_headers(c),
            )
            r.raise_for_status()
            return {"ok": True, "message": "Instância desconectada"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def list_instances(cfg: Optional[dict] = None) -> dict:
    """Lista todas as instâncias disponíveis na Evolution API."""
    c = cfg or get_config()
    if not (c.get("url") and c.get("key")):
        return {"ok": False, "error": "URL e API Key obrigatórios"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(
                f"{_base(c)}/instance/fetchInstances",
                headers=_headers(c),
            )
            r.raise_for_status()
            data = r.json()
            instances = data if isinstance(data, list) else data.get("data", [])
            return {"ok": True, "instances": instances}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ── Messaging ─────────────────────────────────────────────────────────────────

def send_text(phone: str, message: str, cfg: Optional[dict] = None) -> dict:
    """
    Envia mensagem de texto via Evolution API.
    phone: número no formato DDI+DDD+número (ex: 5565999990001)
    """
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Evolution API não configurada"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.post(
                f"{_base(c)}/message/sendText/{c['instance']}",
                headers=_headers(c),
                json={"number": phone, "text": message, "delay": 0},
            )
            r.raise_for_status()
            log.info("[WA-EVO] Mensagem enviada para %s", phone)
            return {"ok": True, "phone": phone}
    except httpx.HTTPStatusError as e:
        log.error("[WA-EVO] Erro HTTP %s ao enviar para %s: %s", e.response.status_code, phone, e.response.text[:200])
        return {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as exc:
        log.error("[WA-EVO] Erro ao enviar para %s: %s", phone, exc)
        return {"ok": False, "error": str(exc)}


def send_image(phone: str, image_url: str, caption: str = "", cfg: Optional[dict] = None) -> dict:
    """Envia imagem via Evolution API."""
    c = cfg or get_config()
    if not is_configured(c):
        return {"ok": False, "error": "Evolution API não configurada"}

    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.post(
                f"{_base(c)}/message/sendMedia/{c['instance']}",
                headers=_headers(c),
                json={
                    "number":    phone,
                    "mediatype": "image",
                    "mimetype":  "image/jpeg",
                    "caption":   caption,
                    "media":     image_url,
                    "delay":     0,
                },
            )
            r.raise_for_status()
            return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
