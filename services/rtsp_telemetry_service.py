"""
/app/services/rtsp_telemetry_service.py
SuricathaIA — Serviço de Vídeo Telemétrica em Tempo Real

Para cada câmera com config_telemetria ativa:
  - Abre stream RTSP via OpenCV
  - Captura frames continuamente (30fps processados a cada ~100ms)
  - Roda DriverMonitor (EAR/MAR/Phone/Distração)
  - Salva eventos em eventos_telemetria
  - Dispara SSE telemetria_alerta → frontend
  - Notifica WhatsApp/Telegram conforme config
  - Reconecta automaticamente em queda
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

log = logging.getLogger("suricatha.telemetry")

DB_DSN         = os.getenv("POSTGRES_DSN", "")
SNAPSHOTS_DIR  = Path("/app/snapshots")
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)

TEL_FRAME_MS      = float(os.getenv("TEL_FRAME_MS",       "150"))   # ms entre análises
TEL_RECONNECT_S   = float(os.getenv("TEL_RECONNECT_S",    "15"))
TEL_REFRESH_S     = float(os.getenv("TEL_REFRESH_S",      "120"))
RTSP_TIMEOUT_S    = int(os.getenv("RTSP_TIMEOUT_S",        "15"))
RTSP_BUFFER_SIZE  = int(os.getenv("RTSP_BUFFER_SIZE",       "1"))


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    return psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)


# ── SSE broadcast ─────────────────────────────────────────────────────────────

_sse_fn = None


def register_sse_broadcast(fn):
    global _sse_fn
    _sse_fn = fn


def _sse_push(event: dict):
    if _sse_fn:
        try:
            _sse_fn(event)
        except Exception:
            pass


# ── Camera config ─────────────────────────────────────────────────────────────

@dataclass
class TelCameraConfig:
    camera_id:       int
    camera_nome:     str
    url_stream:      str
    veiculo_id:      Optional[int]
    veiculo_placa:   Optional[str]
    motorista_id:    Optional[int]
    motorista_nome:  Optional[str]
    ear_threshold:   float = 0.25
    ear_frames_alert: int  = 15
    mar_threshold:   float = 0.55
    phone_conf:      float = 0.55
    cooldown_seg:    int   = 60
    notif_sonoro:    bool  = True
    notif_whatsapp:  bool  = False
    notif_telegram:  bool  = False
    destinatarios:   list  = None

    def __post_init__(self):
        if self.destinatarios is None:
            self.destinatarios = []


def _load_cameras() -> list[TelCameraConfig]:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        c.id AS camera_id, c.nome AS camera_nome,
                        c.url_stream,
                        v.id AS veiculo_id, v.placa AS veiculo_placa,
                        m.id AS motorista_id, m.nome AS motorista_nome,
                        COALESCE(ct.ear_threshold, 0.25)    AS ear_threshold,
                        COALESCE(ct.ear_frames_alert, 15)   AS ear_frames_alert,
                        COALESCE(ct.mar_threshold, 0.55)    AS mar_threshold,
                        COALESCE(ct.phone_conf, 0.55)       AS phone_conf,
                        COALESCE(ct.cooldown_seg, 60)       AS cooldown_seg,
                        COALESCE(ct.notif_sonoro, TRUE)     AS notif_sonoro,
                        COALESCE(ct.notif_whatsapp, FALSE)  AS notif_whatsapp,
                        COALESCE(ct.notif_telegram, FALSE)  AS notif_telegram,
                        COALESCE(ct.destinatarios, '[]'::jsonb) AS destinatarios
                    FROM config_telemetria ct
                    JOIN cameras c ON c.id = ct.camera_id
                    LEFT JOIN veiculos v ON v.camera_id = c.id AND v.ativo = TRUE
                    LEFT JOIN motoristas m ON m.id = v.motorista_id AND m.ativo = TRUE
                    WHERE ct.ativo = TRUE
                      AND c.ativa = TRUE
                      AND c.url_stream IS NOT NULL
                      AND c.url_stream != ''
                    ORDER BY c.id
                """)
                rows = cur.fetchall()
        result = []
        for r in rows:
            result.append(TelCameraConfig(
                camera_id       = r["camera_id"],
                camera_nome     = r["camera_nome"],
                url_stream      = r["url_stream"],
                veiculo_id      = r.get("veiculo_id"),
                veiculo_placa   = r.get("veiculo_placa"),
                motorista_id    = r.get("motorista_id"),
                motorista_nome  = r.get("motorista_nome"),
                ear_threshold   = float(r.get("ear_threshold") or 0.25),
                ear_frames_alert= int(r.get("ear_frames_alert") or 15),
                mar_threshold   = float(r.get("mar_threshold") or 0.55),
                phone_conf      = float(r.get("phone_conf") or 0.55),
                cooldown_seg    = int(r.get("cooldown_seg") or 60),
                notif_sonoro    = bool(r.get("notif_sonoro", True)),
                notif_whatsapp  = bool(r.get("notif_whatsapp")),
                notif_telegram  = bool(r.get("notif_telegram")),
                destinatarios   = list(r.get("destinatarios") or []),
            ))
        return result
    except Exception as exc:
        log.error("[TELEMETRY] Falha ao carregar câmeras: %s", exc)
        return []


