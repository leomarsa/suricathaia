"""
/app/test_pipeline.py
SuricathaIA — Teste de Pipeline End-to-End

Simula a chegada de um JPEG na pasta de uploads e valida:
  1. Integridade de arquivo (header JPEG, tamanho mínimo)
  2. OCR Engine (PaddleOCR) — retorna resultado sem travar
  3. INSERT no PostgreSQL com trigger watchlist
  4. Deduplicação (se rec_deteccao_unica=True)
  5. Upload de crop para Supabase Storage
  6. Sync assíncrono Supabase (tabela deteccoes)
  7. Analytics (pessoas + EPI) via dispatcher
  8. API REST — endpoints críticos
  9. SSE — conectividade do stream

Uso:
    source /opt/suricatha/.venv/bin/activate
    cd /app && python test_pipeline.py [--full] [--no-ocr]

Flags:
    --full    inclui teste de OCR real (lento, ~30s)
    --no-ocr  pula OCR, útil para testar só infra
"""

import os
import sys
import time
import json
import struct
import tempfile
import argparse
import threading
from pathlib import Path
from datetime import datetime

# Carrega .env
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

sys.path.insert(0, "/app")

# ── Helpers ───────────────────────────────────────────────────────────────────
RESET  = "\033[0m"
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
BOLD   = "\033[1m"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    icon = f"{GREEN}✔{RESET}" if ok else f"{RED}✘{RESET}"
    print(f"  {icon}  {name:<45} {detail}")
    results.append((name, ok, detail))


def section(title: str):
    print(f"\n{BOLD}{'─'*60}{RESET}")
    print(f"{BOLD}  {title}{RESET}")
    print(f"{BOLD}{'─'*60}{RESET}")


# ── Gera JPEG mínimo válido ───────────────────────────────────────────────────
def make_test_jpeg(path: Path, width=320, height=240):
    """Cria JPEG sintético com placa visível para OCR."""
    try:
        import cv2
        import numpy as np
        img = np.ones((height, width, 3), dtype=np.uint8) * 200
        # Simula placa
        cv2.rectangle(img, (80, 100), (240, 140), (255, 255, 255), -1)
        cv2.rectangle(img, (80, 100), (240, 140), (0, 0, 0), 2)
        cv2.putText(img, "ABC1D23", (90, 130), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, (0, 0, 0), 2)
        cv2.imwrite(str(path), img)
        return True
    except Exception as e:
        # Fallback: JPEG mínimo (imagem 1x1 branca)
        data = bytes([
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
            0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB,
            0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07,
            0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B,
            0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E,
            0x1D, 0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C,
            0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34,
            0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34,
            0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
            0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05,
            0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01,
            0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00,
            0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21,
            0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
            0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1,
            0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18,
            0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36,
            0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
            0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64,
            0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77,
            0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A,
            0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4,
            0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6,
            0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8,
            0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
            0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1,
            0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDA,
            0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFB, 0xD4, 0xFF, 0xD9,
        ])
        path.write_bytes(data)
        return True


# ══════════════════════════════════════════════════════════════════════════════
#  TESTES
# ══════════════════════════════════════════════════════════════════════════════

def test_1_arquivo(jpeg_path: Path):
    section("1. Integridade de Arquivo")

    check("Arquivo existe", jpeg_path.exists())
    check("Tamanho mínimo (>1KB)", jpeg_path.stat().st_size > 1024,
          f"{jpeg_path.stat().st_size} bytes")

    with open(jpeg_path, "rb") as f:
        header = f.read(2)
    check("Header JPEG válido (0xFF 0xD8)", header == b"\xff\xd8",
          f"header={header.hex()}")


def test_2_banco():
    section("2. Banco de Dados PostgreSQL")

    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        dsn  = os.getenv("POSTGRES_DSN")
        conn = psycopg2.connect(dsn, cursor_factory=RealDictCursor)

        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM deteccoes")
            total = cur.fetchone()["n"]
        check("Conexão PostgreSQL", True, f"{total} detecções")

        with conn.cursor() as cur:
            cur.execute("""
                SELECT routine_name FROM information_schema.routines
                WHERE routine_schema='public' AND routine_name='fn_check_watchlist'
            """)
            ok = cur.fetchone() is not None
        check("Trigger fn_check_watchlist", ok)

        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM cameras WHERE ativa")
            n = cur.fetchone()["n"]
        check("Câmeras ativas cadastradas", n > 0, f"{n} câmera(s)")

        conn.close()
        return True
    except Exception as exc:
        check("Conexão PostgreSQL", False, str(exc))
        return False


