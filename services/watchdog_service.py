"""
/app/services/watchdog_service.py
SuricathaIA — Serviço de Monitoramento v4.0
Watchdog multi-câmera + roteamento por pilar

Estrutura monitorada:
  /srv/suricatha/sftp_camera/
    cam_001/
      lpr/   → imagens JPG → LPR worker (PaddleOCR, ProcessPool)
      epi/   → imagens JPG → EPI worker (YOLOv8, ThreadPool) direto
    cam_002/
      ...

Legado (câmera_lpr user antigo):
  /home/camera_lpr/uploads/ → LPR worker (backward compat)

Pipeline:
  lpr/  JPG → P1 LPR (ProcessPool) → callback → P2 Pessoas / P3 EPI
  epi/  JPG → P3 EPI direto (ThreadPool)
"""

import os
import sys
import time
import signal
import logging
import threading
import multiprocessing as mp
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

try:
    from watchdog.observers.inotify import InotifyObserver as Observer
except ImportError:
    from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileClosedEvent, FileMovedEvent

SFTP_ROOT    = Path(os.getenv("SFTP_ROOT",     "/srv/suricatha/sftp_camera"))
UPLOAD_DIR   = Path(os.getenv("UPLOAD_DIR",    "/home/camera_lpr/uploads"))
STORAGE_DIR  = Path(os.getenv("STORAGE_DIR",   "/opt/suricatha/storage"))
LOG_DIR      = Path(os.getenv("LOG_DIR",        "/opt/suricatha/logs"))
UPLOAD_DELAY = float(os.getenv("UPLOAD_DELAY_S", "0.5"))


def setup_logging():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        "[SURICATHA-LOG] %(asctime)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for h in [logging.StreamHandler(sys.stdout),
               logging.FileHandler(LOG_DIR / "suricatha.log", encoding="utf-8")]:
        h.setFormatter(fmt)
        root.addHandler(h)
    for noisy in ("ppocr","paddle","PIL","urllib3","httpx","ultralytics","httpcore"):
        logging.getLogger(noisy).setLevel(logging.ERROR)


log = logging.getLogger("suricatha.watchdog")


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ════════════════════════════════════════════════════════════════════════════
#  WORKERS
# ════════════════════════════════════════════════════════════════════════════