# ── Persistência ──────────────────────────────────────────────────────────────

def _save_event(cfg: TelCameraConfig, tipo: str, severidade: str,
                confianca: float, ear: float, mar: float,
                duracao_ms: int, tempo_ms: int,
                frame: Optional[np.ndarray]) -> Optional[int]:
    snap_path: Optional[str] = None

    try:
        conn = psycopg2.connect(DB_DSN)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO eventos_telemetria (
                    veiculo_id, motorista_id, camera_id,
                    tipo_evento, severidade, confianca,
                    ear_score, mar_score, duracao_ms,
                    tempo_processo_ms
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                cfg.veiculo_id, cfg.motorista_id, cfg.camera_id,
                tipo, severidade, confianca,
                ear, mar, duracao_ms, tempo_ms,
            ))
            ev_id = cur.fetchone()[0]

            if frame is not None:
                from core.analytics.driver_monitor import annotate_frame
                ann = annotate_frame(frame, [], ear, mar)
                snap_name = f"tel_{ev_id}.jpg"
                try:
                    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
                    cv2.imwrite(str(SNAPSHOTS_DIR / snap_name), ann,
                                [cv2.IMWRITE_JPEG_QUALITY, 85])
                    snap_path = snap_name
                    cur.execute(
                        "UPDATE eventos_telemetria SET snapshot_path=%s WHERE id=%s",
                        (snap_path, ev_id),
                    )
                except Exception as exc:
                    log.warning("[TELEMETRY] Snapshot falhou: %s", exc)

        conn.commit()
        conn.close()
        return ev_id

    except Exception as exc:
        log.error("[TELEMETRY] Save evento falhou: %s", exc)
        return None


def _send_notification(cfg: TelCameraConfig, tipo: str, motorista: Optional[str],
                       placa: Optional[str], msg: str):
    hora = time.strftime("%H:%M:%S")
    data = time.strftime("%d/%m/%Y")

    _tipo_label = {
        "fadiga"   : "🥱 FADIGA / SONOLÊNCIA",
        "bocejo"   : "😴 BOCEJO DETECTADO",
        "celular"  : "📱 USO DE CELULAR",
        "distracao": "👁️ DISTRAÇÃO",
    }.get(tipo, tipo.upper())

    texto = (
        f"⚠️ *ALERTA TELEMÉTRICA — SURICATHA IA*\n\n"
        f"🚛 Veículo: *{placa or 'N/A'}*\n"
        f"👤 Motorista: *{motorista or 'N/A'}*\n"
        f"🔔 Evento: *{_tipo_label}*\n"
        f"🕐 Horário: {hora} de {data}\n"
    )

    if cfg.notif_whatsapp and cfg.destinatarios:
        try:
            from services.whatsapp_evo import send_text
            plain = texto.replace("*", "").replace("_", "")
            for phone in cfg.destinatarios:
                threading.Thread(
                    target=send_text, args=(str(phone), plain), daemon=True
                ).start()
        except Exception as exc:
            log.warning("[TELEMETRY] WhatsApp erro: %s", exc)

    if cfg.notif_telegram:
        try:
            from services.telegram_svc import send_message
            threading.Thread(target=send_message, args=(texto,), daemon=True).start()
        except Exception as exc:
            log.warning("[TELEMETRY] Telegram erro: %s", exc)