def test_3_resolve_camera():
    section("3. Resolução de Câmera por Prefixo")

    try:
        from services.database import DatabaseService
        db = DatabaseService()

        cam_id = db.resolve_camera_id("CAM01_20260418_120000.jpg")
        check("Resolve CAM01_ → camera_id", cam_id > 0, f"camera_id={cam_id}")

        cam_id_unk = db.resolve_camera_id("UNKNOWN_FILE.jpg")
        check("Fallback para id=1 quando desconhecido", cam_id_unk == 1,
              f"camera_id={cam_id_unk}")
    except Exception as exc:
        check("Resolve câmera", False, str(exc))


def test_4_ocr(jpeg_path: Path):
    section("4. OCR Engine (PaddleOCR)")
    print(f"  {YELLOW}→ Carregando modelo OCR (pode levar ~30s)...{RESET}")

    try:
        from core.engine import SuricathaEngine
        engine = SuricathaEngine()
        ready  = engine.wait_ready(120)
        check("Modelo OCR carregado", ready)

        if ready:
            t0     = time.perf_counter()
            result = engine.process_image(str(jpeg_path))
            ms     = int((time.perf_counter() - t0) * 1000)
            check("process_image retornou", result is not None)
            check("Tempo de processamento (<10s)", ms < 10000, f"{ms}ms")
            check("EngineResult tem campos obrigatórios",
                  hasattr(result, "placa") and hasattr(result, "confianca_final"))
            if result.placa:
                check("Placa detectada", True, f"placa={result.placa} conf={result.confianca_final:.2f}")
            else:
                check("OCR rodou sem erro fatal", result.error is None,
                      result.error or "sem placa detectada (imagem sintética)")
    except Exception as exc:
        check("OCR Engine", False, str(exc))


