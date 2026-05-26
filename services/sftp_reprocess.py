"""
/app/services/sftp_reprocess.py
SuricathaIA — Reprocessamento de Imagens SFTP

Varre os diretórios SFTP de todas as câmeras e submete ao pipeline
os arquivos JPEG que ainda não foram processados pelo watchdog.

Uso:
    python sftp_reprocess.py                      # processa tudo
    python sftp_reprocess.py --dry-run            # só lista, não processa
    python sftp_reprocess.py --cam cam_001        # só uma câmera
    python sftp_reprocess.py --pilar lpr          # só pilar lpr ou epi
    python sftp_reprocess.py --workers 4          # paralelismo

Também pode ser importado:
    from services.sftp_reprocess import reprocess_sftp
    resultado = reprocess_sftp(dry_run=True)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent))

SFTP_ROOT   = Path(os.getenv("SFTP_ROOT",   "/srv/suricatha/sftp_camera"))
DB_DSN      = os.getenv("POSTGRES_DSN",     "")
LPR_WORKERS = int(os.getenv("LPR_WORKERS",  "2"))

log = logging.getLogger("suricatha.reprocess")
logging.basicConfig(
    level=logging.INFO,
    format="[REPROCESS] %(asctime)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)


# ── Tipos ─────────────────────────────────────────────────────────────────────

@dataclass
class FileEntry:
    path: Path
    cam_id: int
    cam_user: str
    pilar: str      # 'lpr' | 'epi'


@dataclass
class ReprocessResult:
    total:     int = 0
    lpr_ok:    int = 0
    lpr_err:   int = 0
    epi_ok:    int = 0
    epi_err:   int = 0
    skipped:   int = 0
    dry_run:   bool = False
    erros:     list[str] = field(default_factory=list)
    placas:    list[str] = field(default_factory=list)

    @property
    def ok(self) -> int:
        return self.lpr_ok + self.epi_ok

    @property
    def errors(self) -> int:
        return self.lpr_err + self.epi_err

    def summary(self) -> str:
        lines = [
            "━" * 52,
            f"  REPROCESSAMENTO {'(dry-run)' if self.dry_run else 'COMPLETO'}",
            "━" * 52,
            f"  Arquivos encontrados : {self.total}",
            f"  Processados OK       : {self.ok}",
            f"  Erros                : {self.errors}",
            f"  Ignorados (não JPEG) : {self.skipped}",
            f"  LPR ok={self.lpr_ok} err={self.lpr_err}",
            f"  EPI ok={self.epi_ok} err={self.epi_err}",
        ]
        if self.placas:
            lines.append(f"  Placas lidas         : {', '.join(self.placas[:20])}"
                         + (" ..." if len(self.placas) > 20 else ""))
        if self.erros:
            lines.append("  Erros detalhados:")
            for e in self.erros[:10]:
                lines.append(f"    • {e}")
        lines.append("━" * 52)
        return "\n".join(lines)


# ── Utilitários ────────────────────────────────────────────────────────────────

def _is_jpeg(path: Path) -> bool:
    """Detecta JPEG por magic bytes — ignora extensão (Intelbras envia sem .jpg)."""
    try:
        with open(path, "rb") as f:
            return f.read(3) == b"\xff\xd8\xff"
    except OSError:
        return False


def _scan(
    sftp_root: Path,
    cam_filter: str | None,
    pilar_filter: str | None,
) -> list[FileEntry]:
    """
    Varre sftp_root buscando arquivos JPEG em cam_NNN/{lpr,epi}/.
    Retorna lista de FileEntry, um por arquivo válido.
    """
    entries: list[FileEntry] = []

    for cam_dir in sorted(sftp_root.iterdir()):
        if not cam_dir.is_dir():
            continue
        if cam_filter and cam_dir.name != cam_filter:
            continue

        try:
            cam_id = int(cam_dir.name.split("_")[-1])
        except ValueError:
            continue

        for pilar_dir in cam_dir.iterdir():
            pilar = pilar_dir.name.lower()
            if pilar not in ("lpr", "epi", "uploads"):
                continue
            if pilar_filter and pilar != pilar_filter:
                continue
            if not pilar_dir.is_dir():
                continue

            for f in sorted(pilar_dir.iterdir()):
                if f.is_file():
                    entries.append(FileEntry(
                        path=f, cam_id=cam_id,
                        cam_user=cam_dir.name,
                        pilar="lpr" if pilar != "epi" else "epi",
                    ))

    return entries


# ── Workers (importados do watchdog) ──────────────────────────────────────────

def _run_lpr(entry: FileEntry, db_dsn: str) -> dict:
    from services.watchdog_service import lpr_worker
    return lpr_worker(str(entry.path), db_dsn, hint_camera_id=entry.cam_id)


def _run_epi(entry: FileEntry, db_dsn: str) -> dict:
    from services.watchdog_service import epi_worker
    return epi_worker(str(entry.path), entry.cam_id, db_dsn)


# ── Função principal ───────────────────────────────────────────────────────────

def reprocess_sftp(
    sftp_root:    Path | str   = SFTP_ROOT,
    db_dsn:       str          = DB_DSN,
    cam_filter:   str | None   = None,
    pilar_filter: str | None   = None,
    dry_run:      bool         = False,
    lpr_workers:  int          = LPR_WORKERS,
    epi_workers:  int          = 2,
) -> ReprocessResult:
    """
    Reprocessa todos os arquivos JPEG pendentes nos diretórios SFTP.

    Args:
        sftp_root:    Raiz dos diretórios SFTP (padrão: SFTP_ROOT do .env)
        db_dsn:       DSN PostgreSQL
        cam_filter:   Processa só esta câmera (ex: 'cam_001')
        pilar_filter: Processa só este pilar ('lpr' ou 'epi')
        dry_run:      Lista arquivos sem processar
        lpr_workers:  Processos paralelos para LPR (ProcessPool)
        epi_workers:  Threads paralelas para EPI (ThreadPool)

    Returns:
        ReprocessResult com totais e lista de erros
    """
    sftp_root = Path(sftp_root)
    result    = ReprocessResult(dry_run=dry_run)

    if not sftp_root.exists():
        log.error("SFTP_ROOT não encontrado: %s", sftp_root)
        return result

    # 1. Scan
    entries = _scan(sftp_root, cam_filter, pilar_filter)
    result.total = len(entries)
    log.info("Encontrados %d arquivo(s) em %s", result.total, sftp_root)

    if result.total == 0:
        log.info("Nenhum arquivo pendente.")
        return result

    if dry_run:
        for e in entries:
            is_jpg = _is_jpeg(e.path)
            log.info("  [DRY] %-6s cam=%s  jpeg=%-5s  %s",
                     e.pilar.upper(), e.cam_user, str(is_jpg), e.path.name)
            if not is_jpg:
                result.skipped += 1
        return result

    # 2. Separar por pilar
    lpr_entries = [e for e in entries if e.pilar == "lpr"]
    epi_entries = [e for e in entries if e.pilar == "epi"]

    # Filtro JPEG (remove não-JPEGs antes de submeter)
    def _valid(lst: list[FileEntry]) -> list[FileEntry]:
        valid = []
        for e in lst:
            if _is_jpeg(e.path):
                valid.append(e)
            else:
                log.warning("Ignorado (não JPEG): %s", e.path.name)
                result.skipped += 1
        return valid

    lpr_entries = _valid(lpr_entries)
    epi_entries = _valid(epi_entries)

    t0 = time.time()

    # 3. LPR — ProcessPool (PaddleOCR precisa de processo isolado)
    if lpr_entries:
        log.info("Iniciando LPR: %d arquivo(s) com %d worker(s)...",
                 len(lpr_entries), lpr_workers)
        with ProcessPoolExecutor(max_workers=lpr_workers) as pool:
            futures = {
                pool.submit(_run_lpr, e, db_dsn): e
                for e in lpr_entries
            }
            for fut in as_completed(futures):
                entry = futures[fut]
                try:
                    res = fut.result()
                    if res.get("ok"):
                        result.lpr_ok += 1
                        placa = res.get("placa")
                        if placa:
                            result.placas.append(placa)
                        log.info("  ✔ LPR  placa=%-9s conf=%5.1f%%  %s",
                                 placa or "N/D",
                                 (res.get("confianca") or 0) * 100,
                                 entry.path.name)
                    else:
                        result.lpr_err += 1
                        err = f"LPR {entry.path.name}: {res.get('error','?')}"
                        result.erros.append(err)
                        log.error("  ✘ %s", err)
                except Exception as exc:
                    result.lpr_err += 1
                    result.erros.append(f"LPR {entry.path.name}: {exc}")
                    log.exception("  ✘ LPR exception: %s", entry.path.name)

    # 4. EPI — ThreadPool (YOLOv8 é thread-safe)
    if epi_entries:
        log.info("Iniciando EPI: %d arquivo(s) com %d worker(s)...",
                 len(epi_entries), epi_workers)
        with ThreadPoolExecutor(max_workers=epi_workers) as pool:
            futures = {
                pool.submit(_run_epi, e, db_dsn): e
                for e in epi_entries
            }
            for fut in as_completed(futures):
                entry = futures[fut]
                try:
                    res = fut.result()
                    if res.get("ok"):
                        result.epi_ok += 1
                        log.info("  ✔ EPI  conform=%-5s  %%.1f%%  %s",
                                 str(res.get("conformidade", True)),
                                 res.get("pct", 100),
                                 entry.path.name)
                    else:
                        result.epi_err += 1
                        err = f"EPI {entry.path.name}: {res.get('error','?')}"
                        result.erros.append(err)
                        log.error("  ✘ %s", err)
                except Exception as exc:
                    result.epi_err += 1
                    result.erros.append(f"EPI {entry.path.name}: {exc}")
                    log.exception("  ✘ EPI exception: %s", entry.path.name)

    elapsed = time.time() - t0
    log.info("Concluído em %.1fs", elapsed)
    log.info(result.summary())

    return result


# ── Endpoint REST (opcional — exposto via api.py) ─────────────────────────────

def reprocess_route(
    cam_filter:   str | None = None,
    pilar_filter: str | None = None,
    dry_run:      bool       = False,
) -> dict:
    """
    Wrapper para chamar de dentro do FastAPI.
    Exemplo:
        from services.sftp_reprocess import reprocess_route
        result = reprocess_route(cam_filter='cam_001', dry_run=True)
    """
    r = reprocess_sftp(cam_filter=cam_filter, pilar_filter=pilar_filter, dry_run=dry_run)
    return {
        "total":    r.total,
        "ok":       r.ok,
        "errors":   r.errors,
        "skipped":  r.skipped,
        "lpr_ok":   r.lpr_ok,
        "lpr_err":  r.lpr_err,
        "epi_ok":   r.epi_ok,
        "epi_err":  r.epi_err,
        "placas":   r.placas,
        "erros":    r.erros,
        "dry_run":  r.dry_run,
    }


# ── CLI ───────────────────────────────────────────────────────────────────────

def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="SuricathaIA — Reprocessamento de imagens SFTP pendentes")
    p.add_argument("--cam",     metavar="CAM_USER",
                   help="Filtrar câmera (ex: cam_001)")
    p.add_argument("--pilar",   choices=["lpr","epi"],
                   help="Filtrar pilar")
    p.add_argument("--dry-run", action="store_true",
                   help="Apenas lista arquivos, não processa")
    p.add_argument("--workers", type=int, default=LPR_WORKERS,
                   help=f"Workers LPR ProcessPool (padrão: {LPR_WORKERS})")
    p.add_argument("--sftp-root", default=str(SFTP_ROOT),
                   help=f"Raiz SFTP (padrão: {SFTP_ROOT})")
    return p.parse_args()


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()

    args = _parse()
    resultado = reprocess_sftp(
        sftp_root    = Path(args.sftp_root),
        cam_filter   = args.cam,
        pilar_filter = args.pilar,
        dry_run      = args.dry_run,
        lpr_workers  = args.workers,
    )
    sys.exit(0 if resultado.errors == 0 else 1)