def lpr_worker(image_path: str, db_dsn: str, hint_camera_id: int = 0,
               fonte: str = "sftp_pillar") -> dict:
    """P1 — ProcessPool (PaddleOCR precisa de processo isolado).
    hint_camera_id: quando conhecido pela estrutura de diretório, evita resolve por filename.
    fonte: origem da imagem ('sftp_pillar' | 'sftp_legado' | 'reprocessamento').
    """
    import logging as _log, os as _os, sys as _sys, time as _time
    _log.basicConfig(level=_log.INFO,
                     format="[SURICATHA-LOG] %(asctime)s - %(message)s",
                     datefmt="%Y-%m-%d %H:%M:%S")
    _os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    _os.environ["POSTGRES_DSN"] = db_dsn
    _sys.path.insert(0, "/app")

    from pathlib import Path as P
    import shutil, datetime
    path = P(image_path)

    try:
        if not path.exists():
            # Arquivo já processado por outro worker (race condition) — skip silencioso
            return {"ok": True, "path": image_path, "skipped": True,
                    "placa": None, "confianca": None, "det_id": None, "camera_id": 0}
        if path.stat().st_size < 1024:
            return {"ok": False, "path": image_path, "error": "Arquivo inválido"}
        with open(path, "rb") as f:
            if f.read(2) != b"\xff\xd8":
                return {"ok": False, "path": image_path, "error": "Não é JPEG"}

        from core.engine import SuricathaEngine
        engine = SuricathaEngine()
        engine.wait_ready(120)
        result = engine.process_image(str(path))

        dest_dir = P(_os.getenv("STORAGE_DIR", "/opt/suricatha/storage")) / \
                   datetime.datetime.now().strftime("%Y-%m-%d")
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / path.name
        if dest.exists():
            dest = dest_dir / f"{path.stem}_{int(_time.time())}{path.suffix}"
        shutil.move(str(path), str(dest))
        _os.chmod(str(dest), 0o644)  # garante leitura pelo nginx (www-data)

        from services.database import DatabaseService
        db     = DatabaseService()
        cam_id = hint_camera_id if hint_camera_id > 0 else db.resolve_camera_id(path.name)

        # ── Deduplicação por câmera ───────────────────────────────────────────
        if result.placa:
            import psycopg2
            from psycopg2.extras import RealDictCursor as _RDC
            _conn_d = psycopg2.connect(db_dsn, cursor_factory=_RDC)
            with _conn_d.cursor() as _cur:
                _cur.execute("""
                    SELECT c.rec_deteccao_unica, c.janela_dedup_seg
                    FROM cameras c WHERE c.id = %s
                """, (cam_id,))
                _cam = _cur.fetchone()
            _conn_d.close()

            if _cam and _cam["rec_deteccao_unica"] and _cam["janela_dedup_seg"]:
                _conn_d = psycopg2.connect(db_dsn, cursor_factory=_RDC)
                with _conn_d.cursor() as _cur:
                    _cur.execute("""
                        SELECT id FROM deteccoes
                        WHERE camera_id = %s AND placa = %s
                          AND detectado_em >= NOW() - (%s || ' seconds')::INTERVAL
                        LIMIT 1
                    """, (cam_id, result.placa, _cam["janela_dedup_seg"]))
                    _dup = _cur.fetchone()
                _conn_d.close()
                if _dup:
                    import logging as _lg
                    _lg.getLogger("suricatha.watchdog").info(
                        "[SURICATHA-LOG] %s - DEDUP placa=%s cam=%d dentro de %ds — ignorado",
                        _time.strftime("%Y-%m-%d %H:%M:%S"), result.placa,
                        cam_id, _cam["janela_dedup_seg"]
                    )
                    return {"ok": True, "path": str(dest), "dedup": True,
                            "placa": result.placa, "camera_id": cam_id}

        det_id = db.insert_detection({
            "camera_id"        : cam_id,
            "placa_raw_1"      : result.placa_raw_1,
            "confianca_1"      : result.confianca_1,
            "placa_raw_2"      : result.placa_raw_2,
            "confianca_2"      : result.confianca_2,
            "placa"            : result.placa,
            "confianca_final"  : result.confianca_final,
            "validado"         : result.validado,
            "divergencia"      : result.divergencia,
            "arquivo_original" : path.name,
            "caminho_storage"  : str(dest),
            "raw_texts"        : result.raw_texts,
            "tempo_processo_ms": result.tempo_ms,
            "erro"             : result.error,
            "fonte"            : fonte,
        })

        # Atualiza atividade SFTP da câmera
        if cam_id and fonte in ("sftp_pillar", "sftp_legado"):
            db.update_camera_sftp_activity(cam_id)

        crop_url = None
        if det_id:
            from core.storage import upload_plate_crop, update_crop_url
            crop_url = upload_plate_crop(str(dest), det_id, result.placa)
            if crop_url:
                update_crop_url(det_id, crop_url, db_dsn)
            if result.placa:
                import psycopg2
                from psycopg2.extras import RealDictCursor
                conn = psycopg2.connect(db_dsn, cursor_factory=RealDictCursor)
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT d.watchlist_hit, w.tipo, w.prioridade, c.nome
                        FROM deteccoes d
                        LEFT JOIN watchlist w ON w.id = d.watchlist_id
                        LEFT JOIN cameras   c ON c.id = d.camera_id
                        WHERE d.id = %s
                    """, (det_id,))
                    row = cur.fetchone()
                conn.close()
                if row and row["watchlist_hit"]:
                    from services.alerts import AlertService, AlertEvent
                    AlertService().send(AlertEvent(
                        placa=result.placa, tipo=row["tipo"] or "suspeito",
                        prioridade=row["prioridade"] or 1,
                        camera_nome=row["nome"] or "—",
                        confianca=result.confianca_final, det_id=det_id,
                        detectado_em=_time.strftime("%Y-%m-%d %H:%M:%S"),
                        crop_url=crop_url,
                    ))

        return {"ok": True, "path": str(dest), "original": image_path,
                "placa": result.placa, "confianca": result.confianca_final,
                "validado": result.validado, "tempo_ms": result.tempo_ms,
                "det_id": det_id, "camera_id": cam_id,
                "storage": str(dest), "crop_url": crop_url}

    except Exception as exc:
        return {"ok": False, "path": image_path, "error": str(exc)}


def pessoas_worker(image_path: str, camera_id: int,
                   db_dsn: str, roi_json, limite,
                   faixa_horaria: str = "00:00-23:59") -> dict:
    """P2 — ThreadPool (YOLOv8 é thread-safe)."""
    import os as _os, sys as _sys, json as _json, time as _time
    from pathlib import Path as _P
    _os.environ["POSTGRES_DSN"] = db_dsn
    _sys.path.insert(0, "/app")

    # Verifica faixa horária antes de processar
    try:
        faixa = (faixa_horaria or "00:00-23:59").strip()
        if faixa and faixa != "00:00-23:59":
            ini_s, fim_s = faixa.split("-")
            h1, m1 = map(int, ini_s.split(":"))
            h2, m2 = map(int, fim_s.split(":"))
            import datetime as _dt
            now  = _dt.datetime.now()
            curr  = now.hour * 60 + now.minute
            start = h1 * 60 + m1
            end   = h2 * 60 + m2
            in_sched = (curr >= start and curr <= end) if start <= end else (curr >= start or curr <= end)
            if not in_sched:
                return {"ok": True, "motor": "pessoas", "skipped": True,
                        "reason": f"fora da faixa horária {faixa}"}
    except Exception:
        pass

    # Valida roi_json — deve ser JSON de coordenadas [[x,y],...], não texto livre
    validated_roi = None
    if roi_json:
        try:
            parsed = _json.loads(roi_json)
            if isinstance(parsed, list) and len(parsed) >= 3 and isinstance(parsed[0], (list, tuple)):
                validated_roi = roi_json
        except Exception:
            pass  # zona_interesse é texto descritivo, não coordenadas → ignora ROI

    try:
        from core.analytics.people_counter import PeopleCounter
        result = PeopleCounter().process_with_config(
            image_path, roi_json=validated_roi, limite=limite)

        total   = result.dados.get("total_pessoas", 0)
        alerta  = result.dados.get("alerta_lotacao", False)
        conf_m  = result.dados.get("confianca_media", 0)
        detalhes = result.dados.get("detalhes", [])

        import psycopg2
        snap_dir = _P("/app/snapshots")
        conn = psycopg2.connect(db_dsn)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO contagens_pessoas (
                    camera_id, arquivo_original, total_pessoas,
                    confianca_media, detalhes, alerta_lotacao, tempo_processo_ms
                ) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id
            """, (camera_id, _P(image_path).name,
                  total, conf_m,
                  _json.dumps(detalhes),
                  alerta, result.tempo_ms))
            row_id = cur.fetchone()[0]

            # Salva snapshot com bounding boxes anotados
            snap_path = None
            if total > 0:
                try:
                    import cv2 as _cv2, numpy as _np
                    img = _cv2.imread(image_path)
                    if img is not None:
                        for p in detalhes:
                            x1, y1, x2, y2 = p["bbox"]
                            conf_v = p.get("confianca", 0)
                            _cv2.rectangle(img, (x1, y1), (x2, y2), (0, 200, 255), 2)
                            _cv2.putText(img, f"{conf_v:.0%}", (x1, y1 - 6),
                                        _cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)
                        snap_dir.mkdir(parents=True, exist_ok=True)
                        rel_name  = f"pessoas_{row_id}.jpg"
                        snap_file = snap_dir / rel_name
                        _cv2.imwrite(str(snap_file), img, [_cv2.IMWRITE_JPEG_QUALITY, 82])
                        snap_path = rel_name
                except Exception as _se:
                    import logging as _lg
                    _lg.getLogger("suricatha.watchdog").warning("Snapshot pessoas: %s", _se)

            if snap_path:
                cur.execute("UPDATE contagens_pessoas SET snapshot_path=%s WHERE id=%s",
                            (snap_path, row_id))
            conn.commit()
        conn.close()

        if alerta:
            import logging as _lg
            _lg.getLogger("suricatha.watchdog").warning(
                "[SURICATHA-LOG] %s - ALERTA LOTAÇÃO cam_id=%d — %d pessoas (limite=%s)",
                _time.strftime("%Y-%m-%d %H:%M:%S"), camera_id, total, limite)
            try:
                from core.analytics.dispatcher import _save_alerta_lotacao
                _save_alerta_lotacao(
                    camera_id=camera_id,
                    contagem_id=row_id,
                    total=total,
                    limite=limite,
                    confianca=conf_m,
                    snapshot_path=snap_path,
                    notificado=False,
                )
            except Exception as _ae:
                _lg.getLogger("suricatha.watchdog").warning("Alerta lotacao save: %s", _ae)

        return {"ok": True, "motor": "pessoas", "id": row_id,
                "total": total, "alerta": alerta}
    except Exception as exc:
        return {"ok": False, "motor": "pessoas", "error": str(exc)}


