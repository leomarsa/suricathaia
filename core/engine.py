"""
/app/core/engine.py
SuricathaIA — Motor de Visão Computacional
Singleton PaddleOCR otimizado para CPU (MKLDNN).
Estratégia Double-Check: dois passes com pré-processamentos distintos.
"""

import os
import re
import time
import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import cv2
import numpy as np

# ── Logger padronizado ────────────────────────────────────────────────────────
log = logging.getLogger("suricatha.core.engine")


# ── Dataclasses de resultado ──────────────────────────────────────────────────
@dataclass
class OcrPass:
    placa:     Optional[str] = None
    confianca: float         = 0.0
    raw_texts: list          = field(default_factory=list)


@dataclass
class EngineResult:
    placa_raw_1:     Optional[str]
    confianca_1:     float
    placa_raw_2:     Optional[str]
    confianca_2:     float
    placa:           Optional[str]
    confianca_final: float
    validado:        bool
    divergencia:     bool
    raw_texts:       list
    tempo_ms:        int
    success:         bool
    error:           Optional[str] = None


# ── Singleton thread-safe ─────────────────────────────────────────────────────
class _Meta(type):
    _i: dict          = {}
    _l: threading.Lock = threading.Lock()
    def __call__(cls, *a, **kw):
        with cls._l:
            if cls not in cls._i:
                cls._i[cls] = super().__call__(*a, **kw)
        return cls._i[cls]


