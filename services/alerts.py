"""
/app/services/alerts.py
SuricathaIA — Serviço de Alertas
Telegram Bot + WhatsApp (Twilio ou Z-API) para watchlist hits.
"""

import os
import time
import logging
import threading
from queue import Queue, Empty
from typing import Optional
from dataclasses import dataclass

import httpx

log = logging.getLogger("suricatha.alerts")

# ── Configuração via .env ─────────────────────────────────────────────────────
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")   # ID do grupo/canal

# WhatsApp — provider ativo: "evolution" | "zapi" | "twilio" | ""
WA_PROVIDER      = os.getenv("WA_PROVIDER", "evolution")

# Evolution API
EVO_URL          = os.getenv("EVOLUTION_API_URL",      "")   # ex: http://localhost:8080
EVO_KEY          = os.getenv("EVOLUTION_API_KEY",      "")   # Global API Key
EVO_INSTANCE     = os.getenv("EVOLUTION_INSTANCE",     "")   # nome da instância
EVO_PHONE        = os.getenv("EVOLUTION_PHONE",        "")   # 5565999999999 ou groupJid

# Z-API (legado)
ZAPI_INSTANCE    = os.getenv("ZAPI_INSTANCE_ID", "")
ZAPI_TOKEN       = os.getenv("ZAPI_TOKEN", "")
ZAPI_PHONE       = os.getenv("ZAPI_PHONE", "")

# Twilio (legado)
TWILIO_SID       = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN_TW  = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM      = os.getenv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")
TWILIO_TO        = os.getenv("TWILIO_WHATSAPP_TO", "")


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ── Dataclass de alerta ───────────────────────────────────────────────────────
@dataclass
class AlertEvent:
    placa:         str
    tipo:          str           # suspeito, roubado, bloqueado, vip, monitorado
    prioridade:    int
    camera_nome:   str
    confianca:     float
    det_id:        int
    detectado_em:  str
    crop_url:      Optional[str] = None


# ── Formatação de mensagem ────────────────────────────────────────────────────
def _format_message(e: AlertEvent) -> str:
    emoji = {
        "roubado"   : "🚨",
        "suspeito"  : "⚠️",
        "bloqueado" : "🚫",
        "vip"       : "⭐",
        "monitorado": "👁️",
    }.get(e.tipo, "🔔")

    stars = "⭐" * e.prioridade

    lines = [
        f"{emoji} *ALERTA SURICATHA IA* {emoji}",
        f"",
        f"🚗 *Placa:* `{e.placa}`",
        f"📋 *Tipo:* {e.tipo.upper()}  {stars}",
        f"📷 *Câmera:* {e.camera_nome}",
        f"🎯 *Confiança:* {e.confianca * 100:.1f}%",
        f"🕐 *Horário:* {e.detectado_em}",
        f"🆔 *ID:* #{e.det_id}",
    ]

    if e.crop_url:
        lines.append(f"🖼️ [Ver imagem]({e.crop_url})")

    return "\n".join(lines)


# ── Telegram ──────────────────────────────────────────────────────────────────
def _send_telegram(event: AlertEvent) -> bool:
    try:
        from services.telegram_svc import send_message, is_configured
        if not is_configured():
            log.warning("[SURICATHA-LOG] %s - Telegram não configurado", _ts())
            return False
        text = _format_message(event)
        result = send_message(text)
        if result.get("ok"):
            log.info("[SURICATHA-LOG] %s - Telegram OK placa=%s", _ts(), event.placa)
        else:
            log.error("[SURICATHA-LOG] %s - Telegram ERRO: %s", _ts(), result.get("error"))
        return result.get("ok", False)
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Telegram ERRO: %s", _ts(), exc)
        return False


# ── WhatsApp — Evolution API ─────────────────────────────────────────────────
def _evo_headers() -> dict:
    return {"apikey": EVO_KEY, "Content-Type": "application/json"}


def _evo_configured() -> bool:
    return bool(EVO_URL and EVO_KEY and EVO_INSTANCE and EVO_PHONE)


def _send_evolution(event: AlertEvent) -> bool:
    """
    Envia alerta via Evolution API.
    Se crop_url disponível: sendMedia (imagem + caption).
    Fallback automático para sendText se o envio de imagem falhar.
    """
    if not _evo_configured():
        log.warning("[SURICATHA-LOG] %s - Evolution API não configurada", _ts())
        return False

    text = _format_message(event)

    # Tenta enviar como imagem se houver crop_url
    if event.crop_url:
        ok = _evo_send_image(event, text)
        if ok:
            return True
        log.warning("[SURICATHA-LOG] %s - Evolution sendMedia falhou, tentando texto", _ts())

    return _evo_send_text(text, event.placa)


def _evo_send_text(text: str, placa: str) -> bool:
    url = f"{EVO_URL.rstrip('/')}/message/sendText/{EVO_INSTANCE}"
    # Evolution API aceita markdown via *texto* mas sem parse especial — remove formatação
    plain = text.replace("*", "").replace("`", "")
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(url, headers=_evo_headers(), json={
                "number":  EVO_PHONE,
                "text":    plain,
                "delay":   0,
            })
            resp.raise_for_status()
            log.info("[SURICATHA-LOG] %s - Evolution sendText OK placa=%s", _ts(), placa)
            return True
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Evolution sendText ERRO: %s", _ts(), exc)
        return False