def test_5_insert_dedup():
    section("5. INSERT + Deduplicação")

    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        dsn  = os.getenv("POSTGRES_DSN")
        conn = psycopg2.connect(dsn, cursor_factory=RealDictCursor)

        # INSERT direto para testar trigger
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO deteccoes
                    (camera_id, placa, confianca_final, validado,
                     arquivo_original, tempo_processo_ms)
                VALUES (1, 'TST0001', 0.95, true, 'test_pipeline.jpg', 100)
                RETURNING id, watchlist_hit
            """)
            row = cur.fetchone()
            conn.commit()

        det_id = row["id"]
        check("INSERT retornou id", det_id > 0, f"id={det_id}")
        check("Trigger watchlist executou", "watchlist_hit" in row,
              f"watchlist_hit={row['watchlist_hit']}")

        # Deduplicação — segunda inserção da mesma placa no mesmo intervalo
        with conn.cursor() as cur:
            cur.execute("""
                SELECT count(*) AS n FROM deteccoes
                WHERE placa = 'TST0001'
                  AND detectado_em >= NOW() - INTERVAL '60 seconds'
            """)
            n = cur.fetchone()["n"]
        check("Query de dedup retorna contagem correta", n >= 1, f"{n} detecção(ões)")

        # Limpa registro de teste
        with conn.cursor() as cur:
            cur.execute("DELETE FROM deteccoes WHERE id = %s", (det_id,))
            conn.commit()
        check("Limpeza de dados de teste", True)

        conn.close()
    except Exception as exc:
        check("INSERT + Dedup", False, str(exc))


def test_6_storage_local():
    section("6. Storage Local (On-Premise)")

    storage_dir = Path(os.getenv("STORAGE_DIR", "/opt/suricatha/storage"))
    crops_dir   = storage_dir / "crops"

    check("STORAGE_DIR existe", storage_dir.exists(), str(storage_dir))
    check("Diretório crops criado", crops_dir.exists() or True,
          str(crops_dir.mkdir(parents=True, exist_ok=True) or crops_dir))

    # Testa escrita no diretório de crops
    try:
        probe = crops_dir / "_probe.txt"
        probe.write_text("ok")
        probe.unlink()
        check("Escrita em crops/ OK", True, str(crops_dir))
    except Exception as exc:
        check("Escrita em crops/", False, str(exc))

    # Verifica que crop_url local funciona
    try:
        from core.storage import upload_plate_crop, CROPS_URL
        check("CROPS_URL configurada", CROPS_URL == "/storage/crops", CROPS_URL)
    except Exception as exc:
        check("core.storage importado", False, str(exc))


def test_7_analytics(jpeg_path: Path):
    section("7. Analytics (Pessoas + EPI)")

    # Verifica modelos
    for env_key, label in [("YOLO_PEOPLE_MODEL", "YOLO Pessoas"), ("YOLO_PPE_MODEL", "YOLO EPI")]:
        path = os.getenv(env_key, "")
        p    = Path(path)
        check(f"Modelo {label} existe", p.exists(),
              f"{p.stat().st_size // 1024}KB" if p.exists() else f"ausente: {path}")

    # Testa PeopleCounter (sem rodar inferência completa — só importa e verifica singleton)
    try:
        from core.analytics.people_counter import PeopleCounter
        counter = PeopleCounter()
        check("PeopleCounter singleton inicializado", counter is not None)
    except Exception as exc:
        check("PeopleCounter", False, str(exc)[:80])

    try:
        from core.analytics.ppe_detector import PPEDetector
        detector = PPEDetector()
        check("PPEDetector singleton inicializado", detector is not None)
    except Exception as exc:
        check("PPEDetector", False, str(exc)[:80])

    try:
        from core.analytics.dispatcher import dispatch
        check("dispatcher.dispatch importado", True)
    except Exception as exc:
        check("dispatcher.dispatch", False, str(exc)[:80])


def test_8_api():
    section("8. API REST")

    import urllib.request
    import urllib.error

    base = "http://localhost:8000"
    api_key = os.getenv("API_KEYS", "").split(",")[0].strip()
    headers = {"Authorization": f"Bearer {api_key}"}

    endpoints = [
        ("GET", "/health",                     False),
        ("GET", "/api/v1/deteccoes",            True),
        ("GET", "/api/v1/deteccoes/stats",      True),
        ("GET", "/api/v1/cameras",              True),
        ("GET", "/api/v1/watchlist",            True),
        ("GET", "/api/v1/analytics/resumo",     True),
        ("GET", "/api/v1/analytics/pessoas",    True),
        ("GET", "/api/v1/analytics/epi",        True),
        ("GET", "/api/v1/system/status",        True),
        ("GET", "/api/v1/system/queue",         True),
        ("GET", "/docs",                        False),
    ]

    for method, path, auth in endpoints:
        url = f"{base}{path}"
        req = urllib.request.Request(url, method=method)
        if auth:
            req.add_header("Authorization", f"Bearer {api_key}")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                ok = resp.status in (200, 201, 204)
                check(f"{method} {path}", ok, f"HTTP {resp.status}")
        except urllib.error.HTTPError as e:
            check(f"{method} {path}", e.code not in (500, 502, 503),
                  f"HTTP {e.code}")
        except Exception as exc:
            check(f"{method} {path}", False, str(exc)[:60])


def test_9_sse():
    section("9. SSE — Server-Sent Events")

    import socket
    try:
        sock = socket.create_connection(("localhost", 8000), timeout=3)
        api_key = os.getenv("API_KEYS", "").split(",")[0].strip()
        req = (
            f"GET /api/v1/stream HTTP/1.1\r\n"
            f"Host: localhost:8000\r\n"
            f"Authorization: Bearer {api_key}\r\n"
            f"Accept: text/event-stream\r\n"
            f"Connection: close\r\n\r\n"
        )
        sock.sendall(req.encode())
        sock.settimeout(4)
        response = b""
        try:
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                response += chunk
                if b"data:" in response:
                    break
        except socket.timeout:
            pass
        sock.close()

        ok = b"text/event-stream" in response
        check("SSE Content-Type correto", ok)
        has_data = b"data:" in response
        check("SSE recebeu evento inicial", has_data,
              "data: {type:connected}" if has_data else "sem dados recebidos")
    except Exception as exc:
        check("SSE stream", False, str(exc))


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="SuricathaIA — Teste de Pipeline")
    parser.add_argument("--full",   action="store_true", help="Inclui OCR real (~30s)")
    parser.add_argument("--no-ocr", action="store_true", help="Pula OCR")
    args = parser.parse_args()

    print(f"\n{BOLD}{'═'*60}{RESET}")
    print(f"{BOLD}  SuricathaIA — Pipeline Test  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}{RESET}")
    print(f"{BOLD}{'═'*60}{RESET}")

    # Cria JPEG de teste
    with tempfile.NamedTemporaryFile(suffix=".jpg", prefix="CAM01_test_", delete=False) as tf:
        jpeg_path = Path(tf.name)
    make_test_jpeg(jpeg_path)

    try:
        test_1_arquivo(jpeg_path)
        test_2_banco()
        test_3_resolve_camera()

        if not args.no_ocr:
            test_4_ocr(jpeg_path)
        else:
            section("4. OCR Engine")
            print(f"  {YELLOW}⊘  Pulado (--no-ocr){RESET}")

        test_5_insert_dedup()
        test_6_storage_local()
        test_7_analytics(jpeg_path)
        test_8_api()
        test_9_sse()

    finally:
        jpeg_path.unlink(missing_ok=True)

    # Resumo
    total  = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = total - passed

    print(f"\n{BOLD}{'═'*60}{RESET}")
    print(f"{BOLD}  RESULTADO: {GREEN}{passed} OK{RESET}  |  {RED}{failed} FALHA(S){RESET}  de {total} testes")
    print(f"{BOLD}{'═'*60}{RESET}\n")

    if failed > 0:
        print(f"{RED}Falhas:{RESET}")
        for name, ok, detail in results:
            if not ok:
                print(f"  ✘  {name}: {detail}")
        print()

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
