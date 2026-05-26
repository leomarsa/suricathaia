"""
/app/services/rtsp_epi_service.py
SuricathaIA — Análise EPI/PPE em Tempo Real via RTSP

Para cada câmera com rec_epi=True e url_stream configurada:
  - Abre o stream RTSP via OpenCV
  - Captura um frame a cada EPI_CAPTURE_INTERVAL_S segundos
  - Roda PPEDetector (dois modelos: YOLOv8 pessoa + capacete + cor colete)
  - Salva evento em eventos_epi
  - Dispara SSE epi_violacao se não conforme
  - Reconecta automaticamente em caso de queda

Suporte a câmeras Intelbras via HTTP snapshot (GET /cgi-bin/snapshot.cgi)
quando protocolo_lpr='intelbras_api' e credentials configuradas.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Callable

import cv2
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
sys.path.insert(0, str(Path(__file__).parent.parent))

# ── Config ─────────────────────────────────────────────────────────────────────

DB_DSN               = os.getenv("POSTGRES_DSN", "")
SNAPSHOTS_DIR        = Path("/app/snapshots")
EPI_CAPTURE_INTERVAL = float(os.getenv("EPI_CAPTURE_INTERVAL_S", "10"))
EPI_RECONNECT_DELAY  = float(os.getenv("EPI_RECONNECT_DELAY_S",  "15"))
RTSP_TIMEOUT_S       = int(os.getenv("RTSP_TIMEOUT_S",           "15"))
RTSP_BUFFER_SIZE     = int(os.getenv("RTSP_BUFFER_SIZE",          "1"))
EPI_REFRESH_INTERVAL = float(os.getenv("EPI_REFRESH_INTERVAL_S", "120"))
EPI_SAVE_CONFORMES   = os.getenv("EPI_SAVE_CONFORMES", "false").lower() == "true"
# Nº de capturas consecutivas com violação antes de salvar/alertar (anti-falso-alarme)
EPI_CONFIRM_FRAMES   = int(os.getenv("EPI_CONFIRM_FRAMES", "2"))

log = logging.getLogger("suricatha.rtsp_epi")

# ── Helpers ───────────────────────────────────────────────────────────────────

def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    return psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)


def _in_schedule(faixa: str) -> bool:
    if not faixa or faixa.strip() == "00:00-23:59":
        return True
    try:
        ini, fim = faixa.strip().split("-")
        h1, m1   = map(int, ini.split(":"))
        h2, m2   = map(int, fim.split(":"))
        from datetime import datetime as _dt
        now   = _dt.now()
        curr  = now.hour * 60 + now.minute
        start = h1 * 60 + m1
        end   = h2 * 60 + m2
        return (curr >= start or curr <= end) if start > end else (start <= curr <= end)
    except Exception:
        return True


# ── Câmera config ─────────────────────────────────────────────────────────────

@dataclass
class EpiCameraConfig:
    id:             int
    nome:           str
    url_stream:     Optional[str]
    faixa_horaria:  str  = "00:00-23:59"
    zona_interesse: Optional[str] = None
    # HTTP snapshot (Intelbras)
    protocolo_lpr:  str  = "sftp"
    ip_sftp:        Optional[str] = None
    usuario_camera: Optional[str] = None
    senha_camera:   Optional[str] = None
    porta_http:     int  = 80
    https_camera:   bool = False


def _load_epi_cameras() -> list[EpiCameraConfig]:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, nome, url_stream,
                           COALESCE(faixa_horaria, '00:00-23:59') AS faixa_horaria,
                           zona_interesse,
                           protocolo_lpr,
                           split_part(ip_sftp::text, '/', 1) AS ip_sftp,
                           usuario_camera, senha_camera,
                           porta_http, https_camera
                    FROM cameras
                    WHERE rec_epi = TRUE
                      AND ativa = TRUE
                      AND (
                          (url_stream IS NOT NULL AND url_stream != '')
                          OR protocolo_lpr = 'intelbras_api'
                      )
                    ORDER BY id
                """)
                return [EpiCameraConfig(**dict(r)) for r in cur.fetchall()]
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - [EPI-RTSP] Falha ao carregar câmeras: %s", _ts(), exc)
        return []


# ── Anotação de frame ─────────────────────────────────────────────────────────

