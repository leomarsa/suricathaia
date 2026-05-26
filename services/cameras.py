"""
/app/services/cameras.py
SuricathaIA — Serviço de Gerenciamento de Câmeras LPR
CRUD completo + teste de conectividade SFTP + heartbeat de status.
"""

import os
import time
import socket
import logging
import threading
from datetime import datetime, timezone
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor

log = logging.getLogger("suricatha.cameras")

PG_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db"
)


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    return psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)


# ════════════════════════════════════════════════════════════════════════════
#  CRUD
# ════════════════════════════════════════════════════════════════════════════

def _none(v):
    """Converte string vazia para None — evita erro em colunas inet/numeric."""
    return v if v not in (None, "", [], {}) else None


def create_camera(data: dict) -> dict:
    """
    Cadastra nova câmera.
    data deve conter: nome, local. Demais campos são opcionais.
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO cameras (
                    nome, local, descricao,
                    ip_sftp, porta_sftp,
                    protocolo, url_stream,
                    fabricante, modelo,
                    tipo, sentido, resolucao, fps,
                    faixa_horaria, prefixo_arquivo,
                    rec_lpr, rec_deteccao_unica, janela_dedup_seg,
                    intervalo_captura_seg,
                    rec_epi, rec_contagem_pessoas, limite_pessoas, zona_interesse,
                    latitude, longitude, observacoes,
                    numero_serie, url_base,
                    usuario_camera, senha_camera, porta_http, https_camera,
                    protocolo_lpr
                ) VALUES (
                    %(nome)s, %(local)s, %(descricao)s,
                    %(ip_sftp)s, %(porta_sftp)s,
                    %(protocolo)s, %(url_stream)s,
                    %(fabricante)s, %(modelo)s,
                    %(tipo)s, %(sentido)s, %(resolucao)s, %(fps)s,
                    %(faixa_horaria)s, %(prefixo_arquivo)s,
                    %(rec_lpr)s, %(rec_deteccao_unica)s, %(janela_dedup_seg)s,
                    %(intervalo_captura_seg)s,
                    %(rec_epi)s, %(rec_contagem_pessoas)s, %(limite_pessoas)s, %(zona_interesse)s,
                    %(latitude)s, %(longitude)s, %(observacoes)s,
                    %(numero_serie)s, %(url_base)s,
                    %(usuario_camera)s, %(senha_camera)s, %(porta_http)s, %(https_camera)s,
                    %(protocolo_lpr)s
                )
                RETURNING *
            """, {
                "nome"                  : data["nome"],
                "local"                 : data["local"],
                "descricao"             : _none(data.get("descricao")),
                "ip_sftp"               : _none(data.get("ip_sftp")),
                "porta_sftp"            : data.get("porta_sftp") or 22,
                "protocolo"             : data.get("protocolo") or "rtsp",
                "url_stream"            : _none(data.get("url_stream")),
                "fabricante"            : _none(data.get("fabricante")),
                "modelo"                : _none(data.get("modelo")),
                "tipo"                  : data.get("tipo") or "lpr",
                "sentido"               : data.get("sentido") or "ambos",
                "resolucao"             : data.get("resolucao") or "1080p",
                "fps"                   : data.get("fps") or 15,
                "faixa_horaria"         : data.get("faixa_horaria") or "00:00-23:59",
                "prefixo_arquivo"       : _none(data.get("prefixo_arquivo")),
                "rec_lpr"               : bool(data.get("rec_lpr", False)),
                "rec_deteccao_unica"    : bool(data.get("rec_deteccao_unica", False)),
                "janela_dedup_seg"      : data.get("janela_dedup_seg") or 60,
                "intervalo_captura_seg" : data.get("intervalo_captura_seg") or 0,
                "rec_epi"               : bool(data.get("rec_epi", False)),
                "rec_contagem_pessoas"  : bool(data.get("rec_contagem_pessoas", False)),
                "limite_pessoas"        : _none(data.get("limite_pessoas")),
                "zona_interesse"        : _none(data.get("zona_interesse")),
                "latitude"              : _none(data.get("latitude")),
                "longitude"             : _none(data.get("longitude")),
                "observacoes"           : _none(data.get("observacoes")),
                "numero_serie"          : _none(data.get("numero_serie")),
                "url_base"              : _none(data.get("url_base")),
                "usuario_camera"        : _none(data.get("usuario_camera")),
                "senha_camera"          : _none(data.get("senha_camera")),
                "porta_http"            : data.get("porta_http") or 80,
                "https_camera"          : bool(data.get("https_camera", False)),
                "protocolo_lpr"         : data.get("protocolo_lpr") or "sftp",
            })
            camera = dict(cur.fetchone())

            # Auto-gera url_stream se não fornecida
            if not camera.get("url_stream"):
                fab = (camera.get("fabricante") or "").lower()
                ip  = str(camera.get("ip_sftp") or "").strip().split("/")[0]
                auto_url = None

                if camera.get("protocolo") == "rtmp":
                    rtmp_host = os.getenv("RTMP_HOST", "")
                    rtmp_port = os.getenv("RTMP_PORT", "1935")
                    cam_uuid  = str(camera["uuid"])
                    auto_url  = f"rtmp://{rtmp_host}:{rtmp_port}/live/{cam_uuid}"
                elif ip and "intelbras" in fab:
                    # Intelbras RTSP padrão
                    usr = camera.get("usuario_camera") or "admin"
                    pwd = camera.get("senha_camera") or ""
                    creds = f"{usr}:{pwd}@" if pwd else f"{usr}@"
                    auto_url = f"rtsp://{creds}{ip}:554/cam/realmonitor?channel=1&subtype=0"
                elif ip and ("hikvision" in fab or "hik" in fab):
                    # Hikvision RTSP padrão
                    usr = camera.get("usuario_camera") or "admin"
                    pwd = camera.get("senha_camera") or ""
                    creds = f"{usr}:{pwd}@" if pwd else f"{usr}@"
                    auto_url = f"rtsp://{creds}{ip}:554/Streaming/Channels/101"

                if auto_url:
                    cur.execute(
                        "UPDATE cameras SET url_stream = %s WHERE id = %s RETURNING url_stream",
                        (auto_url, camera["id"])
                    )
                    camera["url_stream"] = cur.fetchone()["url_stream"]

            conn.commit()

        log.info("[SURICATHA-LOG] %s - Câmera criada: id=%d nome=%s proto=%s url=%s",
                 _ts(), camera["id"], camera["nome"],
                 camera.get("protocolo"), camera.get("url_stream") or "—")
        return camera
    finally:
        conn.close()


