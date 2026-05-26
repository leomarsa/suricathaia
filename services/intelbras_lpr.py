"""
/app/services/intelbras_lpr.py
SuricathaIA — Intelbras LPR via eventManager.cgi (long-polling)

Fluxo por câmera:
  GET /cgi-bin/eventManager.cgi?action=attach&codes[0]=TrafficJunction&heartbeat=5
  → multipart/x-mixed-replace contínuo
  → cada parte contém: Code=TrafficJunction; data={"LicensePlate":"...","Confidence":95}
  → dedup → insert_detection(fonte='intelbras_api') → trigger watchlist → alerta
"""

import os
import re
import json
import time
import logging
import threading
import psycopg2
from psycopg2.extras import RealDictCursor
from typing import Optional

import httpx
from httpx import DigestAuth

from services.database import DatabaseService
from services.alerts import AlertService, AlertEvent

log = logging.getLogger("suricatha.intelbras_lpr")

PG_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db",
)

_RECONNECT_MIN     = 5
_RECONNECT_MAX     = 120
_HEARTBEAT_TIMEOUT = 30
_REFRESH_INTERVAL  = 120


def _conn():
    return psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _load_intelbras_cameras() -> list[dict]:
    """Retorna todas as câmeras ativas com protocolo_lpr='intelbras_api'."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, nome, ip_sftp::text AS ip,
                           usuario_camera, senha_camera,
                           porta_http, https_camera,
                           rec_deteccao_unica, janela_dedup_seg
                    FROM cameras
                    WHERE ativa = TRUE
                      AND rec_lpr = TRUE
                      AND protocolo_lpr = 'intelbras_api'
                      AND ip_sftp IS NOT NULL
                """)
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Falha ao carregar câmeras Intelbras: %s",
                  _now_iso(), exc)
        return []


def _check_dedup(cam_id: int, placa: str, janela_seg: int) -> bool:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 1 FROM deteccoes
                    WHERE camera_id = %s AND placa = %s
                      AND detectado_em >= NOW() - (%s || ' seconds')::INTERVAL
                    LIMIT 1
                """, (cam_id, placa, janela_seg))
                return cur.fetchone() is not None
    except Exception:
        return False


def _parse_event_data(chunk: str) -> Optional[dict]:
    if "TrafficJunction" not in chunk:
        return None
    m = re.search(r"data=(\{.*\})", chunk, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _handle_event(cam: dict, data: dict) -> None:
    placa_raw = (data.get("LicensePlate") or "").strip().upper()
    if not placa_raw:
        return

    placa     = re.sub(r"[^A-Z0-9]", "", placa_raw)[:10]
    confianca = float(data.get("Confidence") or data.get("confidence") or 0) / 100.0
    cam_id    = cam["id"]

    if cam.get("rec_deteccao_unica") and cam.get("janela_dedup_seg"):
        if _check_dedup(cam_id, placa, cam["janela_dedup_seg"]):
            log.debug("[SURICATHA-LOG] %s - DEDUP placa=%s cam=%d (intelbras)",
                      _now_iso(), placa, cam_id)
            return

    db     = DatabaseService()
    det_id = db.insert_detection({
        "camera_id"        : cam_id,
        "placa_raw_1"      : placa,
        "confianca_1"      : confianca,
        "placa_raw_2"      : placa,
        "confianca_2"      : confianca,
        "placa"            : placa,
        "confianca_final"  : confianca,
        "validado"         : True,
        "divergencia"      : False,
        "arquivo_original" : None,
        "caminho_storage"  : None,
        "raw_texts"        : [placa_raw],
        "tempo_processo_ms": 0,
        "erro"             : None,
        "fonte"            : "intelbras_api",
    })

    if not det_id:
        return

    log.info("[SURICATHA-LOG] %s - [INTELBRAS] det_id=%d placa=%s conf=%.0f%% cam=%s",
             _now_iso(), det_id, placa, confianca * 100, cam["nome"])

    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT d.watchlist_hit, w.tipo, w.prioridade
                    FROM deteccoes d
                    LEFT JOIN watchlist w ON w.id = d.watchlist_id
                    WHERE d.id = %s
                """, (det_id,))
                row = cur.fetchone()
        if row and row["watchlist_hit"]:
            AlertService().send(AlertEvent(
                placa=placa,
                tipo=row["tipo"] or "suspeito",
                prioridade=row["prioridade"] or 1,
                camera_nome=cam["nome"],
                confianca=confianca,
                det_id=det_id,
                detectado_em=_now_iso(),
                crop_url=None,
            ))
            try:
                with _conn() as conn2:
                    with conn2.cursor() as cur2:
                        cur2.execute("""
                            INSERT INTO alertas_watchlist
                                (camera_id, deteccao_id, camera_nome, placa,
                                 tipo, prioridade, confianca, notificado)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                        """, (cam.get("id"), det_id, cam["nome"], placa,
                              row["tipo"] or "suspeito", row["prioridade"] or 1,
                              confianca, True))
                        conn2.commit()
            except Exception as _ae:
                log.warning("[SURICATHA-LOG] %s - Save alerta_watchlist (intelbras) falhou: %s",
                            _now_iso(), _ae)
    except Exception as exc:
        log.warning("[SURICATHA-LOG] %s - Falha ao checar watchlist det=%d: %s",
                    _now_iso(), det_id, exc)