def _annotate_frame(frame: np.ndarray, detalhes: list) -> np.ndarray:
    out = frame.copy()
    for d in detalhes:
        if not d.get("is_person") or not d.get("bbox"):
            continue
        x1, y1, x2, y2 = d["bbox"]
        tem_cap = d.get("tem_capacete", False)
        tem_col = d.get("tem_colete", False)

        if tem_cap and tem_col:
            color = (0, 200, 80)
            label = f"OK {d.get('confianca', 0):.0%}"
        elif tem_cap:
            color = (0, 200, 240)
            label = f"SEM COLETE {d.get('confianca', 0):.0%}"
        elif tem_col:
            color = (0, 180, 255)
            label = f"SEM CAPACETE {d.get('confianca', 0):.0%}"
        else:
            color = (30, 30, 220)
            label = f"SEM EPI {d.get('confianca', 0):.0%}"

        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        cv2.rectangle(out, (x1, max(y1 - th - 8, 0)), (x1 + tw + 4, max(y1, th + 8)), color, -1)
        cv2.putText(out, label, (x1 + 2, max(y1 - 4, th + 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    return out


# ── Persistência ──────────────────────────────────────────────────────────────

def _save_epi(cam: EpiCameraConfig, dados: dict, tempo_ms: int,
              frame: Optional[np.ndarray] = None) -> Optional[int]:
    total     = dados.get("total_pessoas", 0)
    conform   = dados.get("conformidade", True)
    sem_cap   = dados.get("sem_capacete", 0)
    sem_col   = dados.get("sem_colete", 0)
    detalhes  = dados.get("detalhes", [])

    log.info("[SURICATHA-LOG] %s - [EPI-RTSP] cam=%s pessoas=%d cap=%d/%d col=%d/%d conform=%s %dms",
             _ts(), cam.nome, total,
             dados.get("com_capacete", 0), total,
             dados.get("com_colete", 0), total,
             conform, tempo_ms)

    try:
        conn = psycopg2.connect(DB_DSN)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO eventos_epi (
                    camera_id, arquivo_original,
                    total_pessoas, com_capacete, sem_capacete,
                    com_colete, sem_colete,
                    conformidade, percentual_conformidade,
                    detalhes, tempo_processo_ms
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
            """, (
                cam.id,
                f"rtsp_epi_{time.strftime('%Y%m%d_%H%M%S')}",
                total,
                dados.get("com_capacete", 0), sem_cap,
                dados.get("com_colete", 0),   sem_col,
                conform,
                dados.get("percentual_conformidade", 100.0),
                json.dumps(detalhes),
                tempo_ms,
            ))
            row_id = cur.fetchone()[0]

            # Snapshot anotado
            snap_path: Optional[str] = None
            if frame is not None and total > 0:
                try:
                    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
                    annotated = _annotate_frame(frame, detalhes)
                    snap_name = f"epi_{row_id}.jpg"
                    cv2.imwrite(str(SNAPSHOTS_DIR / snap_name), annotated,
                                [cv2.IMWRITE_JPEG_QUALITY, 85])
                    snap_path = snap_name
                except Exception as exc:
                    log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] Snapshot falhou: %s", _ts(), exc)

            if snap_path:
                cur.execute("UPDATE eventos_epi SET snapshot_path=%s WHERE id=%s",
                            (snap_path, row_id))

        conn.commit()
        conn.close()

        if not conform:
            log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] VIOLAÇÃO cam=%s sem_cap=%d sem_col=%d",
                        _ts(), cam.nome, sem_cap, sem_col)
            try:
                from core.analytics.dispatcher import _save_alerta_epi
                _save_alerta_epi(
                    camera_id=cam.id,
                    evento_epi_id=row_id,
                    total=total,
                    sem_capacete=sem_cap,
                    sem_colete=sem_col,
                    pct_conf=dados.get("percentual_conformidade", 0.0),
                    snapshot_path=snap_path,
                    notificado=False,
                )
            except Exception as _ae:
                log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] Alerta EPI save: %s", _ts(), _ae)
        return row_id

    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - [EPI-RTSP] Save falhou: %s", _ts(), exc)
        return None


# ── Worker por câmera ─────────────────────────────────────────────────────────

class EpiCameraWorker(threading.Thread):
    """Thread que mantém conexão e processa frames EPI continuamente."""

    def __init__(self, cam: EpiCameraConfig):
        super().__init__(name=f"epi-cam{cam.id}", daemon=True)
        self._cam              = cam
        self._stop             = threading.Event()
        self._ok               = False
        self._errors           = 0
        self._last_result: Optional[dict] = None
        self._violation_streak = 0   # capturas consecutivas com violação
        self._pending_frame: Optional[np.ndarray] = None  # frame da 1ª detecção

    @property
    def is_ok(self) -> bool:
        return self._ok

    @property
    def last_result(self) -> Optional[dict]:
        return self._last_result

    def stop(self):
        self._stop.set()

    def run(self):
        log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Worker iniciado cam_id=%d (%s)",
                 _ts(), self._cam.id, self._cam.nome)
        while not self._stop.is_set():
            try:
                if self._cam.protocolo_lpr == "intelbras_api" and self._cam.ip_sftp:
                    self._http_loop()
                elif self._cam.url_stream:
                    self._rtsp_loop()
                else:
                    log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] cam_id=%d sem URL configurada",
                                _ts(), self._cam.id)
                    self._stop.wait(60)
            except Exception as exc:
                self._ok = False
                self._errors += 1
                log.error("[SURICATHA-LOG] %s - [EPI-RTSP] cam_id=%d erro: %s",
                          _ts(), self._cam.id, exc)
            if not self._stop.is_set():
                self._stop.wait(EPI_RECONNECT_DELAY)

    # ── RTSP loop ─────────────────────────────────────────────────────────────

    def _rtsp_loop(self):
        from core.analytics.ppe_detector import PPEDetector
        detector = PPEDetector()
        if not detector.wait_ready(120):
            log.error("[SURICATHA-LOG] %s - [EPI-RTSP] Modelos não carregaram — cam_id=%d",
                      _ts(), self._cam.id)
            return

        log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Conectando RTSP cam_id=%d %s",
                 _ts(), self._cam.id, self._cam.url_stream)

        cap = cv2.VideoCapture(self._cam.url_stream, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE,        RTSP_BUFFER_SIZE)
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)

        if not cap.isOpened():
            log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] Não abriu stream cam_id=%d",
                        _ts(), self._cam.id)
            cap.release()
            return

        log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Stream aberto cam_id=%d %.0ffps %dx%d",
                 _ts(), self._cam.id,
                 cap.get(cv2.CAP_PROP_FPS),
                 int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                 int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))

        self._ok     = True
        self._errors = 0
        last_capture = 0.0

        while not self._stop.is_set():
            ret, frame = cap.read()
            if not ret or frame is None:
                log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] Stream perdido cam_id=%d",
                            _ts(), self._cam.id)
                self._ok = False
                break

            now = time.time()
            if now - last_capture < EPI_CAPTURE_INTERVAL:
                time.sleep(0.05)
                continue

            last_capture = now

            if not _in_schedule(self._cam.faixa_horaria):
                time.sleep(30)
                continue

            self._process_frame(detector, frame)

        cap.release()
        self._ok = False

    # ── HTTP snapshot loop (Intelbras / câmeras HTTP) ─────────────────────────

    def _http_loop(self):
        import httpx
        from httpx import DigestAuth
        from core.analytics.ppe_detector import PPEDetector

        detector = PPEDetector()
        if not detector.wait_ready(120):
            return

        scheme = "https" if self._cam.https_camera else "http"
        ip     = (self._cam.ip_sftp or "").split("/")[0].strip()
        porta  = self._cam.porta_http or 80
        snap_url = f"{scheme}://{ip}:{porta}/cgi-bin/snapshot.cgi?channel=0&subtype=0"
        auth     = DigestAuth(
            self._cam.usuario_camera or "admin",
            self._cam.senha_camera   or "",
        )

        log.info("[SURICATHA-LOG] %s - [EPI-RTSP] HTTP snapshot loop cam_id=%d %s",
                 _ts(), self._cam.id, snap_url)

        self._ok     = True
        self._errors = 0

        while not self._stop.is_set():
            if not _in_schedule(self._cam.faixa_horaria):
                self._stop.wait(30)
                continue

            try:
                t0 = time.monotonic()
                resp = httpx.get(snap_url, auth=auth, timeout=10.0, follow_redirects=True)
                if resp.status_code != 200:
                    log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] HTTP %d cam_id=%d",
                                _ts(), resp.status_code, self._cam.id)
                    self._stop.wait(EPI_RECONNECT_DELAY)
                    continue

                img_array = np.frombuffer(resp.content, dtype=np.uint8)
                frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if frame is None:
                    self._stop.wait(EPI_CAPTURE_INTERVAL)
                    continue

                self._ok = True
                self._process_frame(detector, frame)

            except Exception as exc:
                self._ok = False
                self._errors += 1
                log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] HTTP erro cam_id=%d: %s",
                            _ts(), self._cam.id, exc)

            self._stop.wait(EPI_CAPTURE_INTERVAL)

        self._ok = False

    # ── Inferência + persistência ─────────────────────────────────────────────

    def _process_frame(self, detector, frame: np.ndarray):
        t0 = time.monotonic()
        result = detector.process_frame(frame)
        tempo_ms = int((time.monotonic() - t0) * 1000)

        if not result.success:
            log.warning("[SURICATHA-LOG] %s - [EPI-RTSP] Inferência falhou cam_id=%d: %s",
                        _ts(), self._cam.id, result.error)
            return

        d = result.dados
        self._last_result = d

        is_violation = not d.get("conformidade", True) and d.get("total_pessoas", 0) > 0

        if is_violation:
            self._violation_streak += 1
            if self._violation_streak == 1:
                # Guarda o frame para salvar junto com a confirmação
                self._pending_frame = frame.copy()
                log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Violação pendente cam_id=%d (%d/%d)",
                         _ts(), self._cam.id, self._violation_streak, EPI_CONFIRM_FRAMES)
            if self._violation_streak >= EPI_CONFIRM_FRAMES:
                # Confirmada — salva usando o frame mais recente
                _save_epi(self._cam, d, tempo_ms, frame)
                self._violation_streak = 0
                self._pending_frame = None
        else:
            # Sequência interrompida — descarta
            if self._violation_streak > 0:
                log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Violação descartada (não confirmada) cam_id=%d",
                         _ts(), self._cam.id)
            self._violation_streak = 0
            self._pending_frame = None

            if d.get("total_pessoas", 0) > 0 and EPI_SAVE_CONFORMES:
                _save_epi(self._cam, d, tempo_ms, frame)
            elif d.get("total_pessoas", 0) > 0:
                log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Conforme cam_id=%d — %d pessoa(s) OK",
                         _ts(), self._cam.id, d.get("total_pessoas", 0))


# ── Serviço principal ─────────────────────────────────────────────────────────

class RtspEpiService:
    """
    Gerencia workers EPI RTSP para todas as câmeras com rec_epi=True.
    Loop de sincronização detecta câmeras novas/desativadas a cada EPI_REFRESH_INTERVAL s.
    """

    def __init__(self):
        self._workers:      dict[int, EpiCameraWorker] = {}
        self._lock          = threading.Lock()
        self._global_stop   = threading.Event()
        self._watcher:      Optional[threading.Thread] = None

    def start(self) -> "RtspEpiService":
        # Aguarda modelos PPE carregarem antes de iniciar workers
        threading.Thread(target=self._init, daemon=True, name="epi-svc-init").start()
        return self

    def _init(self):
        from core.analytics.ppe_detector import PPEDetector
        detector = PPEDetector()
        log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Aguardando modelos PPE...", _ts())
        if not detector.wait_ready(120):
            log.critical("[SURICATHA-LOG] %s - [EPI-RTSP] Modelos não carregaram!", _ts())
            return
        log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Modelos prontos. Iniciando workers.", _ts())
        self._sync_cameras()
        self._watcher = threading.Thread(
            target=self._watch_loop, daemon=True, name="epi-svc-watcher"
        )
        self._watcher.start()

    def _watch_loop(self):
        while not self._global_stop.is_set():
            self._global_stop.wait(EPI_REFRESH_INTERVAL)
            if not self._global_stop.is_set():
                self._sync_cameras()

    def _sync_cameras(self):
        cameras    = {c.id: c for c in _load_epi_cameras()}
        active_ids = set(cameras.keys())

        with self._lock:
            running_ids = set(self._workers.keys())

            # Para workers de câmeras removidas/desativadas
            for cam_id in running_ids - active_ids:
                log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Removendo cam_id=%d", _ts(), cam_id)
                self._workers[cam_id].stop()
                del self._workers[cam_id]

            # Inicia workers para câmeras novas (ou mortas)
            for cam_id, cam in cameras.items():
                existing = self._workers.get(cam_id)
                if existing and existing.is_alive():
                    continue
                w = EpiCameraWorker(cam)
                self._workers[cam_id] = w
                w.start()
                log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Worker iniciado cam_id=%d (%s)",
                         _ts(), cam_id, cam.nome)

    def reload(self):
        self._sync_cameras()

    def status(self) -> list[dict]:
        with self._lock:
            result = []
            for cam_id, w in self._workers.items():
                last = w.last_result or {}
                result.append({
                    "cam_id"     : cam_id,
                    "cam_nome"   : w._cam.nome,
                    "stream_ok"  : w.is_ok,
                    "alive"      : w.is_alive(),
                    "errors"     : w._errors,
                    "last_pessoas": last.get("total_pessoas"),
                    "last_conform": last.get("conformidade"),
                    "last_sem_cap": last.get("sem_capacete"),
                    "last_sem_col": last.get("sem_colete"),
                })
            return result

    def stop(self):
        self._global_stop.set()
        with self._lock:
            for w in self._workers.values():
                w.stop()
            self._workers.clear()
        log.info("[SURICATHA-LOG] %s - [EPI-RTSP] Serviço encerrado", _ts())


# ── Singleton ─────────────────────────────────────────────────────────────────

_service: Optional[RtspEpiService] = None


def get_service() -> Optional[RtspEpiService]:
    return _service


def start_service() -> RtspEpiService:
    global _service
    if _service is None:
        _service = RtspEpiService()
        _service.start()
    return _service
