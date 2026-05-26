"""
/app/simulate.py
SuricathaIA — Simulador de uploads de câmera LPR.
Gera imagens JPG sintéticas com texto de placa e copia para UPLOAD_DIR.
"""

import argparse
import time
import os
import sys
import logging
from pathlib import Path
from datetime import datetime

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

UPLOAD_DIR  = Path(os.getenv("UPLOAD_DIR",  "/home/camera_lpr/uploads"))
POSTGRES_DSN = os.getenv("POSTGRES_DSN", "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db")

logging.basicConfig(
    level=logging.INFO,
    format="[SIMULATE] %(asctime)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger("simulate")

SAMPLE_PLATES = [
    "ABC1D23",
    "XYZ9E87",
    "DEF1234",
    "GHI5678",
]


def make_plate_image(plate: str, path: Path):
    """Gera um JPEG sintético com a placa visível via OpenCV."""
    import cv2
    import numpy as np

    img = np.ones((120, 360, 3), dtype=np.uint8) * 255
    cv2.rectangle(img, (10, 10), (350, 110), (0, 0, 180), 3)
    cv2.putText(img, plate, (40, 80),
                cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, 95])


def wait_processed(det_count_before: int, timeout: int = 120) -> bool:
    """Aguarda até que o número de detecções no banco aumente."""
    import psycopg2
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            conn = psycopg2.connect(POSTGRES_DSN)
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM deteccoes")
                n = cur.fetchone()[0]
            conn.close()
            if n > det_count_before:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def get_det_count() -> int:
    import psycopg2
    try:
        conn = psycopg2.connect(POSTGRES_DSN)
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM deteccoes")
            n = cur.fetchone()[0]
        conn.close()
        return n
    except Exception:
        return 0


def main():
    parser = argparse.ArgumentParser(description="SuricathaIA — simulador de câmera LPR")
    parser.add_argument("--count", type=int, default=1, help="Quantidade de imagens a enviar")
    parser.add_argument("--interval", type=float, default=3.0, help="Intervalo entre envios (s)")
    parser.add_argument("--no-wait", action="store_true", help="Não aguardar processamento")
    args = parser.parse_args()

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    log.info("Iniciando simulação — %d imagem(ns)", args.count)
    det_before = get_det_count()
    log.info("Detecções no banco antes: %d", det_before)

    sent = 0
    for i in range(args.count):
        plate = SAMPLE_PLATES[i % len(SAMPLE_PLATES)]
        ts    = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        fname = f"CAM01_{ts}_{plate}.jpg"
        dest  = UPLOAD_DIR / fname

        make_plate_image(plate, dest)
        log.info("[%d/%d] Enviado: %s  placa=%s", i + 1, args.count, fname, plate)
        sent += 1

        if i < args.count - 1:
            time.sleep(args.interval)

    if args.no_wait:
        log.info("Simulação concluída (%d arquivo(s) enviado(s)). Use --no-wait para não aguardar.", sent)
        return

    log.info("Aguardando pipeline processar %d imagem(ns)...", sent)
    ok = wait_processed(det_before, timeout=180)

    det_after = get_det_count()
    novas = det_after - det_before

    if ok:
        log.info("Pipeline OK — %d nova(s) detecção(ões) registrada(s)", novas)
    else:
        log.error("Timeout! Apenas %d de %d detecção(ões) registrada(s). "
                  "Verifique: journalctl -u suricathaia-watchdog -n 50", novas, sent)
        sys.exit(1)

    # Mostra resultado do banco
    import psycopg2
    from psycopg2.extras import RealDictCursor
    try:
        conn = psycopg2.connect(POSTGRES_DSN)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT id, placa, confianca_final, validado, divergencia,
                       watchlist_hit, tempo_processo_ms, detectado_em
                FROM deteccoes ORDER BY id DESC LIMIT %s
            """, (sent,))
            rows = cur.fetchall()
        conn.close()
        log.info("═══════════════════════════════════════")
        for r in rows:
            log.info("id=%-4s placa=%-8s conf=%.2f validado=%-5s wl_hit=%-5s tempo=%sms",
                     r["id"], r["placa"] or "N/D", r["confianca_final"] or 0,
                     r["validado"], r["watchlist_hit"], r["tempo_processo_ms"])
        log.info("═══════════════════════════════════════")
    except Exception as exc:
        log.warning("Não foi possível exibir resultados: %s", exc)


if __name__ == "__main__":
    main()