def _annotate_epi_frame(frame, detalhes: list):
    """
    Desenha bounding boxes EPI no frame.
    Verde   = conforme (capacete + colete)
    Amarelo = parcialmente conforme (falta um item)
    Vermelho = não conforme (falta ambos)
    """
    import cv2 as _cv2
    out = frame.copy()
    for d in detalhes:
        bbox = d.get("bbox")
        if not bbox:
            continue
        x1, y1, x2, y2 = bbox
        tem_cap = d.get("tem_capacete", False)
        tem_col = d.get("tem_colete", False)

        if d.get("is_person"):
            if tem_cap and tem_col:
                color = (0, 200, 80)    # verde — conforme
                status = "OK"
            elif tem_cap or tem_col:
                color = (0, 180, 240)   # amarelo — parcial
                status = "CAP" if tem_cap else "COL"
            else:
                color = (30, 30, 220)   # vermelho — sem nenhum EPI
                status = "SEM EPI"

            falta = []
            if not tem_cap: falta.append("cap")
            if not tem_col: falta.append("col")
            label = f"{status} {d.get('confianca',0):.0%}"
            if falta:
                label += f" sem:{','.join(falta)}"

            _cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
            # Fundo semitransparente para o label
            (tw, th), _ = _cv2.getTextSize(label, _cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            _cv2.rectangle(out, (x1, max(y1 - th - 8, 0)), (x1 + tw + 4, max(y1, th + 8)), color, -1)
            _cv2.putText(out, label, (x1 + 2, max(y1 - 4, th + 4)),
                         _cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, _cv2.LINE_AA)

    return out


def epi_worker(image_path: str, camera_id: int, db_dsn: str) -> dict:
    """P3 — ThreadPool (YOLOv8 é thread-safe)."""
    import os as _os, sys as _sys, json as _json
    import cv2 as _cv2
    from pathlib import Path as _P
    _os.environ["POSTGRES_DSN"] = db_dsn
    _sys.path.insert(0, "/app")
    try:
        from core.analytics.ppe_detector import PPEDetector
        result = PPEDetector().process(image_path)
        d = result.dados
        total = d.get("total_pessoas", 0)

        # Snapshot anotado
        snap_path = None
        if total > 0:
            try:
                snap_dir = _P("/app/snapshots")
                snap_dir.mkdir(parents=True, exist_ok=True)
                frame = _cv2.imread(image_path)
                if frame is not None:
                    annotated = _annotate_epi_frame(frame, d.get("detalhes", []))
                    tmp_name  = f"epi_tmp_{camera_id}_{int(_os.path.getmtime(image_path)*1000)}.jpg"
                    tmp_path  = snap_dir / tmp_name
                    _cv2.imwrite(str(tmp_path), annotated, [_cv2.IMWRITE_JPEG_QUALITY, 90])
                    snap_path = tmp_name  # will be renamed after we get the row_id
            except Exception:
                snap_path = None

        import psycopg2
        conn = psycopg2.connect(db_dsn)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO eventos_epi (
                    camera_id, arquivo_original, caminho_storage, total_pessoas,
                    com_capacete, sem_capacete, com_colete, sem_colete,
                    conformidade, percentual_conformidade,
                    detalhes, tempo_processo_ms
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
            """, (camera_id, image_path.split("/")[-1], image_path,
                  total,
                  d.get("com_capacete",0), d.get("sem_capacete",0),
                  d.get("com_colete",0), d.get("sem_colete",0),
                  d.get("conformidade",True), d.get("percentual_conformidade",100.0),
                  _json.dumps(d.get("detalhes",[])), result.tempo_ms))
            row_id = cur.fetchone()[0]

            # Rename snapshot to canonical name and persist path
            if snap_path:
                snap_dir = _P("/app/snapshots")
                canonical = f"epi_{row_id}.jpg"
                try:
                    (snap_dir / snap_path).rename(snap_dir / canonical)
                    snap_path = canonical
                except Exception:
                    pass
                cur.execute("UPDATE eventos_epi SET snapshot_path=%s WHERE id=%s",
                            (snap_path, row_id))
            conn.commit()
        conn.close()

        if not d.get("conformidade", True):
            try:
                from core.analytics.dispatcher import _save_alerta_epi
                _save_alerta_epi(
                    camera_id=camera_id,
                    evento_epi_id=row_id,
                    total=total,
                    sem_capacete=d.get("sem_capacete", 0),
                    sem_colete=d.get("sem_colete", 0),
                    pct_conf=d.get("percentual_conformidade", 0.0),
                    snapshot_path=snap_path,
                    notificado=False,
                )
            except Exception as _ae:
                import logging as _lg
                _lg.getLogger("suricatha.watchdog").warning("Alerta EPI save: %s", _ae)

        return {"ok": True, "motor": "epi", "id": row_id,
                "conformidade": d.get("conformidade",True),
                "pct": d.get("percentual_conformidade",100)}
    except Exception as exc:
        return {"ok": False, "motor": "epi", "error": str(exc)}


# ════════════════════════════════════════════════════════════════════════════
#  CALLBACKS
# ════════════════════════════════════════════════════════════════════════════

def _on_lpr_done(result: dict, task) -> None:
    if result.get("skipped"):
        return  # race condition resolvida — arquivo já processado por outro worker
    if not result.get("ok"):
        log.error("[SURICATHA-LOG] %s - ✘ LPR %s: %s",
                  _ts(), Path(result.get("path","?")).name, result.get("error"))
        return

    log.info("[SURICATHA-LOG] %s - ✔ LPR  placa=%-9s conf=%5.1f%%  "
             "valid=%-5s  tempo=%dms  id=%s",
             _ts(), result.get("placa") or "N/D",
             (result.get("confianca") or 0)*100,
             str(result.get("validado")),
             result.get("tempo_ms",0), result.get("det_id"))

    storage  = result.get("storage","")
    cam_id   = result.get("camera_id",0)
    db_dsn   = os.getenv("POSTGRES_DSN","")
    if not storage or not cam_id:
        return

    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        conn = psycopg2.connect(db_dsn, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT rec_contagem_pessoas, rec_epi,
                       zona_interesse, limite_pessoas,
                       COALESCE(faixa_horaria, '00:00-23:59') AS faixa_horaria
                FROM cameras WHERE id=%s
            """, (cam_id,))
            cam = cur.fetchone()
        conn.close()
    except Exception:
        return

    if not cam:
        return

    from core.priority_queue import get_scheduler, Priority
    sched = get_scheduler()

    if cam.get("rec_contagem_pessoas"):
        sched.submit_analytics(
            Priority.PESSOAS, storage, cam_id,
            pessoas_worker, storage, cam_id, db_dsn,
            cam.get("zona_interesse"), cam.get("limite_pessoas"),
            cam.get("faixa_horaria", "00:00-23:59"),
            callback=_on_analytics_done,
        )

    if cam.get("rec_epi"):
        sched.submit_analytics(
            Priority.EPI, storage, cam_id,
            epi_worker, storage, cam_id, db_dsn,
            callback=_on_analytics_done,
        )


def _on_analytics_done(result: dict, task) -> None:
    motor = result.get("motor","?").upper()
    if result.get("ok"):
        if motor == "PESSOAS":
            log.info("[SURICATHA-LOG] %s - ✔ PESSOAS  total=%d  alerta=%s",
                     _ts(), result.get("total",0), result.get("alerta",False))
        else:
            log.info("[SURICATHA-LOG] %s - ✔ EPI  conform=%s  %%=%.1f",
                     _ts(), result.get("conformidade",True), result.get("pct",100))
    else:
        log.error("[SURICATHA-LOG] %s - ✘ %s: %s",
                  _ts(), motor, result.get("error"))


# ════════════════════════════════════════════════════════════════════════════
#  WATCHDOG HANDLER
# ════════════════════════════════════════════════════════════════════════════

def _is_jpeg(path: str) -> bool:
    """
    Aceita arquivos JPEG independente de extensão.
    Câmera Intelbras VIP-5460-LPR-IA envia JPEGs sem extensão.
    Verifica magic bytes FF D8 FF (SOI JPEG).
    """
    try:
        with open(path, "rb") as f:
            return f.read(3) == b"\xff\xd8\xff"
    except OSError:
        return False

def _resolve_from_path(file_path: str) -> tuple[int, str]:
    """
    Extrai (camera_id, pilar) a partir do caminho do arquivo.
    /srv/suricatha/sftp_camera/cam_001/lpr/img.jpg → (1, 'lpr')
    /srv/suricatha/sftp_camera/cam_007/epi/img.jpg → (7, 'epi')
    Retorna (0, 'lpr') se não conseguir extrair.
    """
    try:
        rel   = Path(file_path).relative_to(SFTP_ROOT)
        parts = rel.parts          # ('cam_001', 'lpr', 'img.jpg')
        cam_user = parts[0]        # 'cam_001'
        pilar    = parts[1] if len(parts) > 2 else "lpr"
        cam_id   = int(cam_user.split("_")[-1])
        return cam_id, pilar.lower()
    except Exception:
        return 0, "lpr"


class PillarHandler(FileSystemEventHandler):
    """
    Monitora SFTP_ROOT recursivo — roteia lpr/ para LPR e epi/ para EPI.

    Estratégia de detecção em tempo real:
      1. on_closed  → FileClosedEvent (IN_CLOSE_WRITE): arquivo 100% gravado pelo SFTP — gatilho principal
      2. on_moved   → FileMovedEvent: câmeras que escrevem em tmp e renomeiam
      3. on_created → fallback: arquivo já completo na criação (cópia local, rename instantâneo)
    Todos os caminhos convergem para _enqueue() que verifica magic bytes e deduplica.
    """

    def __init__(self, db_dsn: str):
        super().__init__()
        self._db_dsn = db_dsn
        self._seen   : set = set()
        self._lock   = threading.Lock()
        from core.priority_queue import get_scheduler
        self._sched = get_scheduler()

    # ── Gatilho primário: arquivo completamente gravado ───────────────────────
    def on_closed(self, event):
        if event.is_directory: return
        self._enqueue(event.src_path, delay=0)

    # ── Câmeras que escrevem em arquivo temporário e renomeiam ────────────────
    def on_moved(self, event):
        if event.is_directory: return
        self._enqueue(event.dest_path, delay=0)

    # ── Fallback: arquivo já completo na criação (ex: recovery scan manual) ──
    def on_created(self, event):
        if event.is_directory: return
        # Sem delay zero pois o arquivo pode ainda estar sendo escrito;
        # on_closed cuidará do caso SFTP normal. Aqui cobre renomes atômicos.
        self._enqueue(event.src_path, delay=UPLOAD_DELAY)

    def _enqueue(self, path: str, delay: float):
        with self._lock:
            if path in self._seen: return
            self._seen.add(path)
        threading.Thread(target=self._dispatch, args=(path, delay), daemon=True).start()

    def _dispatch(self, path: str, delay: float):
        if delay > 0:
            time.sleep(delay)
        if not _is_jpeg(path):
            with self._lock: self._seen.discard(path)
            return

        cam_id, pilar = _resolve_from_path(path)
        fname = Path(path).name
        log.info("[SURICATHA-LOG] %s - [%s] cam_id=%d  arquivo=%s",
                 _ts(), pilar.upper(), cam_id, fname)

        if pilar == "epi":
            from core.priority_queue import Priority
            ok = self._sched.submit_analytics(
                Priority.EPI, path, cam_id,
                epi_worker, path, cam_id, self._db_dsn,
                callback=_on_analytics_done,
            )
            label = "EPI"
        else:
            ok = self._sched.submit_lpr(
                path, cam_id, lpr_worker,
                path, self._db_dsn, cam_id, "sftp_pillar",
                callback=_on_lpr_done,
            )
            label = "LPR"

        if not ok:
            log.warning("[SURICATHA-LOG] %s - Fila cheia, descartado [%s]: %s",
                        _ts(), label, fname)
        with self._lock:
            self._seen.discard(path)


class LegacyHandler(FileSystemEventHandler):
    """Backward compat — monitora /home/camera_lpr/uploads/ (flat, sem pilar)."""

    def __init__(self, db_dsn: str):
        super().__init__()
        self._db_dsn = db_dsn
        self._seen   : set = set()
        self._lock   = threading.Lock()
        from core.priority_queue import get_scheduler
        self._sched = get_scheduler()

    def on_closed(self, event):
        if event.is_directory: return
        self._enqueue(event.src_path, delay=0)

    def on_moved(self, event):
        if event.is_directory: return
        self._enqueue(event.dest_path, delay=0)

    def on_created(self, event):
        if event.is_directory: return
        self._enqueue(event.src_path, delay=UPLOAD_DELAY)

    def _enqueue(self, path: str, delay: float):
        with self._lock:
            if path in self._seen: return
            self._seen.add(path)
        threading.Thread(target=self._dispatch, args=(path, delay), daemon=True).start()

    def _dispatch(self, path: str, delay: float):
        if delay > 0:
            time.sleep(delay)
        if not _is_jpeg(path):
            with self._lock: self._seen.discard(path)
            return
        log.info("[SURICATHA-LOG] %s - [LEGACY/LPR] arquivo=%s", _ts(), Path(path).name)
        ok = self._sched.submit_lpr(
            path, 0, lpr_worker,
            path, self._db_dsn, 0, "sftp_legado",
            callback=_on_lpr_done,
        )
        if not ok:
            log.warning("[SURICATHA-LOG] %s - Fila cheia, descartado [LEGACY]: %s",
                        _ts(), Path(path).name)
        with self._lock:
            self._seen.discard(path)


# ════════════════════════════════════════════════════════════════════════════
#  ENTRYPOINT
# ════════════════════════════════════════════════════════════════════════════

def main():
    setup_logging()
    for d in [SFTP_ROOT, UPLOAD_DIR, STORAGE_DIR, LOG_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    db_dsn = os.getenv("POSTGRES_DSN", "")

    log.info("[SURICATHA-LOG] %s - ═══════════════════════════════════════", _ts())
    log.info("[SURICATHA-LOG] %s - SuricathaIA Watchdog v4.0 (on-premise)", _ts())
    log.info("[SURICATHA-LOG] %s - LPR_WORKERS=%s  ANALYTICS_WORKERS=%s",
             _ts(), os.getenv("LPR_WORKERS", "2"), os.getenv("ANALYTICS_WORKERS", "2"))
    log.info("[SURICATHA-LOG] %s - ═══════════════════════════════════════", _ts())

    from core.priority_queue import get_scheduler
    scheduler = get_scheduler()

    observer = Observer()

    pillar_handler = PillarHandler(db_dsn)

    # Watcher principal — estrutura por câmera/pilar
    observer.schedule(pillar_handler, str(SFTP_ROOT), recursive=True)
    log.info("[SURICATHA-LOG] %s - LISTENING [MULTI-CAM] — %s", _ts(), SFTP_ROOT)

    # Watcher legado — câmera_lpr user antigo (backward compat)
    if UPLOAD_DIR.exists():
        observer.schedule(LegacyHandler(db_dsn), str(UPLOAD_DIR), recursive=False)
        log.info("[SURICATHA-LOG] %s - LISTENING [LEGACY]    — %s", _ts(), UPLOAD_DIR)

    observer.start()

    RECOVERY_INTERVAL_S = int(os.getenv("RECOVERY_INTERVAL_S", "300"))   # 5 min padrão
    RECOVERY_MIN_AGE_S  = int(os.getenv("RECOVERY_MIN_AGE_S",  "120"))   # só arquivos > 2 min

    def _run_scan(label: str, min_age_s: int = 0):
        """Encontra JPEGs no SFTP_ROOT e despacha os não processados.
        Usa magic bytes (FF D8 FF) pois câmeras Intelbras enviam sem extensão.
        """
        found = [
            f for f in SFTP_ROOT.rglob("*")
            if f.is_file()
            and not f.name.startswith(".")
            and _is_jpeg(str(f))
            and (time.time() - f.stat().st_mtime) >= min_age_s
        ]
        if not found:
            log.info("[SURICATHA-LOG] %s - %s: nenhum arquivo pendente", _ts(), label)
            return
        log.info("[SURICATHA-LOG] %s - %s: %d arquivo(s) encontrado(s)", _ts(), label, len(found))
        for jpg in found:
            pillar_handler._enqueue(str(jpg), delay=0)
        log.info("[SURICATHA-LOG] %s - %s: despacho concluído", _ts(), label)

    def _startup_scan():
        time.sleep(5)  # deixa o scheduler estabilizar
        _run_scan("STARTUP-SCAN", min_age_s=0)

    def _recovery_loop(stop_evt: threading.Event):
        """Scan periódico que recupera arquivos travados (fila cheia, reinicializações, etc.)."""
        # Aguarda primeiro ciclo depois do startup
        stop_evt.wait(RECOVERY_INTERVAL_S)
        while not stop_evt.is_set():
            try:
                _run_scan("RECOVERY-SCAN", min_age_s=RECOVERY_MIN_AGE_S)
            except Exception as exc:
                log.error("[SURICATHA-LOG] %s - RECOVERY-SCAN erro: %s", _ts(), exc)
            stop_evt.wait(RECOVERY_INTERVAL_S)

    stop = threading.Event()

    threading.Thread(target=_startup_scan, daemon=True, name="startup-scan").start()
    threading.Thread(target=_recovery_loop, args=(stop,), daemon=True, name="recovery-scan").start()

    def _sig(sig, _):
        log.info("[SURICATHA-LOG] %s - Encerrando...", _ts())
        stop.set()

    signal.signal(signal.SIGINT,  _sig)
    signal.signal(signal.SIGTERM, _sig)

    stop.wait()
    observer.stop()
    observer.join()
    scheduler.shutdown(wait=True)
    log.info("[SURICATHA-LOG] %s - Encerrado", _ts())


if __name__ == "__main__":
    mp.freeze_support()
    main()