def _evo_send_image(event: AlertEvent, caption: str) -> bool:
    url = f"{EVO_URL.rstrip('/')}/message/sendMedia/{EVO_INSTANCE}"
    plain_caption = caption.replace("*", "").replace("`", "")
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(url, headers=_evo_headers(), json={
                "number":    EVO_PHONE,
                "mediatype": "image",
                "mimetype":  "image/jpeg",
                "caption":   plain_caption,
                "media":     event.crop_url,  # URL pública do Supabase Storage
                "delay":     0,
            })
            resp.raise_for_status()
            log.info("[SURICATHA-LOG] %s - Evolution sendMedia OK placa=%s",
                     _ts(), event.placa)
            return True
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Evolution sendMedia ERRO: %s", _ts(), exc)
        return False


def test_evolution_connection() -> dict:
    """
    Verifica conectividade e estado da instância.
    Retorna dict com status, instância e estado da conexão WhatsApp.
    Usado pelo endpoint POST /api/v1/whatsapp/test.
    """
    if not _evo_configured():
        return {"ok": False, "error": "Evolution API não configurada no .env"}

    url = f"{EVO_URL.rstrip('/')}/instance/fetchInstances"
    try:
        with httpx.Client(timeout=8) as client:
            resp = client.get(url, headers=_evo_headers())
            resp.raise_for_status()
            instances = resp.json()

        # Localiza a instância configurada
        target = next(
            (i for i in (instances if isinstance(instances, list) else [])
             if i.get("instance", {}).get("instanceName") == EVO_INSTANCE
             or i.get("name") == EVO_INSTANCE),
            None
        )

        if target is None:
            return {
                "ok":      False,
                "error":   f"Instância '{EVO_INSTANCE}' não encontrada",
                "total_instances": len(instances) if isinstance(instances, list) else 0,
            }

        state = (
            target.get("instance", {}).get("state")
            or target.get("connectionStatus")
            or "unknown"
        )

        return {
            "ok":       state == "open",
            "instance": EVO_INSTANCE,
            "state":    state,           # "open" = conectado, "close" = desconectado
            "phone":    EVO_PHONE,
            "url":      EVO_URL,
        }

    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ── WhatsApp — Z-API ─────────────────────────────────────────────────────────
def _send_zapi(event: AlertEvent) -> bool:
    if not ZAPI_INSTANCE or not ZAPI_TOKEN or not ZAPI_PHONE:
        log.warning("[SURICATHA-LOG] %s - Z-API não configurado", _ts())
        return False

    url  = f"https://api.z-api.io/instances/{ZAPI_INSTANCE}/token/{ZAPI_TOKEN}/send-text"
    text = _format_message(event).replace("*", "").replace("`", "")

    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(url, json={
                "phone"  : ZAPI_PHONE,
                "message": text,
            })
            resp.raise_for_status()
            log.info("[SURICATHA-LOG] %s - WhatsApp(Z-API) OK placa=%s",
                     _ts(), event.placa)
            return True
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - WhatsApp(Z-API) ERRO: %s", _ts(), exc)
        return False


# ── WhatsApp — Twilio ─────────────────────────────────────────────────────────
def _send_twilio(event: AlertEvent) -> bool:
    if not TWILIO_SID or not TWILIO_TOKEN_TW or not TWILIO_TO:
        log.warning("[SURICATHA-LOG] %s - Twilio não configurado", _ts())
        return False

    text = _format_message(event).replace("*", "").replace("`", "")

    try:
        from twilio.rest import Client as TwilioClient
        client = TwilioClient(TWILIO_SID, TWILIO_TOKEN_TW)
        client.messages.create(
            body=text,
            from_=TWILIO_FROM,
            to=f"whatsapp:{TWILIO_TO}",
        )
        log.info("[SURICATHA-LOG] %s - WhatsApp(Twilio) OK placa=%s",
                 _ts(), event.placa)
        return True
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - WhatsApp(Twilio) ERRO: %s", _ts(), exc)
        return False


# ── Dispatcher ────────────────────────────────────────────────────────────────
def _dispatch(event: AlertEvent):
    """Envia para todos os canais configurados em paralelo."""
    threads = []

    if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
        t = threading.Thread(target=_send_telegram, args=(event,), daemon=True)
        threads.append(t)

    if WA_PROVIDER == "evolution" and _evo_configured():
        t = threading.Thread(target=_send_evolution, args=(event,), daemon=True)
        threads.append(t)
    elif WA_PROVIDER == "zapi" and ZAPI_INSTANCE:
        t = threading.Thread(target=_send_zapi, args=(event,), daemon=True)
        threads.append(t)
    elif WA_PROVIDER == "twilio" and TWILIO_SID:
        t = threading.Thread(target=_send_twilio, args=(event,), daemon=True)
        threads.append(t)

    if not threads:
        log.warning("[SURICATHA-LOG] %s - Nenhum canal de alerta configurado",
                    _ts())
        return

    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)


# ── Alert Service (singleton) ─────────────────────────────────────────────────
class AlertService:
    """
    Fila assíncrona de alertas.
    Chamado pelo watchdog_service após INSERT com watchlist_hit=True.
    """

    _instance = None
    _lock      = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._queue  = Queue(maxsize=500)
                cls._instance._worker = threading.Thread(
                    target=cls._instance._run,
                    daemon=True,
                    name="alert-worker"
                )
                cls._instance._worker.start()
                log.info("[SURICATHA-LOG] %s - AlertService iniciado", _ts())
        return cls._instance

    def send(self, event: AlertEvent):
        """Enfileira alerta para envio assíncrono (não bloqueia o pipeline)."""
        try:
            self._queue.put_nowait(event)
        except Exception:
            log.warning("[SURICATHA-LOG] %s - Fila de alertas cheia", _ts())

    def _run(self):
        while True:
            try:
                event = self._queue.get(timeout=5)
                _dispatch(event)
            except Empty:
                continue
            except Exception as exc:
                log.error("[SURICATHA-LOG] %s - Alert worker erro: %s",
                          _ts(), exc)
