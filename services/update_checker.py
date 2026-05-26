"""
/app/services/update_checker.py
SuricathaIA — Rotina de Check de Atualização v1.0

Verifica periodicamente:
  1. Versão do software    — compara local vs. manifest remoto
  2. Watchdog              — processo vivo e consumindo fila
  3. Arquivos SFTP pendentes — imagens não processadas acumuladas
  4. Modelos IA            — existência e integridade dos arquivos
  5. Banco de dados        — conectividade e tamanho
  6. Disco                 — espaço livre no storage

Uso standalone (roda em background como daemon):
    python services/update_checker.py --interval 3600

Importado pela API:
    from services.update_checker import get_last_check, run_check_now
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent))

log = logging.getLogger("suricatha.updater")

# ── Configuração ───────────────────────────────────────────────────────────────

APP_ROOT    = Path(__file__).parent.parent
VERSION_FILE = APP_ROOT / "VERSION"
CACHE_FILE   = Path(os.getenv("LOG_DIR", "/opt/suricatha/logs")) / "update_check.json"
SFTP_ROOT    = Path(os.getenv("SFTP_ROOT", "/srv/suricatha/sftp_camera"))
STORAGE_DIR  = Path(os.getenv("STORAGE_DIR", "/opt/suricatha/storage"))
DB_DSN       = os.getenv("POSTGRES_DSN", "")

# URL do manifest remoto (opcional — deixe vazio para só checar local)
UPDATE_MANIFEST_URL = os.getenv("UPDATE_MANIFEST_URL", "")
CHECK_INTERVAL_S    = int(os.getenv("UPDATE_CHECK_INTERVAL_S", str(6 * 3600)))  # 6h padrão

DISK_WARN_PCT  = 85.0   # alerta se disco > 85%
SFTP_WARN_FILES  = 20   # alerta se > N arquivos travados no SFTP
SFTP_STALE_AGE_S = int(os.getenv("SFTP_STALE_AGE_S", "420"))  # 7 min — recuperação = 5min + 2min grace


# ── Tipos ──────────────────────────────────────────────────────────────────────

@dataclass
class ComponentStatus:
    ok: bool
    mensagem: str
    detalhes: dict = field(default_factory=dict)


@dataclass
class UpdateInfo:
    versao_atual: str
    versao_disponivel: Optional[str]
    atualizado: bool          # True = já está na última versão
    novidades: list[str]      # changelog resumido
    url_download: Optional[str]


@dataclass
class CheckResult:
    timestamp: str
    versao: UpdateInfo
    watchdog: ComponentStatus
    sftp_pendentes: ComponentStatus
    modelos: ComponentStatus
    banco: ComponentStatus
    disco: ComponentStatus
    saude_geral: str          # 'ok' | 'aviso' | 'critico'
    alertas: list[str]        # mensagens resumidas de atenção

    def to_dict(self) -> dict:
        return asdict(self)


# ── Checks individuais ─────────────────────────────────────────────────────────

def _versao_atual() -> str:
    try:
        return VERSION_FILE.read_text().strip()
    except Exception:
        return "desconhecida"


def _check_versao() -> UpdateInfo:
    atual = _versao_atual()
    disponivel = None
    novidades: list[str] = []
    url: Optional[str] = None

    if UPDATE_MANIFEST_URL:
        try:
            import urllib.request
            with urllib.request.urlopen(UPDATE_MANIFEST_URL, timeout=8) as r:
                manifest = json.loads(r.read())
            disponivel = manifest.get("versao", atual)
            novidades  = manifest.get("novidades", [])
            url        = manifest.get("url_download")
        except Exception as exc:
            log.debug("Manifest remoto indisponível: %s", exc)

    atualizado = (disponivel is None) or (disponivel == atual)
    return UpdateInfo(
        versao_atual=atual,
        versao_disponivel=disponivel,
        atualizado=atualizado,
        novidades=novidades,
        url_download=url,
    )


def _check_watchdog() -> ComponentStatus:
    """Verifica se o processo watchdog_service está rodando."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "watchdog_service"],
            capture_output=True, text=True, timeout=5,
        )
        pids = result.stdout.strip().split()
        if pids:
            # Verifica se está consumindo (tem CPU ou memória ativa)
            pid = pids[0]
            stat_path = Path(f"/proc/{pid}/status")
            estado = "?"
            if stat_path.exists():
                for linha in stat_path.read_text().splitlines():
                    if linha.startswith("State:"):
                        estado = linha.split()[-1]
                        break
            return ComponentStatus(
                ok=True,
                mensagem=f"Rodando — PID {', '.join(pids)} estado={estado}",
                detalhes={"pids": pids, "estado": estado},
            )
        return ComponentStatus(ok=False, mensagem="Processo watchdog não encontrado")
    except Exception as exc:
        return ComponentStatus(ok=False, mensagem=f"Erro ao verificar watchdog: {exc}")