# ── Worker por câmera ─────────────────────────────────────────────────────────

class TelCameraWorker(threading.Thread):
    """Thread que processa frames de uma câmera de bordo."""

    def __init__(self, cfg: TelCameraConfig, last_alert: dict[tuple, float]):
        super().__init__(name=f"tel-cam{cfg.camera_id}", daemon=True)
        self._cfg        = cfg
        self._last_alert = last_alert
        self._stop       = threading.Event()
        self._ok         = False
        self._errors     = 0
        self._last_tipo: Optional[str] = None
        self._last_ev:   Optional[dict] = None

    @property
    def is_ok(self) -> bool:
        return self._ok

    @property
    def last_event(self) -> Optional[dict]:
        return self._last_ev

    def stop(self):
        self._stop.set()

    def run(self):
        log.info("[TELEMETRY] Worker iniciado cam_id=%d (%s)", self._cfg.camera_id, self._cfg.camera_nome)
        while not self._stop.is_set():
            try:
                self._rtsp_loop()
            except Exception as exc:
                self._ok = False
                self._errors += 1
                log.error("[TELEMETRY] cam_id=%d erro: %s", self._cfg.camera_id, exc)
            if not self._stop.is_set():
                self._stop.wait(TEL_RECONNECT_S)

    def _rtsp_loop(self):
        from core.analytics.driver_monitor import DriverMonitor, DriverState

        monitor = DriverMonitor()
        monitor.wait_ready(30)

        cap = cv2.VideoCapture(self._cfg.url_stream, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE,        RTSP_BUFFER_SIZE)
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)

        if not cap.isOpened():
            log.warning("[TELEMETRY] Não abriu stream cam_id=%d", self._cfg.camera_id)
            cap.release()
            return

        log.info("[TELEMETRY] Stream aberto cam_id=%d", self._cfg.camera_id)

        # Drena buffer stale
        for _ in range(4):
            cap.grab()

        self._ok     = True
        self._errors = 0
        state        = DriverState()
        last_process = 0.0

        while not self._stop.is_set():
            ret, frame = cap.read()
            if not ret or frame is None:
                log.warning("[TELEMETRY] Stream perdido cam_id=%d", self._cfg.camera_id)
                self._ok = False
                break

            now = time.time()
            if (now - last_process) * 1000 < TEL_FRAME_MS:
                time.sleep(0.02)
                continue

            last_process = now
            t0 = time.monotonic()

            events, state = monitor.analyze(
                frame,
                ear_threshold    = self._cfg.ear_threshold,
                mar_threshold    = self._cfg.mar_threshold,
                phone_conf       = self._cfg.phone_conf,
                ear_frames_alert = self._cfg.ear_frames_alert,
                state            = state,
            )

            tempo_ms = int((time.monotonic() - t0) * 1000)

            for ev in events:
                self._handle_event(ev, tempo_ms)

        cap.release()
        self._ok = False

    def _handle_event(self, ev, tempo_ms: int):
        from core.analytics.driver_monitor import DriverEvent

        key   = (self._cfg.camera_id, ev.tipo)
        agora = time.time()

        if agora - self._last_alert.get(key, 0) < self._cfg.cooldown_seg:
            return
        self._last_alert[key] = agora

        log.info("[TELEMETRY] ⚠️ cam_id=%d tipo=%s sev=%s conf=%.2f EAR=%.3f MAR=%.3f",
                 self._cfg.camera_id, ev.tipo, ev.severidade,
                 ev.confianca, ev.ear, ev.mar)

        ev_id = _save_event(
            self._cfg, ev.tipo, ev.severidade, ev.confianca,
            ev.ear, ev.mar, ev.duracao_ms, tempo_ms, ev.frame,
        )

        snap_url = f"/api/v1/telemetria/eventos/{ev_id}/snapshot" if ev_id else None

        payload = {
            "type"           : "telemetria_alerta",
            "evento_id"      : ev_id,
            "camera_id"      : self._cfg.camera_id,
            "camera_nome"    : self._cfg.camera_nome,
            "tipo_evento"    : ev.tipo,
            "severidade"     : ev.severidade,
            "confianca"      : ev.confianca,
            "ear"            : ev.ear,
            "mar"            : ev.mar,
            "veiculo_placa"  : self._cfg.veiculo_placa,
            "motorista_nome" : self._cfg.motorista_nome,
            "snapshot_url"   : snap_url,
            "ts"             : _ts(),
            "sonoro"         : self._cfg.notif_sonoro,
        }
        _sse_push(payload)
        self._last_ev = payload

        _send_notification(
            self._cfg, ev.tipo,
            self._cfg.motorista_nome, self._cfg.veiculo_placa, "",
        )


