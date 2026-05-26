"""
/app/core/analytics/driver_monitor.py
SuricathaIA — Motor de Monitoramento de Motorista

Pipeline por frame:
  1. MediaPipe Face Mesh → detecta 468 landmarks faciais
  2. EAR (Eye Aspect Ratio) → fadiga / olhos fechados
  3. MAR (Mouth Aspect Ratio) → bocejo
  4. YOLOv8 (COCO class 67) → celular na mão / próximo ao rosto
  5. Contador de frames consecutivos → dispara alerta por limiar

Eventos gerados:
  - fadiga    : EAR < ear_threshold por ear_frames_alert frames consecutivos
  - bocejo    : MAR > mar_threshold por ≥ 2 frames consecutivos
  - celular   : detecção YOLO classe 67 com conf ≥ phone_conf
  - distracao : rosto ausente do frame por ≥ 10 frames consecutivos
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger("suricatha.analytics.driver")

# ── Config via env ─────────────────────────────────────────────────────────────
EAR_THRESHOLD    = float(os.getenv("DRIVER_EAR_THRESHOLD",    "0.25"))
MAR_THRESHOLD    = float(os.getenv("DRIVER_MAR_THRESHOLD",    "0.55"))
PHONE_CONF       = float(os.getenv("DRIVER_PHONE_CONF",       "0.55"))
EAR_FRAMES_ALERT = int(os.getenv("DRIVER_EAR_FRAMES_ALERT",   "15"))
YOLO_PHONE_CLASS = 67  # COCO: cell phone

# Índices MediaPipe Face Mesh para olho esquerdo e direito
_LEFT_EYE  = [33, 160, 158, 133, 153, 144]
_RIGHT_EYE = [362, 385, 387, 263, 373, 380]
_MOUTH     = [61, 291, 39, 269, 0, 17]


def _eye_aspect_ratio(landmarks, eye_pts: list[int], w: int, h: int) -> float:
    pts = [(int(landmarks[i].x * w), int(landmarks[i].y * h)) for i in eye_pts]
    A = np.linalg.norm(np.array(pts[1]) - np.array(pts[5]))
    B = np.linalg.norm(np.array(pts[2]) - np.array(pts[4]))
    C = np.linalg.norm(np.array(pts[0]) - np.array(pts[3]))
    return (A + B) / (2.0 * C) if C > 0 else 0.0


def _mouth_aspect_ratio(landmarks, w: int, h: int) -> float:
    pts = [(int(landmarks[i].x * w), int(landmarks[i].y * h)) for i in _MOUTH]
    A = np.linalg.norm(np.array(pts[2]) - np.array(pts[4]))
    B = np.linalg.norm(np.array(pts[3]) - np.array(pts[5]))
    C = np.linalg.norm(np.array(pts[0]) - np.array(pts[1]))
    return (A + B) / (2.0 * C) if C > 0 else 0.0


@dataclass
class DriverEvent:
    tipo:        str            # fadiga | bocejo | celular | distracao
    severidade:  str            # baixo | medio | alto | critico
    confianca:   float
    ear:         float = 0.0
    mar:         float = 0.0
    duracao_ms:  int   = 0
    frame:       Optional[np.ndarray] = field(default=None, repr=False)


class DriverMonitor:
    """
    Monitor de motorista: fadiga, bocejo, celular e distração.
    Thread-safe. Inicialização lazy de MediaPipe e YOLO.
    """

    _instance = None
    _lock      = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                inst = super().__new__(cls)
                inst._mp_ready   = False
                inst._face_mesh  = None
                inst._lock_inner = threading.Lock()
                threading.Thread(target=inst._load, daemon=True, name="driver-monitor-load").start()
                cls._instance = inst
        return cls._instance

    def _load(self):
        model_path = os.getenv(
            "FACE_LANDMARKER_MODEL",
            "/opt/suricatha/models/face_landmarker.task",
        )
        try:
            from mediapipe.tasks.python import vision as _mpvision
            from mediapipe.tasks.python.core import base_options as _bo

            opts = _mpvision.FaceLandmarkerOptions(
                base_options=_bo.BaseOptions(model_asset_path=model_path),
                running_mode=_mpvision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self._face_mesh = _mpvision.FaceLandmarker.create_from_options(opts)
            self._mp_ready  = True
            log.info("[DRIVER-MON] MediaPipe FaceLandmarker pronto (model=%s)", model_path)
        except Exception as exc:
            log.warning("[DRIVER-MON] MediaPipe não disponível: %s — só detecção de celular ativa", exc)
            self._mp_ready = False

    def wait_ready(self, timeout: int = 30) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._face_mesh is not None or not self._mp_ready and (time.time() > deadline - 2):
                return True
            time.sleep(0.3)
        return True  # fail open — YOLO phone detection ainda funciona

    def analyze(self,
                frame: np.ndarray,
                ear_threshold: float = EAR_THRESHOLD,
                mar_threshold: float = MAR_THRESHOLD,
                phone_conf: float = PHONE_CONF,
                ear_frames_alert: int = EAR_FRAMES_ALERT,
                state: Optional["DriverState"] = None,
                ) -> tuple[list[DriverEvent], "DriverState"]:
        """
        Analisa um frame. `state` mantém contadores entre frames consecutivos.
        Retorna (lista de eventos, novo state).
        """
        if state is None:
            state = DriverState()

        h, w = frame.shape[:2]
        events: list[DriverEvent] = []

        # ── 1. Face Mesh ──────────────────────────────────────────────────────
        ear, mar, face_found = 0.0, 0.0, False

        if self._mp_ready and self._face_mesh is not None:
            import mediapipe as _mp
            rgb   = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_img = _mp.Image(image_format=_mp.ImageFormat.SRGB, data=rgb)
            with self._lock_inner:
                result = self._face_mesh.detect(mp_img)

            if result.face_landmarks:
                face_found = True
                lm = result.face_landmarks[0]

                left_ear  = _eye_aspect_ratio(lm, _LEFT_EYE,  w, h)
                right_ear = _eye_aspect_ratio(lm, _RIGHT_EYE, w, h)
                ear = round((left_ear + right_ear) / 2.0, 4)
                mar = round(_mouth_aspect_ratio(lm, w, h), 4)

                state.no_face_frames = 0

                # Fadiga: olhos fechados
                if ear < ear_threshold:
                    state.low_ear_frames += 1
                    if state.low_ear_frames >= ear_frames_alert:
                        sev = "critico" if state.low_ear_frames >= ear_frames_alert * 2 else "alto"
                        events.append(DriverEvent(
                            tipo="fadiga", severidade=sev,
                            confianca=round(1.0 - ear / ear_threshold, 3),
                            ear=ear, mar=mar,
                            duracao_ms=int(state.low_ear_frames * 100),
                        ))
                        state.low_ear_frames = 0
                else:
                    state.low_ear_frames = 0

                # Bocejo: boca aberta
                if mar > mar_threshold:
                    state.high_mar_frames += 1
                    if state.high_mar_frames >= 3:
                        events.append(DriverEvent(
                            tipo="bocejo", severidade="medio",
                            confianca=round((mar - mar_threshold) / (1.0 - mar_threshold), 3),
                            ear=ear, mar=mar,
                            duracao_ms=int(state.high_mar_frames * 100),
                        ))
                        state.high_mar_frames = 0
                else:
                    state.high_mar_frames = 0

            else:
                # Rosto não detectado
                state.no_face_frames += 1
                state.low_ear_frames  = 0
                state.high_mar_frames = 0
                if state.no_face_frames >= 10:
                    events.append(DriverEvent(
                        tipo="distracao", severidade="medio",
                        confianca=0.8, ear=0.0, mar=0.0,
                        duracao_ms=int(state.no_face_frames * 100),
                    ))
                    state.no_face_frames = 0

        # ── 2. Celular (YOLO COCO class 67) ───────────────────────────────────
        try:
            from services.rtsp_people_counter import _yolo
            if _yolo._model is not None:
                results = _yolo._model.predict(
                    frame, classes=[YOLO_PHONE_CLASS],
                    conf=phone_conf, verbose=False, stream=False,
                )
                for r in results:
                    for box in r.boxes:
                        conf_val = round(float(box.conf[0]), 3)
                        events.append(DriverEvent(
                            tipo="celular", severidade="alto",
                            confianca=conf_val, ear=ear, mar=mar,
                        ))
                        break  # um por frame é suficiente
        except Exception as exc:
            log.debug("[DRIVER-MON] YOLO phone erro: %s", exc)

        # Anexa frame ao primeiro evento para snapshot
        if events and frame is not None:
            events[0].frame = frame.copy()

        return events, state


@dataclass
class DriverState:
    """Contadores de estado entre frames consecutivos."""
    low_ear_frames:  int = 0
    high_mar_frames: int = 0
    no_face_frames:  int = 0


# ── Anotação de frame ─────────────────────────────────────────────────────────

_SEV_COLOR = {
    "baixo"  : (50, 200, 50),
    "medio"  : (0, 165, 255),
    "alto"   : (0, 100, 255),
    "critico": (30, 30, 220),
}

_TIPO_ICON = {
    "fadiga"   : "FADIGA",
    "bocejo"   : "BOCEJO",
    "celular"  : "CELULAR",
    "distracao": "DISTRAÇÃO",
}


def annotate_frame(frame: np.ndarray, events: list[DriverEvent],
                   ear: float = 0.0, mar: float = 0.0) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]

    # Métricas no canto superior esquerdo
    metrics = [
        f"EAR: {ear:.3f}",
        f"MAR: {mar:.3f}",
    ]
    for i, txt in enumerate(metrics):
        cv2.putText(out, txt, (10, 25 + i * 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1, cv2.LINE_AA)

    # Alertas
    for i, ev in enumerate(events):
        color = _SEV_COLOR.get(ev.severidade, (200, 200, 200))
        label = f"  {_TIPO_ICON.get(ev.tipo, ev.tipo)}  {ev.confianca:.0%}  "
        (lw, lh), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2)
        y0 = 60 + i * (lh + 16)
        cv2.rectangle(out, (0, y0 - lh - 6), (lw + 10, y0 + 6), color, -1)
        cv2.putText(out, label, (5, y0),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)

    return out
