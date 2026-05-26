"""
/app/services/rtmp_stream_worker.py
SuricathaIA — Worker de Stream RTMP

Fluxo completo:
  Camera → RTMP push → MediaMTX (:1935) → RTSP relay interno (:8554)
  Worker → rtsp://localhost:8554/live/<uuid> → frame → LPR / Contagem

Cada câmera com protocolo='rtmp' e ativa=True ganha um thread dedicado
que aguarda o publisher aparecer e processa os frames conforme os pilares
habilitados (rec_lpr, rec_contagem_pessoas).
"""

from __future__ import annotations

import concurrent.futures
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import cv2
import psycopg2
from psycopg2.extras import RealDictCursor

DB_DSN             = os.getenv("POSTGRES_DSN",
                                "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db")
MEDIAMTX_RTSP_HOST = os.getenv("MEDIAMTX_RTSP_HOST", "127.0.0.1")
MEDIAMTX_RTSP_PORT = int(os.getenv("MEDIAMTX_RTSP_PORT", "8554"))
RECONNECT_DELAY_S  = float(os.getenv("RTMP_RECONNECT_DELAY_S", "15"))
STREAM_TIMEOUT_S   = int(os.getenv("RTMP_STREAM_TIMEOUT_S",   "20"))
DEFAULT_INTERVAL_S = int(os.getenv("RTMP_DEFAULT_INTERVAL_S", "5"))

log = logging.getLogger("suricatha.rtmp_worker")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _rtsp_relay_url(url_stream: str) -> Optional[str]:
    """rtmp://host:1935/live/<uuid>  →  rtsp://127.0.0.1:8554/live/<uuid>"""
    if not url_stream:
        return None
    try:
        path = urlparse(url_stream).path   # /live/<uuid>
        if not path:
            return None
        return f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}{path}"
    except Exception:
        return None


def _update_db_status(cam_id: int, status: str) -> None:
    """Persiste status_conexao + ultima_conexao para câmeras RTMP no banco."""
    try:
        conn = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE cameras
                    SET status_conexao = %s,
                        ultima_conexao  = NOW(),
                        atualizado_em   = NOW()
                    WHERE id = %s
                """, (status, cam_id))
                conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        log.warning("[SURICATHA-LOG] %s - [cam %d] Falha ao atualizar status no DB: %s",
                    _ts(), cam_id, exc)


def _load_rtmp_cameras() -> list[dict]:
    conn = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, nome, url_stream,
                       rec_lpr, rec_contagem_pessoas,
                       intervalo_captura_seg, janela_dedup_seg,
                       rec_deteccao_unica, limite_pessoas, zona_interesse,
                       COALESCE(faixa_horaria, '00:00-23:59') AS faixa_horaria
                FROM cameras
                WHERE protocolo = 'rtmp'
                  AND ativa = TRUE
                  AND url_stream IS NOT NULL
                ORDER BY id
            """)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# ── Per-camera worker thread ──────────────────────────────────────────────────

