"""
/app/core/analytics/ppe_detector.py
SuricathaIA — Motor de Detecção de EPI/PPE (dois modelos)

Pipeline por imagem:
  1. yolov8n.pt (COCO)      → detecta pessoas (class 0)
  2. yolov8n-ppe.pt          → detecta Hardhat / NO-Hardhat
  3. Associação bbox          → mapeia capacete → pessoa mais próxima
  4. Análise HSV no torso     → detecta colete de alta visibilidade
                                 (amarelo / laranja / verde-limão)

Resultado por pessoa:
  { is_person, bbox, confianca, tem_capacete, tem_colete,
    vest_color_pct, epis: [str] }
"""

import os
import time
import logging
import threading
from typing import Optional

import cv2
import numpy as np

from .base import AnalyticsEngine, AnalyticsResult

log = logging.getLogger("suricatha.analytics.epi")

# ── Configuração via env ──────────────────────────────────────────────────────
MODEL_PATH_PPE    = os.getenv("YOLO_PPE_MODEL",    "/opt/suricatha/models/yolov8n-ppe.pt")
MODEL_PATH_PERSON = os.getenv("YOLO_PEOPLE_MODEL", "/opt/suricatha/models/yolov8n.pt")

CONF_PPE    = float(os.getenv("PPE_CONF_THRESHOLD",    "0.50"))
CONF_PERSON = float(os.getenv("PPE_PERSON_CONF",       "0.50"))
IOU_PPE     = float(os.getenv("PPE_IOU_THRESHOLD",     "0.45"))

# Altura mínima da bbox da pessoa em pixels para análise EPI
# Pessoas muito distantes/pequenas não têm resolução suficiente para avaliar EPI
PPE_MIN_PERSON_H = int(os.getenv("PPE_MIN_PERSON_H", "80"))

# Limiar de cobertura de cor no torso para aceitar colete (0–1)
VEST_COLOR_THRESH = float(os.getenv("PPE_VEST_COLOR_THRESH", "0.12"))

# Classes do modelo PPE
_EPI_CLASS_HELMET    = {"hardhat", "helmet", "hard-hat"}
_EPI_CLASS_NO_HELMET = {"no-hardhat", "no-helmet", "no_hardhat", "no_helmet"}


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ── Análise de cor de colete ──────────────────────────────────────────────────

def _check_vest_color(img_hsv: np.ndarray, bbox: list,
                      threshold: float = VEST_COLOR_THRESH) -> tuple[bool, float]:
    """
    Analisa região do torso em HSV buscando cores de alta visibilidade (OpenCV H=0-180):
      - Amarelo fluorescente  H=[10,35],  S>=80,  V>=80
      - Laranjado / laranja   H=[3,20],   S>=100, V>=80
      - Verde florescente     H=[35,80],  S>=100, V>=80
      - Faixa refletiva prata S<50,       V>160
      - Refletivo branco      S<25,       V>185

    Retorna (vest_detected, coverage_pct).
    """
    x1, y1, x2, y2 = bbox
    pw, ph = x2 - x1, y2 - y1
    if pw <= 0 or ph <= 0:
        return False, 0.0

    # Torso: 28–72% da altura, 10–90% da largura da bbox da pessoa
    ty1 = y1 + int(ph * 0.28)
    ty2 = y1 + int(ph * 0.72)
    tx1 = x1 + int(pw * 0.10)
    tx2 = x2 - int(pw * 0.10)

    # Garante bounds dentro da imagem
    h_img, w_img = img_hsv.shape[:2]
    ty1 = max(0, ty1); ty2 = min(h_img, ty2)
    tx1 = max(0, tx1); tx2 = min(w_img, tx2)

    if ty2 <= ty1 or tx2 <= tx1:
        return False, 0.0

    torso = img_hsv[ty1:ty2, tx1:tx2]
    total = torso.shape[0] * torso.shape[1]
    if total == 0:
        return False, 0.0

    H = torso[:, :, 0]
    S = torso[:, :, 1]
    V = torso[:, :, 2]

    mask = (
        # Amarelo fluorescente
        ((H >= 10) & (H <= 35) & (S >= 80) & (V >= 80)) |
        # Laranjado / laranja fluorescente (inclui laranja-avermelhado)
        ((H >= 3) & (H <= 20) & (S >= 100) & (V >= 80)) |
        # Verde florescente / lima
        ((H >= 35) & (H <= 80) & (S >= 100) & (V >= 80)) |
        # Faixa refletiva prata/cinza brilhante
        ((S < 50) & (V > 160)) |
        # Faixa refletiva branco puro
        ((S < 25) & (V > 185))
    )

    coverage = float(mask.sum()) / total
    return coverage >= threshold, round(coverage * 100, 1)