def _check_sftp_pendentes() -> ComponentStatus:
    """
    Conta arquivos JPEG *travados* no SFTP_ROOT — ou seja, mais antigos que
    SFTP_STALE_AGE_S (padrão 7 min). Arquivos recentes são normais: o watchdog
    os processa via inotify ou recovery-scan em até 5 min.
    """
    if not SFTP_ROOT.exists():
        return ComponentStatus(ok=False, mensagem="SFTP_ROOT não existe", detalhes={"path": str(SFTP_ROOT)})

    agora       = time.time()
    total       = 0
    em_voo      = 0    # arquivos recentes (sendo processados agora)
    por_camera: dict[str, int] = {}

    for cam_dir in sorted(SFTP_ROOT.iterdir()):
        if not cam_dir.is_dir():
            continue
        cam_count = 0
        for f in cam_dir.rglob("*.jpg"):
            if not f.is_file():
                continue
            try:
                stat = f.stat()
                age  = agora - stat.st_mtime
                if age < SFTP_STALE_AGE_S:
                    em_voo += 1
                    continue          # arquivo recente — watchdog já está tratando
                with open(f, "rb") as fh:
                    if fh.read(3) == b"\xff\xd8\xff":
                        cam_count += 1
            except OSError:
                pass
        if cam_count:
            por_camera[cam_dir.name] = cam_count
        total += cam_count

    aviso = total >= SFTP_WARN_FILES
    if total == 0 and em_voo > 0:
        msg = f"Nenhum arquivo travado ({em_voo} em processamento)"
    elif total == 0:
        msg = "Nenhum arquivo pendente"
    else:
        msg = f"{total} arquivo(s) travado(s) há mais de {SFTP_STALE_AGE_S//60} min"

    return ComponentStatus(
        ok=not aviso,
        mensagem=msg,
        detalhes={"travados": total, "em_voo": em_voo, "por_camera": por_camera},
    )


def _check_modelos() -> ComponentStatus:
    """Verifica existência e MD5 dos modelos IA."""
    modelos = {
        "yolo_pessoas": os.getenv("YOLO_PEOPLE_MODEL", ""),
        "yolo_epi":     os.getenv("YOLO_PPE_MODEL", ""),
    }
    detalhes: dict = {}
    todos_ok = True

    for nome, caminho in modelos.items():
        p = Path(caminho)
        if not caminho:
            detalhes[nome] = {"ok": False, "erro": "Caminho não configurado"}
            todos_ok = False
            continue
        if not p.exists():
            detalhes[nome] = {"ok": False, "erro": "Arquivo não encontrado", "path": caminho}
            todos_ok = False
            continue

        tamanho_mb = round(p.stat().st_size / 1e6, 1)
        # md5 parcial (primeiros 512KB) — rápido e suficiente para detectar corrupção
        try:
            md5 = hashlib.md5()
            with open(p, "rb") as fh:
                md5.update(fh.read(524288))
            md5_parcial = md5.hexdigest()[:12]
        except Exception:
            md5_parcial = "?"

        detalhes[nome] = {"ok": True, "tamanho_mb": tamanho_mb,
                          "md5_parcial": md5_parcial, "path": caminho}

    return ComponentStatus(
        ok=todos_ok,
        mensagem="Modelos OK" if todos_ok else "Um ou mais modelos com problema",
        detalhes=detalhes,
    )