class RtmpCameraWorker(threading.Thread):

    def __init__(self, cam: dict, lpr_pool: concurrent.futures.ProcessPoolExecutor):
        super().__init__(name=f"rtmp-cam{cam['id']}", daemon=True)
        self._cam    = cam
        self._pool   = lpr_pool
        self._stop   = threading.Event()
        self._ok     = False
        self._errors = 0

    @property
    def is_ok(self) -> bool:
        return self._ok

    def stop(self):
        self._stop.set()

    def run(self):
        relay_url = _rtsp_relay_url(self._cam["url_stream"])
        if not relay_url:
            log.error("[SURICATHA-LOG] %s - [cam %d] URL inválida: %s",
                      _ts(), self._cam["id"], self._cam["url_stream"])
            _update_db_status(self._cam["id"], "erro")
            return

        log.info("[SURICATHA-LOG] %s - [cam %d] RTMP worker iniciado — relay %s",
                 _ts(), self._cam["id"], relay_url)

        while not self._stop.is_set():
            try:
                self._stream_loop(relay_url)
            except Exception as exc:
                self._ok      = False
                self._errors += 1
                log.error("[SURICATHA-LOG] %s - [cam %d] Erro inesperado: %s",
                          _ts(), self._cam["id"], exc)
            if not self._stop.is_set():
                _update_db_status(self._cam["id"], "offline")
                self._stop.wait(RECONNECT_DELAY_S)

    def _stream_loop(self, relay_url: str):
        os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
        cap = cv2.VideoCapture(relay_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, STREAM_TIMEOUT_S * 1000)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, STREAM_TIMEOUT_S * 1000)

        if not cap.isOpened():
            log.info("[SURICATHA-LOG] %s - [cam %d] Stream não disponível — câmera ainda não publicando",
                     _ts(), self._cam["id"])
            cap.release()
            self._ok = False
            return

        log.info("[SURICATHA-LOG] %s - [cam %d] Stream RTMP aberto — %.0f fps  %dx%d",
                 _ts(), self._cam["id"],
                 cap.get(cv2.CAP_PROP_FPS),
                 int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                 int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))

        self._ok     = True
        self._errors = 0
        _update_db_status(self._cam["id"], "online")

        interval     = max(1, self._cam.get("intervalo_captura_seg") or DEFAULT_INTERVAL_S)
        last_cap     = 0.0
        # Thread pool for blocking inference — keeps cap.read() draining the buffer
        _infer_pool  = concurrent.futures.ThreadPoolExecutor(
                           max_workers=1,
                           thread_name_prefix=f"rtmp-infer-{self._cam['id']}")

        try:
            while not self._stop.is_set():
                ret, frame = cap.read()
                if not ret or frame is None:
                    log.warning("[SURICATHA-LOG] %s - [cam %d] Stream RTMP perdido",
                                _ts(), self._cam["id"])
                    self._ok = False
                    break

                now = time.time()
                if now - last_cap < interval:
                    continue   # drain buffer without sleeping — prevents write queue full
                last_cap = now

                if self._cam.get("rec_lpr"):
                    self._submit_lpr(frame)

                if self._cam.get("rec_contagem_pessoas"):
                    # Run inference in a thread so cap.read() is never blocked
                    _infer_pool.submit(self._count_people, frame.copy())
        finally:
            _infer_pool.shutdown(wait=False)
            cap.release()
            self._ok = False

    # ── LPR ──────────────────────────────────────────────────────────────────

    def _submit_lpr(self, frame):
        try:
            ts  = int(time.time() * 1000)
            tmp = Path(tempfile.gettempdir()) / f"rtmp_lpr_{self._cam['id']}_{ts}.jpg"
            ok  = cv2.imwrite(str(tmp), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if not ok:
                log.warning("[SURICATHA-LOG] %s - [cam %d] Falha ao salvar frame",
                            _ts(), self._cam["id"])
                return
            from services.watchdog_service import lpr_worker
            future = self._pool.submit(lpr_worker, str(tmp), DB_DSN, self._cam["id"])
            future.add_done_callback(self._on_lpr_done)
        except Exception as exc:
            log.error("[SURICATHA-LOG] %s - [cam %d] Erro LPR submit: %s",
                      _ts(), self._cam["id"], exc)

    def _on_lpr_done(self, future: concurrent.futures.Future):
        try:
            result = future.result()
            if result.get("placa"):
                log.info("[SURICATHA-LOG] %s - [cam %d] LPR placa=%-9s conf=%.1f%%",
                         _ts(), self._cam["id"],
                         result["placa"], (result.get("confianca") or 0) * 100)
        except Exception as exc:
            log.error("[SURICATHA-LOG] %s - [cam %d] LPR resultado erro: %s",
                      _ts(), self._cam["id"], exc)

    # ── Contagem de pessoas ───────────────────────────────────────────────────

    def _count_people(self, frame):
        try:
            from services.rtsp_people_counter import (
                _yolo, _save_count, _apply_roi, CameraConfig,
                SAVE_ZERO_FRAMES, _in_schedule,
            )
            # Respeita faixa horária
            faixa = self._cam.get("faixa_horaria") or "00:00-23:59"
            if not _in_schedule(faixa):
                return

            frame_roi             = _apply_roi(frame, self._cam.get("zona_interesse"))
            t0                    = time.monotonic()
            total, detalhes, conf = _yolo.detect(frame_roi)
            tempo_ms              = int((time.monotonic() - t0) * 1000)

            # Só persiste frames com pessoas (ou quando SAVE_ZERO_FRAMES ativo)
            if total == 0 and not SAVE_ZERO_FRAMES:
                return

            cam_cfg = CameraConfig(
                id             = self._cam["id"],
                nome           = self._cam["nome"],
                url_stream     = self._cam.get("url_stream") or "",
                limite_pessoas = self._cam.get("limite_pessoas"),
                zona_interesse = self._cam.get("zona_interesse"),
            )
            _save_count(cam_cfg, total, detalhes, conf, tempo_ms,
                        dry_run=False, frame=frame_roi)
        except Exception as exc:
            log.error("[SURICATHA-LOG] %s - [cam %d] Contagem erro: %s",
                      _ts(), self._cam["id"], exc)


# ── Service manager ───────────────────────────────────────────────────────────

class RtmpStreamService:

    def __init__(self):
        self._workers: dict[int, RtmpCameraWorker] = {}
        self._lock    = threading.Lock()
        self._pool    = concurrent.futures.ProcessPoolExecutor(max_workers=2)

    def start(self):
        cams = _load_rtmp_cameras()
        if not cams:
            log.info("[SURICATHA-LOG] %s - Nenhuma câmera RTMP ativa", _ts())
            return
        log.info("[SURICATHA-LOG] %s - Iniciando %d worker(s) RTMP", _ts(), len(cams))
        with self._lock:
            for cam in cams:
                if cam["id"] not in self._workers:
                    w = RtmpCameraWorker(cam, self._pool)
                    self._workers[cam["id"]] = w
                    w.start()

    def reload(self):
        """Relê câmeras do banco sem reiniciar a API."""
        cams   = {c["id"]: c for c in _load_rtmp_cameras()}
        active = set(cams.keys())
        with self._lock:
            running = set(self._workers.keys())
            for cam_id in running - active:
                log.info("[SURICATHA-LOG] %s - Parando RTMP worker cam_id=%d", _ts(), cam_id)
                self._workers[cam_id].stop()
                del self._workers[cam_id]
            for cam_id in active - running:
                w = RtmpCameraWorker(cams[cam_id], self._pool)
                self._workers[cam_id] = w
                w.start()
                log.info("[SURICATHA-LOG] %s - Novo RTMP worker cam_id=%d", _ts(), cam_id)

    def status(self) -> list[dict]:
        with self._lock:
            return [
                {
                    "cam_id"   : cid,
                    "stream_ok": w.is_ok,
                    "alive"    : w.is_alive(),
                    "errors"   : w._errors,
                }
                for cid, w in self._workers.items()
            ]

    def stop(self):
        with self._lock:
            for w in self._workers.values():
                w.stop()
            self._workers.clear()
        self._pool.shutdown(wait=False)
        log.info("[SURICATHA-LOG] %s - Todos os workers RTMP parados", _ts())


# ── Singleton ─────────────────────────────────────────────────────────────────

_service: Optional[RtmpStreamService] = None


def get_service() -> Optional[RtmpStreamService]:
    return _service


def start_service() -> RtmpStreamService:
    global _service
    if _service is None:
        _service = RtmpStreamService()
        threading.Thread(target=_service.start, daemon=True, name="rtmp-service-init").start()
    return _service