def get_camera(camera_id: int) -> Optional[dict]:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM cameras_status WHERE id = %s",
                (camera_id,)
            )
            row = cur.fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


def list_cameras(ativa: Optional[bool] = None,
                 tipo: Optional[str]   = None,
                 status: Optional[str] = None) -> list:
    conn = _conn()
    try:
        filters, params = [], []
        if ativa is not None:
            filters.append("ativa = %s");         params.append(ativa)
        if tipo:
            filters.append("tipo = %s");           params.append(tipo)
        if status:
            filters.append("status_conexao = %s"); params.append(status)

        where = ("WHERE " + " AND ".join(filters)) if filters else ""
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM cameras_status {where}", params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def update_camera(camera_id: int, data: dict) -> Optional[dict]:
    """Atualiza campos enviados em data (PATCH parcial)."""
    allowed = {
        "nome", "local", "descricao",
        "ip_sftp", "porta_sftp", "usuario_sftp", "pasta_upload",
        "protocolo", "url_stream",
        "fabricante", "modelo",
        "tipo", "sentido", "resolucao", "fps",
        "faixa_horaria", "prefixo_arquivo",
        "rec_lpr", "beep_lpr", "rec_deteccao_unica", "janela_dedup_seg",
        "intervalo_captura_seg",
        "rec_epi", "rec_contagem_pessoas", "limite_pessoas", "zona_interesse",
        "numero_serie", "url_base",
        "ativa", "latitude", "longitude", "observacoes",
        "usuario_camera", "senha_camera", "porta_http", "https_camera",
        "protocolo_lpr",
    }
    # Sanitiza strings vazias para None (inet e outros tipos estritos do PG)
    NONE_IF_EMPTY = {"ip_sftp", "url_stream", "url_base", "fabricante", "modelo",
                     "numero_serie", "prefixo_arquivo", "zona_interesse",
                     "observacoes", "descricao", "usuario_sftp", "pasta_upload"}
    cleaned = {k: (_none(v) if k in NONE_IF_EMPTY else v) for k, v in data.items()}
    fields = {k: v for k, v in cleaned.items() if k in allowed}
    if not fields:
        return get_camera(camera_id)

    fields["atualizado_em"] = datetime.now(timezone.utc)
    set_clause = ", ".join(f"{k} = %s" for k in fields)
    values     = list(fields.values()) + [camera_id]

    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE cameras SET {set_clause} WHERE id = %s RETURNING id",
                values
            )
            if cur.rowcount == 0:
                return None
            conn.commit()

        log.info("[SURICATHA-LOG] %s - Câmera atualizada: id=%d campos=%s",
                 _ts(), camera_id, list(fields.keys()))
        return get_camera(camera_id)
    finally:
        conn.close()


