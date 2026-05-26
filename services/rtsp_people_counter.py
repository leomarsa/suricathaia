"""
/app/services/rtsp_people_counter.py
SuricathaIA — Contagem de Pessoas via RTSP + YOLOv8

Para cada câmera com rec_contagem_pessoas=True e url_stream configurada:
  - Abre o stream RTSP via OpenCV
  - Captura um frame a cada CAPTURE_INTERVAL_S segundos
  - Processa com YOLOv8n (classe 0 = pessoa)
  - Salva contagem em contagens_pessoas
  - Dispara alerta se total_pessoas >= limite_pessoas
  - Reconecta automaticamente em caso de queda do stream

Uso:
    python services/rtsp_people_counter.py          # inicia todos os streams
    python services/rtsp_people_counter.py --cam 2  # só câmera id=2
    python services/rtsp_people_counter.py --dry-run # testa conexão sem salvar

Importado pela API:
    from services.rtsp_people_counter import RtspPeopleService
    svc = RtspPeopleService(); svc.start()
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import signal
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
sys.path.insert(0, str(Path(__file__).parent.parent))

# ── Config ─────────────────────────────────────────────────────────────────────

DB_DSN             = os.getenv("POSTGRES_DSN", "")
SNAPSHOTS_DIR      = Path("/app/snapshots")
MODEL_PATH         = os.getenv("YOLO_PEOPLE_MODEL", "/opt/suricatha/models/yolov8n.pt")
CAPTURE_INTERVAL_S = float(os.getenv("RTSP_CAPTURE_INTERVAL_S", "5"))   # captura a cada N segundos
RECONNECT_DELAY_S  = float(os.getenv("RTSP_RECONNECT_DELAY_S",  "10"))  # aguarda antes de reconectar
CONF_THRESHOLD     = float(os.getenv("PEOPLE_CONF_THRESHOLD",   "0.45"))
YOLO_CPU_THREADS   = int(os.getenv("YOLO_CPU_THREADS",          "4"))
RTSP_TIMEOUT_S     = int(os.getenv("RTSP_TIMEOUT_S",            "15"))   # timeout abertura stream
# Se False (padrão), só persiste frames onde ao menos 1 pessoa foi detectada.
# Setar True para gravar todos os frames (inclui frames vazios — aumenta muito o volume).
SAVE_ZERO_FRAMES   = os.getenv("SAVE_ZERO_FRAMES", "false").lower() == "true"

logging.basicConfig(
    level=logging.INFO,
    format="[RTSP-PESSOAS] %(asctime)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("suricatha.rtsp_pessoas")


# ── Modelo YOLO (singleton compartilhado entre threads) ───────────────────────

class _YoloModel:
    _instance = None
    _lock     = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._model = None
                cls._instance._ready = threading.Event()
                threading.Thread(target=cls._instance._load, daemon=True).start()
        return cls._instance

    def _load(self):
        log.info("Carregando YOLOv8n: %s", MODEL_PATH)
        try:
            from ultralytics import YOLO
            import torch
            torch.set_num_threads(YOLO_CPU_THREADS)
            m = YOLO(MODEL_PATH)
            m.overrides["device"] = "cpu"
            # warm-up com frame vazio
            dummy = np.zeros((480, 640, 3), dtype=np.uint8)
            m.predict(dummy, classes=[0], conf=CONF_THRESHOLD, verbose=False)
            self._model = m
            log.info("YOLOv8n pronto")
        except Exception as exc:
            log.critical("Falha ao carregar YOLOv8n: %s", exc)
        finally:
            self._ready.set()

    def wait_ready(self, timeout=120) -> bool:
        return self._ready.wait(timeout=timeout)

    def detect(self, frame: np.ndarray) -> tuple[int, list[dict], float]:
        """
        Retorna (total_pessoas, detalhes, confianca_media).
        detalhes: lista de {x1,y1,x2,y2,conf}
        """
        if self._model is None:
            return 0, [], 0.0
        results = self._model.predict(
            frame, classes=[0], conf=CONF_THRESHOLD, verbose=False, stream=False
        )
        detalhes = []
        confs    = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                conf = float(box.conf[0])
                detalhes.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "conf": round(conf, 4)})
                confs.append(conf)
        confianca_media = round(sum(confs) / len(confs), 4) if confs else 0.0
        return len(detalhes), detalhes, confianca_media


_yolo = _YoloModel()


# ── Câmera ────────────────────────────────────────────────────────────────────

@dataclass
class CameraConfig:
    id:              int
    nome:            str
    url_stream:      str
    limite_pessoas:  Optional[int]
    zona_interesse:  Optional[str]
    faixa_horaria:   str = "00:00-23:59"


def _load_cameras(cam_filter: Optional[int] = None) -> list[CameraConfig]:
    conn = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, nome, url_stream, limite_pessoas, zona_interesse,
                       COALESCE(faixa_horaria, '00:00-23:59') AS faixa_horaria
                FROM cameras
                WHERE rec_contagem_pessoas = TRUE
                  AND ativa = TRUE
                  AND protocolo != 'rtmp'
                  AND url_stream IS NOT NULL
                  AND url_stream != ''
                  %s
                ORDER BY id
            """ % ("AND id = %s" if cam_filter else ""),
            (cam_filter,) if cam_filter else ())
            return [CameraConfig(**dict(r)) for r in cur.fetchall()]
    finally:
        conn.close()