# ── Serviço principal ─────────────────────────────────────────────────────────

class TelemetryService:
    """Gerencia workers de monitoramento de motorista por câmera."""

    def __init__(self):
        self._workers:    dict[int, TelCameraWorker] = {}
        self._lock        = threading.Lock()
        self._global_stop = threading.Event()
        self._watcher:    Optional[threading.Thread] = None
        self._last_alert: dict[tuple, float] = {}

    def start(self) -> "TelemetryService":
        self._migrate()
        threading.Thread(target=self._init, daemon=True, name="tel-svc-init").start()
        return self

    def _init(self):
        from core.analytics.driver_monitor import DriverMonitor
        log.info("[TELEMETRY] Inicializando DriverMonitor...")
        DriverMonitor().wait_ready(60)
        log.info("[TELEMETRY] Pronto. Iniciando workers.")
        self._sync_cameras()
        self._watcher = threading.Thread(
            target=self._watch_loop, daemon=True, name="tel-svc-watcher"
        )
        self._watcher.start()

    def _watch_loop(self):
        while not self._global_stop.is_set():
            self._global_stop.wait(TEL_REFRESH_S)
            if not self._global_stop.is_set():
                self._sync_cameras()

    def _sync_cameras(self):
        cameras    = {c.camera_id: c for c in _load_cameras()}
        active_ids = set(cameras.keys())

        with self._lock:
            running_ids = set(self._workers.keys())

            for cam_id in running_ids - active_ids:
                log.info("[TELEMETRY] Removendo cam_id=%d", cam_id)
                self._workers[cam_id].stop()
                del self._workers[cam_id]

            for cam_id, cfg in cameras.items():
                existing = self._workers.get(cam_id)
                if existing and existing.is_alive():
                    continue
                w = TelCameraWorker(cfg, self._last_alert)
                self._workers[cam_id] = w
                w.start()
                log.info("[TELEMETRY] Worker iniciado cam_id=%d (%s)", cam_id, cfg.camera_nome)

    def reload(self):
        self._sync_cameras()

    def status(self) -> list[dict]:
        with self._lock:
            return [
                {
                    "cam_id"        : cam_id,
                    "cam_nome"      : w._cfg.camera_nome,
                    "veiculo_placa" : w._cfg.veiculo_placa,
                    "motorista"     : w._cfg.motorista_nome,
                    "stream_ok"     : w.is_ok,
                    "alive"         : w.is_alive(),
                    "errors"        : w._errors,
                    "last_event"    : w.last_event,
                }
                for cam_id, w in self._workers.items()
            ]

    def stop(self):
        self._global_stop.set()
        with self._lock:
            for w in self._workers.values():
                w.stop()
            self._workers.clear()
        log.info("[TELEMETRY] Serviço encerrado")

    def _migrate(self):
        try:
            conn = psycopg2.connect(DB_DSN)
            sql = (Path(__file__).parent.parent / "migrations" / "telemetria.sql").read_text()
            with conn.cursor() as cur:
                cur.execute(sql)
            conn.commit()
            conn.close()
            log.info("[TELEMETRY] Migração OK")
        except Exception as exc:
            log.warning("[TELEMETRY] Migrate: %s", exc)


# ── Singleton ─────────────────────────────────────────────────────────────────

_service: Optional[TelemetryService] = None


def get_service() -> Optional[TelemetryService]:
    return _service


def start_service() -> TelemetryService:
    global _service
    if _service is None:
        _service = TelemetryService()
        _service.start()
    return _service