# ── Sobreposição bbox ─────────────────────────────────────────────────────────

def _iou_fraction(box_a: list, box_b: list) -> float:
    """Fração de sobreposição de box_b sobre box_a (IoA — intersection over A)."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b

    ix1 = max(ax1, bx1); iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2); iy2 = min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0

    inter  = (ix2 - ix1) * (iy2 - iy1)
    area_b = max((bx2 - bx1) * (by2 - by1), 1)
    return inter / area_b


# ── Detector ──────────────────────────────────────────────────────────────────

class PPEDetector(AnalyticsEngine):
    """
    Motor de detecção de EPI via dois modelos YOLOv8 + análise de cor HSV.
    Singleton — modelos carregados uma única vez.
    """

    _instance = None
    _lock     = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                inst = super().__new__(cls)
                inst._model        = None   # helmet model
                inst._person_model = None   # COCO person model
                inst._ready        = threading.Event()
                inst._lock_inner   = threading.Lock()
                threading.Thread(
                    target=inst._load_model,
                    daemon=True,
                    name="yolo-ppe-loader",
                ).start()
                cls._instance = inst
        return cls._instance

    @property
    def nome(self) -> str:
        return "epi"

    def _load_model(self):
        log.info("[SURICATHA-LOG] %s - [EPI] Carregando modelos: %s + %s",
                 _ts(), MODEL_PATH_PPE, MODEL_PATH_PERSON)
        for attempt in range(3):
            try:
                from ultralytics import YOLO
                self._model        = YOLO(MODEL_PATH_PPE)
                self._model.overrides["device"] = "cpu"

                self._person_model = YOLO(MODEL_PATH_PERSON)
                self._person_model.overrides["device"] = "cpu"

                names = self._model.names
                log.info("[SURICATHA-LOG] %s - [EPI] Modelos prontos. Classes PPE: %s",
                         _ts(), names)
                break
            except Exception as exc:
                log.warning("[SURICATHA-LOG] %s - [EPI] Tentativa %d falhou: %s",
                            _ts(), attempt + 1, exc)
                if attempt < 2:
                    time.sleep(3 + attempt * 2)
        else:
            log.critical("[SURICATHA-LOG] %s - [EPI] Falha definitiva ao carregar modelos", _ts())
        self._ready.set()

    def wait_ready(self, timeout: int = 120) -> bool:
        return self._ready.wait(timeout=timeout)

    # ── Core ─────────────────────────────────────────────────────────────────

    def process_frame(self, img: np.ndarray) -> "AnalyticsResult":
        """Entry point para frame já em memória (sem disco)."""
        import time as _t
        t0 = _t.perf_counter()
        dados = self._run(img)
        ms = int((_t.perf_counter() - t0) * 1000)
        err = dados.pop("_error", None)
        return AnalyticsResult(motor=self.nome, success=err is None,
                               tempo_ms=ms, error=err, dados=dados)

    def _process(self, image_path: str) -> dict:
        if not self.wait_ready(60):
            return {"_error": "Modelos EPI não carregados"}

        img = cv2.imread(image_path)
        if img is None:
            return {"_error": f"Imagem ilegível: {image_path}"}

        return self._run(img)

    def _run(self, img: np.ndarray) -> dict:
        img_hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

        # ── 1. Detecta pessoas ───────────────────────────────────────────────
        persons = self._detect_persons(img)

        # ── 2. Detecta capacetes ─────────────────────────────────────────────
        helmets = self._detect_helmets(img)

        # ── 3. Associa e verifica colete por cor ────────────────────────────
        result_pessoas = []
        for p in persons:
            tem_cap, cap_conf = self._associate_helmet(p["bbox"], helmets)
            tem_col, vest_pct = _check_vest_color(img_hsv, p["bbox"])

            epis = []
            if tem_cap:
                epis.append("helmet")
            if tem_col:
                epis.append("vest")

            result_pessoas.append({
                "is_person"      : True,
                "bbox"           : p["bbox"],
                "confianca"      : p["confianca"],
                "tem_capacete"   : tem_cap,
                "tem_colete"     : tem_col,
                "vest_color_pct" : vest_pct,
                "epis"           : epis,
            })

        # ── 4. Fallback: sem pessoas mas com capacetes detectados ────────────
        if not persons and helmets:
            n_helm    = sum(1 for h in helmets if h["classe"] in _EPI_CLASS_HELMET)
            n_no_helm = sum(1 for h in helmets if h["classe"] in _EPI_CLASS_NO_HELMET)
            total_fb  = max(n_helm + n_no_helm, 1)
            result_pessoas.append({
                "is_person"    : False,
                "bbox"         : None,
                "confianca"    : 0.0,
                "tem_capacete" : n_helm > 0,
                "tem_colete"   : False,
                "vest_color_pct": 0.0,
                "epis"         : [h["classe"] for h in helmets],
            })

        # ── 5. Agrega métricas ───────────────────────────────────────────────
        total_pessoas = len([p for p in result_pessoas if p["is_person"]])
        com_cap  = sum(1 for p in result_pessoas if p["is_person"] and p["tem_capacete"])
        sem_cap  = sum(1 for p in result_pessoas if p["is_person"] and not p["tem_capacete"])
        com_col  = sum(1 for p in result_pessoas if p["is_person"] and p["tem_colete"])
        sem_col  = sum(1 for p in result_pessoas if p["is_person"] and not p["tem_colete"])
        conformes = sum(1 for p in result_pessoas
                        if p["is_person"] and p["tem_capacete"] and p["tem_colete"])

        conformidade = (conformes == total_pessoas) if total_pessoas > 0 else True
        pct_conf     = round((conformes / total_pessoas * 100) if total_pessoas > 0 else 100.0, 1)

        if not conformidade:
            log.warning(
                "[SURICATHA-LOG] %s - [EPI] VIOLAÇÃO: sem_cap=%d sem_col=%d",
                _ts(), sem_cap, sem_col,
            )

        return {
            "total_pessoas"          : total_pessoas,
            "com_capacete"           : com_cap,
            "sem_capacete"           : sem_cap,
            "com_colete"             : com_col,
            "sem_colete"             : sem_col,
            "conformidade"           : conformidade,
            "percentual_conformidade": pct_conf,
            "detalhes"               : result_pessoas,
        }

    # ── Modelos internos ─────────────────────────────────────────────────────

    def _detect_persons(self, img: np.ndarray) -> list[dict]:
        """Detecta pessoas via modelo COCO (class 0 = person)."""
        if self._person_model is None:
            return []
        with self._lock_inner:
            results = self._person_model(
                img,
                classes=[0],
                conf=CONF_PERSON,
                iou=IOU_PPE,
                verbose=False,
            )
        out = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                # Descarta pessoas muito pequenas — resolução insuficiente para EPI
                if (y2 - y1) < PPE_MIN_PERSON_H:
                    continue
                out.append({
                    "bbox"    : [x1, y1, x2, y2],
                    "confianca": round(float(box.conf[0]), 3),
                })
        return out

    def _detect_helmets(self, img: np.ndarray) -> list[dict]:
        """Detecta capacetes via modelo PPE."""
        if self._model is None:
            return []
        with self._lock_inner:
            results = self._model(img, conf=CONF_PPE, iou=IOU_PPE, verbose=False)
        names = self._model.names
        out = []
        for r in results:
            for box in r.boxes:
                cls_id   = int(box.cls[0])
                cls_name = names.get(cls_id, f"class_{cls_id}").lower().strip()
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                out.append({
                    "classe"   : cls_name,
                    "confianca": round(float(box.conf[0]), 3),
                    "bbox"     : [x1, y1, x2, y2],
                    "_matched" : False,
                })
        return out

    @staticmethod
    def _associate_helmet(person_bbox: list,
                          helmets: list[dict]) -> tuple[bool, float]:
        """
        Verifica se algum capacete se sobrepõe suficientemente à bbox da pessoa.
        Considera apenas a metade superior da pessoa (região da cabeça/ombros).
        """
        px1, py1, px2, py2 = person_bbox
        ph = py2 - py1
        # Região da cabeça: 0–40% da altura da pessoa
        head_box = [px1, py1, px2, py1 + int(ph * 0.45)]

        best_conf = 0.0
        for h in helmets:
            if h["classe"] in _EPI_CLASS_NO_HELMET:
                continue
            overlap = _iou_fraction(head_box, h["bbox"])
            if overlap > 0.35:
                best_conf = max(best_conf, h["confianca"])

        # Verifica também se existe "no-helmet" associado (para confirmar presença sem EPI)
        has_helmet = best_conf > 0

        # Se nenhum "hardhat" mapeado → checa se "no-helmet" cobre a cabeça
        # (isso indica que o modelo reconheceu uma pessoa sem capacete nessa posição)
        return has_helmet, best_conf