def _poll_camera(cam: dict, stop_event: threading.Event, status_ref: dict) -> None:
    """
    Thread de long-polling para uma câmera.
    Atualiza status_ref em tempo real: connected | reconnecting | error | stopped.
    """
    scheme    = "https" if cam.get("https_camera") else "http"
    ip        = cam["ip"]
    porta     = cam.get("porta_http") or 80
    url       = (f"{scheme}://{ip}:{porta}"
                 "/cgi-bin/eventManager.cgi"
                 "?action=attach&codes[0]=TrafficJunction&heartbeat=5")
    auth      = DigestAuth(
        cam.get("usuario_camera") or "admin",
        cam.get("senha_camera") or "",
    )
    backoff   = _RECONNECT_MIN
    cam_label = f"{cam['nome']} ({ip})"

    def _set(st: str, **kw):
        status_ref.update({"status": st, **kw})

    _set("reconnecting")

    while not stop_event.is_set():
        _set("reconnecting", backoff_s=backoff)
        try:
            log.info("[SURICATHA-LOG] %s - [INTELBRAS] Conectando a %s",
                     _now_iso(), cam_label)

            with httpx.stream(
                "GET", url, auth=auth,
                timeout=httpx.Timeout(connect=10.0, read=_HEARTBEAT_TIMEOUT,
                                      write=10.0, pool=10.0),
                follow_redirects=True,
            ) as resp:
                if resp.status_code != 200:
                    _set("error",
                         last_error=f"HTTP {resp.status_code}",
                         last_error_at=_now_iso(),
                         backoff_s=backoff)
                    log.warning("[SURICATHA-LOG] %s - [INTELBRAS] HTTP %d de %s",
                                _now_iso(), resp.status_code, cam_label)
                    time.sleep(backoff)
                    backoff = min(backoff * 2, _RECONNECT_MAX)
                    continue

                _set("connected",
                     last_connect_at=_now_iso(),
                     last_error=None,
                     backoff_s=0)
                backoff = _RECONNECT_MIN
                log.info("[SURICATHA-LOG] %s - [INTELBRAS] Conectado a %s",
                         _now_iso(), cam_label)

                buf = ""
                for chunk in resp.iter_text():
                    if stop_event.is_set():
                        break
                    buf += chunk
                    if "\r\n\r\n" in buf or "\n\n" in buf:
                        data = _parse_event_data(buf)
                        if data:
                            status_ref["last_event_at"] = _now_iso()
                            status_ref["total_events"]  = status_ref.get("total_events", 0) + 1
                            try:
                                _handle_event(cam, data)
                            except Exception as exc:
                                log.error("[SURICATHA-LOG] %s - [INTELBRAS] Erro ao processar evento: %s",
                                          _now_iso(), exc)
                        buf = ""

        except httpx.ConnectError as exc:
            _set("error",
                 last_error=f"Sem conexão: {exc}",
                 last_error_at=_now_iso(),
                 backoff_s=backoff)
            log.warning("[SURICATHA-LOG] %s - [INTELBRAS] Sem conexão com %s — reconectando em %ds",
                        _now_iso(), cam_label, backoff)
        except (httpx.ReadTimeout, httpx.ConnectTimeout) as exc:
            _set("error",
                 last_error=f"Timeout: {exc}",
                 last_error_at=_now_iso(),
                 backoff_s=backoff)
            log.warning("[SURICATHA-LOG] %s - [INTELBRAS] Timeout em %s — reconectando em %ds",
                        _now_iso(), cam_label, backoff)
        except Exception as exc:
            _set("error",
                 last_error=str(exc),
                 last_error_at=_now_iso(),
                 backoff_s=backoff)
            log.error("[SURICATHA-LOG] %s - [INTELBRAS] Erro inesperado em %s: %s",
                      _now_iso(), cam_label, exc)

        if not stop_event.is_set():
            time.sleep(backoff)
            backoff = min(backoff * 2, _RECONNECT_MAX)

    _set("stopped")