# ── Engine ────────────────────────────────────────────────────────────────────
class SuricathaEngine(metaclass=_Meta):
    """
    Motor OCR Singleton.
    Inicialização assíncrona — modelo carrega em background thread.
    Chamadas a process_image() bloqueiam até o modelo estar pronto (max 120s).
    """

    _RE_MERCOSUL = re.compile(r"[A-Z]{3}\d[A-Z]\d{2}")
    _RE_ANTIGO   = re.compile(r"[A-Z]{3}\d{4}")
    MIN_CONF     = float(os.getenv("OCR_MIN_CONFIDENCE", "0.60"))

    def __init__(self):
        self._ocr   = None
        self._ready = threading.Event()
        threading.Thread(target=self._load, daemon=True, name="ocr-loader").start()

    # ── Carregamento ──────────────────────────────────────────────────────────
    def _load(self):
        threads   = int(os.getenv("OCR_CPU_THREADS", "4"))
        mkldnn    = os.getenv("OCR_USE_MKLDNN", "true").lower() == "true"
        log.info("[SURICATHA-LOG] %s - OCR carregando  threads=%d  mkldnn=%s",
                 _ts(), threads, mkldnn)
        try:
            from paddleocr import PaddleOCR
            self._ocr = PaddleOCR(
                use_angle_cls=True,
                lang="en",
                use_gpu=False,
                enable_mkldnn=mkldnn,
                cpu_threads=threads,
                show_log=False,
            )
            log.info("[SURICATHA-LOG] %s - Motor OCR PRONTO", _ts())
        except Exception as exc:
            log.critical("[SURICATHA-LOG] %s - FALHA CRÍTICA OCR: %s", _ts(), exc)
        finally:
            self._ready.set()

    def wait_ready(self, timeout=120.0) -> bool:
        return self._ready.wait(timeout=timeout)

    # ── Pré-processamentos ────────────────────────────────────────────────────
    @staticmethod
    def _pass1_clahe(img: np.ndarray) -> np.ndarray:
        """CLAHE — boa iluminação e contraste normal."""
        h, w = img.shape[:2]
        if max(h, w) > 1920:
            s   = 1920 / max(h, w)
            img = cv2.resize(img, (int(w*s), int(h*s)), interpolation=cv2.INTER_AREA)
        gray  = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray  = clahe.apply(gray)
        gray  = cv2.fastNlMeansDenoising(gray, h=10)
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    @staticmethod
    def _pass2_sharp(img: np.ndarray) -> np.ndarray:
        """Sharpening + Adaptive Threshold — placas sujas/desfocadas."""
        h, w = img.shape[:2]
        if w < 300:
            s   = 300 / w
            img = cv2.resize(img, (int(w*s), int(h*s)), interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        k    = np.array([[-1,-1,-1],[-1,9,-1],[-1,-1,-1]])
        sh   = cv2.filter2D(gray, -1, k)
        thr  = cv2.adaptiveThreshold(sh, 255,
                   cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)
        dil  = cv2.dilate(thr, np.ones((2,2), np.uint8), iterations=1)
        return cv2.cvtColor(dil, cv2.COLOR_GRAY2BGR)

    # ── OCR ───────────────────────────────────────────────────────────────────
    def _ocr_pass(self, img: np.ndarray) -> OcrPass:
        result = OcrPass()
        raw    = self._ocr.ocr(img, cls=True)
        if not raw or not raw[0]:
            return result
        for line in raw[0]:
            txt, conf = line[1][0], float(line[1][1])
            result.raw_texts.append(txt)
            plate = self._extract(txt)
            if plate and conf > result.confianca and conf >= self.MIN_CONF:
                result.placa     = plate
                result.confianca = conf
        return result

    @classmethod
    def _extract(cls, text: str) -> Optional[str]:
        clean = re.sub(r"[^A-Z0-9]", "", text.upper())
        m = cls._RE_MERCOSUL.search(clean)
        if m: return m.group()
        m = cls._RE_ANTIGO.search(clean)
        if m: return m.group()
        return None

    # ── Double-Check ──────────────────────────────────────────────────────────
    def _consensus(self, p1: OcrPass, p2: OcrPass):
        placa = conf = None
        validado = divergencia = False
        has1, has2 = p1.placa is not None, p2.placa is not None

        if has1 and has2:
            if p1.placa == p2.placa:
                placa, conf, validado = p1.placa, p1.confianca*.6 + p2.confianca*.4, True
            else:
                divergencia = True
                placa, conf = (p1.placa, p1.confianca) if p1.confianca >= p2.confianca \
                              else (p2.placa, p2.confianca)
                log.warning("[SURICATHA-LOG] %s - DIVERGÊNCIA '%s'(%.2f) ≠ '%s'(%.2f)",
                            _ts(), p1.placa, p1.confianca, p2.placa, p2.confianca)
        elif has1:
            placa, conf = p1.placa, p1.confianca
        elif has2:
            placa, conf = p2.placa, p2.confianca

        return placa, round(float(conf or 0), 4), validado, divergencia

    # ── API pública ───────────────────────────────────────────────────────────
    def process_image(self, image_path: str) -> EngineResult:
        """Entry point. Thread-safe. Chamado por worker de multiprocessing."""
        t0 = time.perf_counter()

        if not self.wait_ready(120):
            return EngineResult(None,0,None,0,None,0,False,False,[],0,False,
                                error="Engine timeout")
        try:
            img = cv2.imread(image_path)
            if img is None:
                raise ValueError(f"Imagem ilegível: {image_path}")

            p1 = self._ocr_pass(self._pass1_clahe(img.copy()))
            p2 = self._ocr_pass(self._pass2_sharp(img.copy()))

            placa, conf, validado, div = self._consensus(p1, p2)
            raw   = list(dict.fromkeys(p1.raw_texts + p2.raw_texts))
            ms    = int((time.perf_counter() - t0) * 1000)

            log.info("[SURICATHA-LOG] %s - OCR placa=%s conf=%.2f validado=%s tempo=%dms",
                     _ts(), placa or "N/D", conf, validado, ms)

            return EngineResult(p1.placa, p1.confianca, p2.placa, p2.confianca,
                                placa, conf, validado, div, raw, ms, placa is not None)

        except Exception as exc:
            ms = int((time.perf_counter() - t0) * 1000)
            log.error("[SURICATHA-LOG] %s - ERRO engine: %s", _ts(), exc)
            return EngineResult(None,0,None,0,None,0,False,False,[],ms,False,error=str(exc))


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")