def _in_schedule(faixa: str) -> bool:
    """Retorna True se o horário atual está dentro da faixa 'HH:MM-HH:MM'."""
    if not faixa or faixa.strip() == "00:00-23:59":
        return True
    try:
        ini, fim = faixa.strip().split("-")
        h1, m1 = map(int, ini.split(":"))
        h2, m2 = map(int, fim.split(":"))
        from datetime import datetime as _dt
        now  = _dt.now()
        curr = now.hour * 60 + now.minute
        start = h1 * 60 + m1
        end   = h2 * 60 + m2
        if start <= end:
            return start <= curr <= end
        # overnight (ex: 22:00-06:00)
        return curr >= start or curr <= end
    except Exception:
        return True


def _annotate_frame(frame: np.ndarray, detalhes: list[dict]) -> np.ndarray:
    """Desenha bounding boxes e confiança sobre o frame para o snapshot."""
    out = frame.copy()
    for d in detalhes:
        x1, y1, x2, y2 = d["x1"], d["y1"], d["x2"], d["y2"]
        conf = d.get("conf", 0)
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 200, 255), 2)
        cv2.putText(out, f"{conf:.0%}", (x1, max(y1 - 6, 10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1, cv2.LINE_AA)
    return out


def _save_count(cam: CameraConfig, total: int, detalhes: list[dict],
                confianca: float, tempo_ms: int, dry_run: bool,
                frame: Optional[np.ndarray] = None) -> Optional[int]:
    # Alerta quando total_pessoas >= limite (>= consistente com core/people_counter.py)
    alerta = bool(cam.limite_pessoas and total >= cam.limite_pessoas)
    log.info("cam_id=%-3d %-30s pessoas=%-3d conf=%.2f%% alerta=%-5s tempo=%dms",
             cam.id, cam.nome[:30], total, confianca * 100, str(alerta), tempo_ms)

    if dry_run:
        return None

    conn = psycopg2.connect(DB_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO contagens_pessoas (
                    camera_id, arquivo_original, total_pessoas,
                    confianca_media, detalhes, alerta_lotacao, tempo_processo_ms
                ) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
            """, (
                cam.id,
                f"rtsp_frame_{time.strftime('%Y%m%d_%H%M%S')}",
                total,
                confianca,
                json.dumps(detalhes),
                alerta,
                tempo_ms,
            ))
            row_id = cur.fetchone()[0]

            # Salva snapshot com bounding boxes anotados
            snap_path: Optional[str] = None
            if frame is not None:
                try:
                    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
                    annotated = _annotate_frame(frame, detalhes) if detalhes else frame
                    rel_name  = f"pessoas_{row_id}.jpg"
                    snap_file = SNAPSHOTS_DIR / rel_name
                    cv2.imwrite(str(snap_file), annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
                    snap_path = rel_name
                except Exception as exc:
                    log.warning("Snapshot save failed: %s", exc)
            if snap_path:
                cur.execute("UPDATE contagens_pessoas SET snapshot_path = %s WHERE id = %s",
                            (snap_path, row_id))

        conn.commit()

        if alerta:
            log.warning("ALERTA LOTAÇÃO cam_id=%d nome=%s — %d/%d pessoas",
                        cam.id, cam.nome, total, cam.limite_pessoas)
            try:
                from core.analytics.dispatcher import _save_alerta_lotacao
                _save_alerta_lotacao(
                    camera_id=cam.id,
                    contagem_id=row_id,
                    total=total,
                    limite=cam.limite_pessoas,
                    confianca=confianca,
                    snapshot_path=snap_path,
                    notificado=False,
                )
            except Exception as _ae:
                log.warning("Alerta lotacao save: %s", _ae)
        return row_id
    finally:
        conn.close()


def _apply_roi(frame: np.ndarray, roi_json: Optional[str]) -> np.ndarray:
    """Máscara preta fora do polígono ROI (coordenadas relativas 0-1).
    Se roi_json não for um JSON de coordenadas válido (ex: texto livre), retorna frame intacto.
    """
    if not roi_json:
        return frame
    try:
        pts_rel = json.loads(roi_json)
        # Deve ser lista de pelo menos 3 pares [x, y]
        if not isinstance(pts_rel, list) or len(pts_rel) < 3 or not isinstance(pts_rel[0], (list, tuple)):
            return frame
        h, w = frame.shape[:2]
        pts  = np.array([[int(p[0]*w), int(p[1]*h)] for p in pts_rel], dtype=np.int32)
        mask = np.zeros(frame.shape[:2], dtype=np.uint8)
        cv2.fillPoly(mask, [pts], 255)
        return cv2.bitwise_and(frame, frame, mask=mask)
    except Exception:
        return frame


# ── Worker por câmera ──────────────────────────────────────────────────────────

class CameraWorker(threading.Thread):
    """Thread que mantém conexão RTSP e processa frames continuamente."""

    def __init__(self, cam: CameraConfig, dry_run: bool = False):
        super().__init__(name=f"rtsp-cam{cam.id}", daemon=True)
        self._cam     = cam
        self._dry_run = dry_run
        self._stop    = threading.Event()
        self._ok      = False        # última captura bem-sucedida
        self._last_n  = 0            # última contagem
        self._errors  = 0

    @property
    def is_ok(self) -> bool:
        return self._ok

    @property
    def last_count(self) -> int:
        return self._last_n

    def stop(self):
        self._stop.set()

    def run(self):
        log.info("[cam %d] Iniciando worker — %s", self._cam.id, self._cam.url_stream)
        while not self._stop.is_set():
            try:
                self._stream_loop()
            except Exception as exc:
                self._ok = False
                self._errors += 1
                log.error("[cam %d] Erro inesperado: %s — reconectando em %ds",
                          self._cam.id, exc, RECONNECT_DELAY_S)
            if not self._stop.is_set():
                self._stop.wait(RECONNECT_DELAY_S)

    def _stream_loop(self):
        log.info("[cam %d] Conectando ao stream RTSP...", self._cam.id)

        cap = cv2.VideoCapture(self._cam.url_stream, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)

        if not cap.isOpened():
            log.warning("[cam %d] Não foi possível abrir o stream", self._cam.id)
            self._ok = False
            cap.release()
            return

        log.info("[cam %d] Stream aberto — %.0f fps  %dx%d",
                 self._cam.id,
                 cap.get(cv2.CAP_PROP_FPS),
                 int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                 int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))

        self._ok      = True
        self._errors  = 0
        last_capture  = 0.0

        while not self._stop.is_set():
            ret, frame = cap.read()
            if not ret or frame is None:
                log.warning("[cam %d] Stream perdido", self._cam.id)
                self._ok = False
                break

            now = time.time()
            if now - last_capture < CAPTURE_INTERVAL_S:
                time.sleep(0.05)   # evita busy-loop
                continue

            last_capture = now

            # Verifica faixa horária — pula inferência mas mantém stream aberto
            if not _in_schedule(self._cam.faixa_horaria):
                time.sleep(30)   # dorme 30s antes de verificar novamente
                continue

            t0 = time.monotonic()

            # Aplica ROI se configurada
            frame_roi = _apply_roi(frame, self._cam.zona_interesse)

            # Inferência YOLO
            total, detalhes, confianca = _yolo.detect(frame_roi)
            tempo_ms = int((time.monotonic() - t0) * 1000)

            self._last_n = total

            # Só persiste quando há pessoas OU quando SAVE_ZERO_FRAMES está ativo
            if total > 0 or SAVE_ZERO_FRAMES:
                _save_count(self._cam, total, detalhes, confianca, tempo_ms, self._dry_run, frame_roi)

        cap.release()
        self._ok = False


# ── Serviço principal ──────────────────────────────────────────────────────────

class RtspPeopleService:
    """
    Gerencia os workers RTSP de todas as câmeras com rec_contagem_pessoas=True.
    Suporta reload dinâmico via reload().
    """

    def __init__(self, cam_filter: Optional[int] = None, dry_run: bool = False):
        self._cam_filter = cam_filter
        self._dry_run    = dry_run
        self._workers: dict[int, CameraWorker] = {}
        self._lock    = threading.Lock()

    def start(self):
        log.info("Aguardando YOLOv8n carregar...")
        if not _yolo.wait_ready(120):
            log.critical("YOLOv8n não carregou em 120s — abortando")
            return
        self._spawn_all()

    def _spawn_all(self):
        cams = _load_cameras(self._cam_filter)
        if not cams:
            log.warning("Nenhuma câmera RTSP ativa com rec_contagem_pessoas=True")
            return
        log.info("Iniciando %d worker(s) RTSP", len(cams))
        with self._lock:
            for cam in cams:
                if cam.id not in self._workers:
                    w = CameraWorker(cam, self._dry_run)
                    self._workers[cam.id] = w
                    w.start()

    def reload(self):
        """Relê o banco e inicia workers para câmeras novas; para workers de câmeras desativadas."""
        cams   = {c.id: c for c in _load_cameras(self._cam_filter)}
        active = set(cams.keys())
        with self._lock:
            running = set(self._workers.keys())
            # Para workers de câmeras removidas/desativadas
            for cam_id in running - active:
                log.info("Parando worker cam_id=%d (desativada)", cam_id)
                self._workers[cam_id].stop()
                del self._workers[cam_id]
            # Inicia workers para câmeras novas
            for cam_id in active - running:
                w = CameraWorker(cams[cam_id], self._dry_run)
                self._workers[cam_id] = w
                w.start()
                log.info("Novo worker iniciado cam_id=%d", cam_id)

    def status(self) -> list[dict]:
        with self._lock:
            return [
                {
                    "cam_id":     cam_id,
                    "cam_nome":   w._cam.nome,
                    "stream_ok":  w.is_ok,
                    "last_count": w.last_count,
                    "alive":      w.is_alive(),
                    "errors":     w._errors,
                }
                for cam_id, w in self._workers.items()
            ]

    def stop(self):
        with self._lock:
            for w in self._workers.values():
                w.stop()
            self._workers.clear()
        log.info("Todos os workers RTSP parados")


# ── Singleton para a API ───────────────────────────────────────────────────────

_service: Optional[RtspPeopleService] = None


def get_service() -> Optional[RtspPeopleService]:
    return _service


def start_service(cam_filter: Optional[int] = None, dry_run: bool = False) -> RtspPeopleService:
    global _service
    if _service is None:
        _service = RtspPeopleService(cam_filter=cam_filter, dry_run=dry_run)
        threading.Thread(target=_service.start, daemon=True, name="rtsp-service-init").start()
    return _service


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SuricathaIA — Contagem RTSP")
    parser.add_argument("--cam",     type=int, help="Processa só esta câmera (id)")
    parser.add_argument("--dry-run", action="store_true", help="Não salva no banco")
    parser.add_argument("--interval", type=float, default=CAPTURE_INTERVAL_S,
                        help=f"Intervalo de captura em segundos (padrão: {CAPTURE_INTERVAL_S})")
    args = parser.parse_args()

    CAPTURE_INTERVAL_S = args.interval

    svc  = RtspPeopleService(cam_filter=args.cam, dry_run=args.dry_run)
    stop = threading.Event()

    def _sig(s, _): stop.set()
    signal.signal(signal.SIGINT,  _sig)
    signal.signal(signal.SIGTERM, _sig)

    svc.start()

    log.info("Serviço rodando — Ctrl+C para parar")
    try:
        while not stop.is_set():
            time.sleep(10)
            for s in svc.status():
                log.info("  cam_id=%-3d stream=%-5s count=%-3d alive=%-5s erros=%d",
                         s["cam_id"], str(s["stream_ok"]), s["last_count"],
                         str(s["alive"]), s["errors"])
    finally:
        svc.stop()
        log.info("Encerrado")