def _check_banco() -> ComponentStatus:
    """Testa conectividade e coleta métricas básicas do banco."""
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        conn = psycopg2.connect(DB_DSN, connect_timeout=5, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    count(*)                                       AS total_deteccoes,
                    count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'24h') AS det_24h,
                    pg_size_pretty(pg_database_size(current_database())) AS tamanho_db,
                    pg_database_size(current_database()) AS tamanho_bytes
                FROM deteccoes
            """)
            row = dict(cur.fetchone())
        conn.close()
        return ComponentStatus(
            ok=True,
            mensagem=f"Conectado — DB {row['tamanho_db']} · {row['total_deteccoes']} detecções",
            detalhes=row,
        )
    except Exception as exc:
        return ComponentStatus(ok=False, mensagem=f"Falha na conexão: {exc}")


def _check_disco() -> ComponentStatus:
    """Verifica espaço livre no diretório de storage."""
    import shutil
    try:
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        uso = shutil.disk_usage(str(STORAGE_DIR))
        pct = round(uso.used / uso.total * 100, 1)
        livre_gb  = round(uso.free  / 1e9, 1)
        total_gb  = round(uso.total / 1e9, 1)
        usado_gb  = round(uso.used  / 1e9, 1)
        aviso = pct >= DISK_WARN_PCT
        return ComponentStatus(
            ok=not aviso,
            mensagem=f"Disco {pct}% usado — {livre_gb} GB livre de {total_gb} GB",
            detalhes={"pct": pct, "livre_gb": livre_gb,
                      "usado_gb": usado_gb, "total_gb": total_gb},
        )
    except Exception as exc:
        return ComponentStatus(ok=False, mensagem=f"Erro ao verificar disco: {exc}")


# ── Execução do check completo ─────────────────────────────────────────────────

def run_check() -> CheckResult:
    """Executa todos os checks e retorna um CheckResult completo."""
    log.info("Iniciando check de atualização...")
    t0 = time.time()

    versao         = _check_versao()
    watchdog       = _check_watchdog()
    sftp_pend      = _check_sftp_pendentes()
    modelos        = _check_modelos()
    banco          = _check_banco()
    disco          = _check_disco()

    # ── Saúde geral e alertas ──────────────────────────────────────────────────
    alertas: list[str] = []

    if not versao.atualizado and versao.versao_disponivel:
        alertas.append(f"Nova versão disponível: {versao.versao_disponivel} (atual: {versao.versao_atual})")
    if not watchdog.ok:
        alertas.append(f"Watchdog: {watchdog.mensagem}")
    if not sftp_pend.ok:
        alertas.append(f"SFTP: {sftp_pend.mensagem}")
    if not modelos.ok:
        alertas.append(f"Modelos: {modelos.mensagem}")
    if not banco.ok:
        alertas.append(f"Banco: {banco.mensagem}")
    if not disco.ok:
        alertas.append(f"Disco: {disco.mensagem}")

    criticos = [not watchdog.ok, not banco.ok]
    avisos   = [not sftp_pend.ok, not modelos.ok, not disco.ok, not versao.atualizado]

    if any(criticos):
        saude = "critico"
    elif any(avisos):
        saude = "aviso"
    else:
        saude = "ok"

    result = CheckResult(
        timestamp       = datetime.now(timezone.utc).isoformat(),
        versao          = versao,
        watchdog        = watchdog,
        sftp_pendentes  = sftp_pend,
        modelos         = modelos,
        banco           = banco,
        disco           = disco,
        saude_geral     = saude,
        alertas         = alertas,
    )

    elapsed = round(time.time() - t0, 2)
    log.info("Check concluído em %.2fs — saúde=%s alertas=%d", elapsed, saude, len(alertas))

    # Persiste resultado em cache JSON
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = result.to_dict()
        payload["elapsed_s"] = elapsed
        CACHE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    except Exception as exc:
        log.warning("Não foi possível salvar cache: %s", exc)

    return result


# ── Cache / API helpers ───────────────────────────────────────────────────────

def get_last_check() -> Optional[dict]:
    """Retorna o resultado do último check (do cache em disco). None se nunca executado."""
    try:
        if CACHE_FILE.exists():
            return json.loads(CACHE_FILE.read_text())
    except Exception:
        pass
    return None


def run_check_now() -> dict:
    """Executa check imediato e retorna dict (usado pelo endpoint REST)."""
    return run_check().to_dict()


# ── Daemon background ─────────────────────────────────────────────────────────

class UpdateCheckerDaemon:
    """Roda run_check() em background a cada `interval` segundos."""

    def __init__(self, interval: int = CHECK_INTERVAL_S):
        self._interval = interval
        self._stop     = threading.Event()
        self._thread   = threading.Thread(target=self._loop, daemon=True, name="update-checker")

    def start(self):
        log.info("UpdateChecker daemon iniciado — intervalo=%ds", self._interval)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        # Primeiro check após 30s do boot (deixa o sistema estabilizar)
        self._stop.wait(30)
        while not self._stop.is_set():
            try:
                run_check()
            except Exception as exc:
                log.error("Erro no check: %s", exc)
            self._stop.wait(self._interval)


_daemon: Optional[UpdateCheckerDaemon] = None


def start_daemon(interval: int = CHECK_INTERVAL_S) -> UpdateCheckerDaemon:
    """Inicia o daemon de background (chamar uma vez na inicialização da API)."""
    global _daemon
    if _daemon is None:
        _daemon = UpdateCheckerDaemon(interval)
        _daemon.start()
    return _daemon


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="[UPDATE-CHECK] %(asctime)s — %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    parser = argparse.ArgumentParser(description="SuricathaIA — Check de Atualização")
    parser.add_argument("--interval", type=int, default=0,
                        help="Intervalo em segundos para rodar em loop (0 = executa uma vez)")
    parser.add_argument("--json", action="store_true",
                        help="Saída em JSON")
    args = parser.parse_args()

    if args.interval > 0:
        log.info("Modo daemon — intervalo=%ds", args.interval)
        daemon = UpdateCheckerDaemon(args.interval)
        daemon.start()
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            daemon.stop()
    else:
        result = run_check()
        if args.json:
            print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        else:
            print()
            print("━" * 56)
            print(f"  SURICATHAIA — CHECK DE ATUALIZAÇÃO")
            print("━" * 56)
            print(f"  Timestamp   : {result.timestamp}")
            print(f"  Saúde Geral : {result.saude_geral.upper()}")
            print(f"  Versão      : {result.versao.versao_atual}"
                  + (f" → {result.versao.versao_disponivel} disponível"
                     if not result.versao.atualizado else " (atualizado)"))
            print(f"  Watchdog    : {'✔' if result.watchdog.ok else '✘'} {result.watchdog.mensagem}")
            print(f"  SFTP Pend.  : {'✔' if result.sftp_pendentes.ok else '⚠'} {result.sftp_pendentes.mensagem}")
            print(f"  Modelos IA  : {'✔' if result.modelos.ok else '✘'} {result.modelos.mensagem}")
            print(f"  Banco       : {'✔' if result.banco.ok else '✘'} {result.banco.mensagem}")
            print(f"  Disco       : {'✔' if result.disco.ok else '⚠'} {result.disco.mensagem}")
            if result.alertas:
                print()
                print("  ALERTAS:")
                for a in result.alertas:
                    print(f"    ⚠ {a}")
            print("━" * 56)