class IntelbrasLprService:
    """
    Gerencia threads de long-polling para todas as câmeras Intelbras ativas.
    Detecta câmeras novas / removidas a cada _REFRESH_INTERVAL segundos.
    """

    def __init__(self):
        self._threads:     dict[int, threading.Thread] = {}
        self._stop_events: dict[int, threading.Event]  = {}
        self._cam_status:  dict[int, dict]             = {}
        self._global_stop  = threading.Event()
        self._watcher_thread: Optional[threading.Thread] = None

    def start(self) -> "IntelbrasLprService":
        self._watcher_thread = threading.Thread(
            target=self._watcher_loop,
            name="intelbras-lpr-watcher",
            daemon=True,
        )
        self._watcher_thread.start()
        log.info("[SURICATHA-LOG] %s - IntelbrasLprService iniciado", _now_iso())
        return self

    def stop(self) -> None:
        self._global_stop.set()
        for ev in self._stop_events.values():
            ev.set()
        for t in self._threads.values():
            t.join(timeout=5)
        log.info("[SURICATHA-LOG] %s - IntelbrasLprService encerrado", _now_iso())

    def status(self) -> list[dict]:
        """Retorna estado detalhado de cada câmera Intelbras."""
        result = []
        for cam_id, st in self._cam_status.items():
            alive = self._threads.get(cam_id, threading.Thread()).is_alive()
            result.append({
                "camera_id"     : cam_id,
                "alive"         : alive,
                **st,
            })
        return result

    # ── Watcher loop ─────────────────────────────────────────────────────────

    def _watcher_loop(self) -> None:
        while not self._global_stop.is_set():
            self._sync_cameras()
            self._global_stop.wait(timeout=_REFRESH_INTERVAL)

    def _sync_cameras(self) -> None:
        cameras = _load_intelbras_cameras()
        current_ids = {c["id"] for c in cameras}

        for cam_id in list(self._threads.keys()):
            if cam_id not in current_ids:
                log.info("[SURICATHA-LOG] %s - [INTELBRAS] Removendo câmera id=%d",
                         _now_iso(), cam_id)
                self._stop_events[cam_id].set()
                self._threads.pop(cam_id, None)
                self._stop_events.pop(cam_id, None)
                self._cam_status.pop(cam_id, None)

        for cam in cameras:
            cam_id   = cam["id"]
            existing = self._threads.get(cam_id)
            if existing and existing.is_alive():
                continue

            status_ref = self._cam_status.setdefault(cam_id, {
                "camera_id"     : cam_id,
                "camera_nome"   : cam["nome"],
                "ip"            : cam["ip"],
                "status"        : "reconnecting",
                "last_connect_at": None,
                "last_event_at" : None,
                "last_error"    : None,
                "last_error_at" : None,
                "total_events"  : 0,
                "backoff_s"     : 0,
            })
            # Atualiza metadados que podem ter mudado (IP, nome)
            status_ref.update({
                "camera_nome": cam["nome"],
                "ip"         : cam["ip"],
            })

            stop_ev = threading.Event()
            t = threading.Thread(
                target=_poll_camera,
                args=(cam, stop_ev, status_ref),
                name=f"intelbras-lpr-cam{cam_id}",
                daemon=True,
            )
            self._stop_events[cam_id] = stop_ev
            self._threads[cam_id]     = t
            t.start()
            log.info("[SURICATHA-LOG] %s - [INTELBRAS] Thread iniciada para cam id=%d (%s)",
                     _now_iso(), cam_id, cam["nome"])


_instance: Optional[IntelbrasLprService] = None


def start_service() -> IntelbrasLprService:
    global _instance
    _instance = IntelbrasLprService()
    _instance.start()
    return _instance


def get_instance() -> Optional[IntelbrasLprService]:
    return _instance
