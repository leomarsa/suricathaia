"""
/app/core/storage.py
SuricathaIA — Storage local on-premise.
Recorta a região da placa e salva em /opt/suricatha/storage/crops/.
Retorna URL relativa servida pelo Nginx em /storage/crops/.
"""

import os
import time
import logging
from pathlib import Path
from typing import Optional

import cv2

log = logging.getLogger("suricatha.storage")

CROPS_DIR = Path(os.getenv("STORAGE_DIR", "/opt/suricatha/storage")) / "crops"
CROPS_URL = "/storage/crops"  # URL pública via Nginx


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _crop_plate_region(image_path: str) -> Optional[bytes]:
    """
    Detecta e recorta a região da placa por contornos.
    Fallback: imagem completa redimensionada para 640px.
    Retorna bytes JPEG.
    """
    img = cv2.imread(image_path)
    if img is None:
        return None

    h, w = img.shape[:2]
    crop = img  # fallback

    try:
        gray  = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        blur  = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blur, 50, 150)
        contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

        best, best_area = None, 0
        for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:20]:
            x, y, cw, ch = cv2.boundingRect(cnt)
            area  = cw * ch
            ratio = cw / ch if ch > 0 else 0
            if 2.5 < ratio < 6.0 and 3000 < area < (w * h * 0.4):
                if area > best_area:
                    best, best_area = (x, y, cw, ch), area

        if best:
            x, y, cw, ch = best
            x1, y1 = max(0, x - 10), max(0, y - 10)
            x2, y2 = min(w, x + cw + 10), min(h, y + ch + 10)
            crop = img[y1:y2, x1:x2]

    except Exception as exc:
        log.warning("[SURICATHA-LOG] %s - Crop falhou, usando imagem completa: %s", _ts(), exc)

    ch, cw = crop.shape[:2]
    if cw > 640:
        scale = 640 / cw
        crop  = cv2.resize(crop, (640, int(ch * scale)), interpolation=cv2.INTER_AREA)

    _, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return buf.tobytes()


def upload_plate_crop(image_path: str, det_id: int,
                      placa: Optional[str]) -> Optional[str]:
    """
    Salva o crop da placa localmente.
    Retorna a URL pública relativa (/storage/crops/...) ou None se falhar.
    """
    crop_bytes = _crop_plate_region(image_path)
    if crop_bytes is None:
        log.warning("[SURICATHA-LOG] %s - Crop retornou None para %s", _ts(), image_path)
        return None

    date_str  = time.strftime("%Y-%m-%d")
    placa_tag = (placa or "ND").replace(" ", "")
    file_name = f"{det_id:08d}_{placa_tag}.jpg"

    dest_dir = CROPS_DIR / date_str
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / file_name

    try:
        dest_path.write_bytes(crop_bytes)
        public_url = f"{CROPS_URL}/{date_str}/{file_name}"
        log.info("[SURICATHA-LOG] %s - Crop salvo → %s", _ts(), dest_path)
        return public_url
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Falha ao salvar crop det_id=%d: %s", _ts(), det_id, exc)
        return None


def update_crop_url(det_id: int, crop_url: str, pg_dsn: str) -> None:
    """Salva a URL do crop local no campo crop_url da tabela deteccoes."""
    try:
        import psycopg2
        conn = psycopg2.connect(pg_dsn)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE deteccoes SET crop_url = %s WHERE id = %s",
                (crop_url, det_id)
            )
            conn.commit()
        conn.close()
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - update_crop_url falhou: %s", _ts(), exc)
