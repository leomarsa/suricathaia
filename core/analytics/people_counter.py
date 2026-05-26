"""
/app/core/analytics/people_counter.py
SuricathaIA — Motor de Contagem de Pessoas
YOLOv8n CPU-only. Detecta e conta pessoas em cada frame.
Suporta ROI (zona de interesse) via polígono configurado por câmera.
"""

import os
import json
import time
import logging
import threading
from typing import Optional

import cv2
import numpy as np

from .base import AnalyticsEngine

log = logging.getLogger("suricatha.analytics.pessoas")

MODEL_PATH    = os.getenv("YOLO_PEOPLE_MODEL", "yolov8n.pt")
CONF_PESSOAS  = float(os.getenv("PEOPLE_CONF_THRESHOLD", "0.45"))
IOU_PESSOAS   = float(os.getenv("PEOPLE_IOU_THRESHOLD",  "0.45"))
YOLO_THREADS  = int(os.getenv("YOLO_CPU_THREADS", "4"))


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


class PeopleCounter(AnalyticsEngine):
    """
    Motor de contagem de pessoas via YOLOv8n.
    Singleton — modelo carregado uma única vez.
    """

    _instance = None
    _lock     = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._model  = None
                cls._instance._ready  = threading.Event()
                threading.Thread(
                    target=cls._instance._load_model,
                    daemon=True,
                    name="yolo-people-loader"
                ).start()
        return cls._instance

    @property
    def nome(self) -> str:
        return "pessoas"

    def _load_model(self):
        log.info("[SURICATHA-LOG] %s - [PESSOAS] Carregando YOLOv8n...", _ts())
        try:
            from ultralytics import YOLO
            self._model = YOLO(MODEL_PATH)
            # Força CPU e define threads
            self._model.overrides["device"] = "cpu"
            log.info("[SURICATHA-LOG] %s - [PESSOAS] Modelo pronto: %s",
                     _ts(), MODEL_PATH)
        except Exception as exc:
            log.critical("[SURICATHA-LOG] %s - [PESSOAS] Falha ao carregar: %s",
                         _ts(), exc)
        finally:
            self._ready.set()

    def wait_ready(self, timeout=120) -> bool:
        return self._ready.wait(timeout=timeout)

    def _process(self, image_path: str,
                 roi_json: Optional[str] = None,
                 limite: Optional[int]   = None) -> dict:
        """
        roi_json: JSON string com polígono [[x,y], ...] em coordenadas relativas (0-1)
        limite: número máximo de pessoas antes de disparar alerta
        """
        if not self.wait_ready(60):
            return {"_error": "Modelo não carregado"}

        img = cv2.imread(image_path)
        if img is None:
            return {"_error": f"Imagem ilegível: {image_path}"}

        h, w = img.shape[:2]

        # Máscara de ROI — só aplica se for JSON de coordenadas válido
        roi_mask = None
        if roi_json:
            try:
                pontos = json.loads(roi_json)
                if isinstance(pontos, list) and len(pontos) >= 3 and isinstance(pontos[0], (list, tuple)):
                    pts      = np.array([[int(p[0]*w), int(p[1]*h)] for p in pontos], dtype=np.int32)
                    roi_mask = np.zeros((h, w), dtype=np.uint8)
                    cv2.fillPoly(roi_mask, [pts], 255)
            except Exception:
                roi_mask = None

        # Inferência — classe 0 = person no COCO
        results = self._model(
            img,
            classes=[0],
            conf=CONF_PESSOAS,
            iou=IOU_PESSOAS,
            verbose=False,
        )

        pessoas = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                conf = float(box.conf[0])

                # Filtra por ROI se configurado
                if roi_mask is not None:
                    cx, cy = (x1+x2)//2, (y1+y2)//2
                    if roi_mask[cy, cx] == 0:
                        continue

                pessoas.append({
                    "bbox"     : [x1, y1, x2, y2],
                    "confianca": round(conf, 3),
                    "cx"       : (x1+x2)//2,
                    "cy"       : (y1+y2)//2,
                })

        total   = len(pessoas)
        conf_m  = round(sum(p["confianca"] for p in pessoas) / total, 3) if total else 0.0
        alerta  = bool(limite and limite > 0 and total >= limite)

        if alerta:
            log.warning(
                "[SURICATHA-LOG] %s - [PESSOAS] ALERTA LOTAÇÃO: %d pessoas (limite=%d) em %s",
                _ts(), total, limite, image_path.split("/")[-1]
            )

        return {
            "total_pessoas"   : total,
            "confianca_media" : conf_m,
            "alerta_lotacao"  : alerta,
            "detalhes"        : pessoas,
        }

    def process_with_config(self, image_path: str,
                            roi_json: Optional[str] = None,
                            limite: Optional[int]   = None):
        """Wrapper público que passa configuração por câmera."""
        t0 = time.perf_counter()
        from .base import AnalyticsResult
        try:
            dados = self._process(image_path, roi_json=roi_json, limite=limite)
            ms    = int((time.perf_counter() - t0) * 1000)
            error = dados.pop("_error", None)
            log.info("[SURICATHA-LOG] %s - [PESSOAS] total=%d alerta=%s tempo=%dms",
                     _ts(),
                     dados.get("total_pessoas", 0),
                     dados.get("alerta_lotacao", False),
                     ms)
            return AnalyticsResult(
                motor="pessoas", success=error is None,
                tempo_ms=ms, error=error, dados=dados
            )
        except Exception as exc:
            ms = int((time.perf_counter() - t0) * 1000)
            log.error("[SURICATHA-LOG] %s - [PESSOAS] ERRO: %s", _ts(), exc)
            from .base import AnalyticsResult
            return AnalyticsResult(motor="pessoas", success=False,
                                   tempo_ms=ms, error=str(exc))