def delete_camera(camera_id: int) -> bool:
    """Soft delete — desativa a câmera (preserva histórico de detecções)."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE cameras SET ativa = FALSE, atualizado_em = NOW() WHERE id = %s",
                (camera_id,)
            )
            deleted = cur.rowcount > 0
            conn.commit()

        if deleted:
            log.info("[SURICATHA-LOG] %s - Câmera desativada: id=%d", _ts(), camera_id)
        return deleted
    finally:
        conn.close()


# ════════════════════════════════════════════════════════════════════════════
#  TESTE DE CONECTIVIDADE SFTP
# ════════════════════════════════════════════════════════════════════════════

def test_sftp_connection(camera_id: int) -> dict:
    """
    Testa conectividade TCP na porta SFTP da câmera.
    Não faz autenticação — apenas verifica se a porta está aberta.
    Atualiza status_conexao no banco.
    """
    camera = get_camera(camera_id)
    if not camera:
        return {"ok": False, "error": "Câmera não encontrada"}

    ip   = str(camera.get("ip_sftp") or "").strip().split("/")[0]  # strip CIDR prefix from INET type
    port = int(camera.get("porta_sftp") or 22)

    if not ip:
        _update_status(camera_id, "desconhecida")
        return {"ok": False, "error": "IP não configurado"}

    start = time.perf_counter()
    try:
        sock = socket.create_connection((ip, port), timeout=5)
        sock.close()
        ms     = int((time.perf_counter() - start) * 1000)
        status = "online"
        result = {"ok": True, "ip": ip, "porta": port, "latencia_ms": ms}
        log.info("[SURICATHA-LOG] %s - SFTP online: id=%d ip=%s:%d %dms",
                 _ts(), camera_id, ip, port, ms)
    except (socket.timeout, ConnectionRefusedError, OSError) as exc:
        status = "offline"
        result = {"ok": False, "ip": ip, "porta": port, "error": str(exc)}
        log.warning("[SURICATHA-LOG] %s - SFTP offline: id=%d ip=%s:%d erro=%s",
                    _ts(), camera_id, ip, port, exc)

    _update_status(camera_id, status)
    return result


def _update_status(camera_id: int, status: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE cameras
                SET status_conexao = %s,
                    ultima_conexao  = NOW(),
                    atualizado_em   = NOW()
                WHERE id = %s
            """, (status, camera_id))
            conn.commit()
    finally:
        conn.close()


# ════════════════════════════════════════════════════════════════════════════
#  HEARTBEAT — verifica todas as câmeras ativas periodicamente
# ════════════════════════════════════════════════════════════════════════════

class CameraHeartbeat:
    """
    Thread daemon que verifica a conectividade de todas as câmeras ativas
    a cada HEARTBEAT_INTERVAL segundos.
    """

    INTERVAL = int(os.getenv("CAMERA_HEARTBEAT_INTERVAL", "120"))  # 2 min

    def __init__(self):
        self._stop   = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="camera-heartbeat"
        )

    def start(self):
        self._thread.start()
        log.info("[SURICATHA-LOG] %s - CameraHeartbeat iniciado (interval=%ds)",
                 _ts(), self.INTERVAL)

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(timeout=self.INTERVAL):
            try:
                cameras = list_cameras(ativa=True)
                for cam in cameras:
                    if cam.get("ip_sftp"):
                        test_sftp_connection(cam["id"])
                log.info("[SURICATHA-LOG] %s - Heartbeat: %d câmeras verificadas",
                         _ts(), len(cameras))
            except Exception as exc:
                log.error("[SURICATHA-LOG] %s - Heartbeat erro: %s", _ts(), exc)
