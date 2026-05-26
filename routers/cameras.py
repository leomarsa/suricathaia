"""
/app/routers/cameras.py
SuricathaIA — Router de Câmeras LPR
Endpoints CRUD completos + teste SFTP + estatísticas.
"""

import os
import time
import logging
import socket
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends, BackgroundTasks
from pydantic import BaseModel, Field

from core.auth import require_auth, require_role
from services.cameras import (
    create_camera, get_camera, list_cameras,
    update_camera, delete_camera, test_sftp_connection,
)
from services.sftp_provisioner import provision, reset_password, get_password
from services.intelbras_lpr import get_instance as _get_intelbras

log    = logging.getLogger("suricatha.routers.cameras")
router = APIRouter(prefix="/api/v1/cameras", tags=["Câmeras"])


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ── Schemas ───────────────────────────────────────────────────────────────────
class CameraCreate(BaseModel):
    # Identificação
    nome:             str            = Field(..., min_length=1, max_length=64)
    local:            str            = Field(..., min_length=1, max_length=128)
    descricao:        Optional[str]  = None
    latitude:         Optional[float]= None
    longitude:        Optional[float]= None
    # Hardware
    fabricante:       Optional[str]  = None
    modelo:           Optional[str]  = None
    numero_serie:     Optional[str]  = None
    # Conexão — stream
    url_base:         Optional[str]  = None
    url_stream:       Optional[str]  = None
    resolucao:        str            = Field("1080p")
    fps:              int            = Field(15, ge=1, le=60)
    protocolo:        str            = Field("rtsp", pattern="^(sftp|rtmp|rtsp|http)$")
    # Conexão — SFTP (usuário/pasta gerados automaticamente no provisionamento)
    ip_sftp:          Optional[str]  = None
    porta_sftp:       int            = Field(22, ge=1, le=65535)
    faixa_horaria:    str            = Field("00:00-23:59")
    prefixo_arquivo:  Optional[str]  = None
    tipo:             str            = Field("lpr", pattern="^(lpr|perimetro|acesso|mobile)$")
    sentido:          str            = Field("ambos", pattern="^(entrada|saida|ambos)$")
    # Pillar LPR
    rec_lpr:              bool       = Field(False)
    beep_lpr:             bool       = Field(False)
    rec_deteccao_unica:   bool       = Field(False)
    janela_dedup_seg:     int        = Field(60, ge=5, le=3600)
    intervalo_captura_seg: int       = Field(0, ge=0)
    # Pillar EPI
    rec_epi:              bool       = Field(False)
    zona_interesse:       Optional[str] = None
    # Pillar Contagem
    rec_contagem_pessoas: bool       = Field(False)
    limite_pessoas:       Optional[int] = Field(None, ge=1)
    observacoes:      Optional[str]  = None
    # HTTP API credentials
    usuario_camera:   Optional[str]  = None
    senha_camera:     Optional[str]  = None
    porta_http:       int            = Field(80, ge=1, le=65535)
    https_camera:     bool           = Field(False)
    # Fonte LPR
    protocolo_lpr:    str            = Field("sftp", pattern="^(sftp|intelbras_api)$")


class CameraUpdate(BaseModel):
    nome:             Optional[str]  = Field(None, min_length=1, max_length=64)
    local:            Optional[str]  = Field(None, min_length=1, max_length=128)
    descricao:        Optional[str]  = None
    latitude:         Optional[float]= None
    longitude:        Optional[float]= None
    fabricante:       Optional[str]  = None
    modelo:           Optional[str]  = None
    numero_serie:     Optional[str]  = None
    url_base:         Optional[str]  = None
    url_stream:       Optional[str]  = None
    resolucao:        Optional[str]  = None
    fps:              Optional[int]  = Field(None, ge=1, le=60)
    protocolo:        Optional[str]  = Field(None, pattern="^(sftp|rtmp|rtsp|http)$")
    ip_sftp:          Optional[str]  = None
    porta_sftp:       Optional[int]  = Field(None, ge=1, le=65535)
    faixa_horaria:    Optional[str]  = None
    prefixo_arquivo:  Optional[str]  = None
    tipo:             Optional[str]  = Field(None, pattern="^(lpr|perimetro|acesso|mobile)$")
    sentido:          Optional[str]  = Field(None, pattern="^(entrada|saida|ambos)$")
    rec_lpr:              Optional[bool]  = None
    beep_lpr:             Optional[bool]  = None
    rec_deteccao_unica:   Optional[bool]  = None
    janela_dedup_seg:     Optional[int]   = Field(None, ge=5, le=3600)
    intervalo_captura_seg: Optional[int]  = Field(None, ge=0)
    rec_epi:              Optional[bool]  = None
    zona_interesse:       Optional[str]   = None
    rec_contagem_pessoas: Optional[bool]  = None
    limite_pessoas:       Optional[int]   = Field(None, ge=1)
    ativa:                Optional[bool]  = None
    observacoes:          Optional[str]   = None
    usuario_camera:       Optional[str]   = None
    senha_camera:         Optional[str]   = None
    porta_http:           Optional[int]   = Field(None, ge=1, le=65535)
    https_camera:         Optional[bool]  = None
    protocolo_lpr:        Optional[str]   = Field(None, pattern="^(sftp|intelbras_api)$")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/intelbras-status", summary="Status das conexões Intelbras LPR")
def intelbras_status_endpoint(auth: dict = Depends(require_auth)):
    """Retorna o estado de cada thread de long-polling Intelbras (connected/reconnecting/error/stopped)."""
    svc = _get_intelbras()
    return svc.status() if svc else []


@router.get("", summary="Listar câmeras")
def list_cameras_endpoint(
    ativa:  Optional[bool] = Query(None, description="Filtrar por ativa/inativa"),
    tipo:   Optional[str]  = Query(None, description="lpr | perimetro | acesso | mobile"),
    status: Optional[str]  = Query(None, description="online | offline | erro | desconhecida"),
    auth:   dict           = Depends(require_auth),
):
    """
    Retorna todas as câmeras com estatísticas das últimas 24h:
    total de detecções, hits na watchlist, confiança média e tempo médio de OCR.
    """
    cameras = list_cameras(ativa=ativa, tipo=tipo, status=status)
    return {"total": len(cameras), "data": cameras}


class TestConnectionBody(BaseModel):
    ip:   str
    porta: int = 22
    timeout_ms: int = Field(3000, ge=500, le=10000)

@router.post("/test-connection", summary="Testar conexão TCP sem ID")
def test_connection_endpoint(body: TestConnectionBody, auth: dict = Depends(require_auth)):
    """Testa alcançabilidade TCP de um host/porta sem exigir câmera cadastrada."""
    import time as _time
    t0 = _time.monotonic()
    try:
        sock = socket.create_connection((body.ip, body.porta), timeout=body.timeout_ms / 1000)
        sock.close()
        lat = round((_time.monotonic() - t0) * 1000)
        return {"ok": True, "latencia_ms": lat, "ip": body.ip, "porta": body.porta}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "ip": body.ip, "porta": body.porta}


class TestHttpApiBody(BaseModel):
    ip:         str
    fabricante: str
    usuario:    str
    senha:      str
    porta:      int  = 80
    https:      bool = False
    channel:    int  = 1

@router.post("/test-http-api", summary="Testar API HTTP nativa (Hikvision/Intelbras)")
def test_http_api_endpoint(body: TestHttpApiBody, auth: dict = Depends(require_auth)):
    """
    Captura um snapshot via API HTTP nativa da câmera.
    Suporta Hikvision ISAPI e Intelbras CGI com Digest Auth.
    Retorna ok + tamanho da imagem em bytes se bem-sucedido.
    """
    import time as _time
    from services.camera_snapshot import _http_snapshot
    t0 = _time.monotonic()
    jpeg = _http_snapshot(
        ip=body.ip, fabricante=body.fabricante,
        usuario=body.usuario, senha=body.senha,
        porta=body.porta, https=body.https, channel=body.channel,
    )
    ms = round((_time.monotonic() - t0) * 1000)
    if jpeg:
        log.info("[SURICATHA-LOG] %s - HTTP API OK: ip=%s fab=%s %dms size=%db",
                 _ts(), body.ip, body.fabricante, ms, len(jpeg))
        return {"ok": True, "latencia_ms": ms, "bytes": len(jpeg)}
    return {"ok": False, "latencia_ms": ms, "error": "Sem imagem — verifique IP, credenciais e fabricante"}


@router.post("", status_code=201, summary="Cadastrar câmera")
def create_camera_endpoint(
    body: CameraCreate,
    auth: dict = Depends(require_auth),
):
    """
    Cadastra nova câmera e provisiona automaticamente o usuário SFTP Linux
    com diretórios isolados por pilar (lpr/ epi/).
    A senha SFTP é retornada apenas nesta resposta — guarde-a.
    """
    camera = create_camera(body.model_dump())
    cam_id = camera["id"]

    if body.protocolo == "rtmp":
        # Câmeras RTMP usam MediaMTX — não precisam de usuário SFTP Linux
        camera["rtmp_url"]    = camera.get("url_stream") or ""
        camera["sftp_pilares"] = []
        log.info("[SURICATHA-LOG] %s - POST /cameras id=%d nome=%s proto=rtmp url=%s",
                 _ts(), cam_id, camera["nome"], camera["rtmp_url"])
    else:
        # SFTP/RTSP/HTTP: provisiona usuário SFTP Linux
        prov = provision(cam_id, rec_lpr=body.rec_lpr, rec_epi=body.rec_epi,
                         rec_pessoas=body.rec_contagem_pessoas)
        camera["sftp_provisioned"] = prov["linux_ok"] and prov["password_ok"]
        camera["sftp_usuario"]     = prov["username"]
        camera["sftp_senha"]       = prov["password"]
        camera["sftp_home"]        = prov["home_dir"]
        camera["sftp_pilares"]     = prov["pillars"]
        if prov["errors"]:
            camera["sftp_avisos"]  = prov["errors"]
        log.info("[SURICATHA-LOG] %s - POST /cameras id=%d nome=%s sftp=%s proto=%s",
                 _ts(), cam_id, camera["nome"], prov["username"], body.protocolo)

    return camera


@router.get("/lpr-activity", summary="Atividade SFTP/LPR por câmera")
def lpr_activity(auth: dict = Depends(require_auth)):
    """Retorna por câmera LPR: última imagem SFTP, contadores 1h/24h e status online."""
    from psycopg2.extras import RealDictCursor
    import psycopg2, os
    dsn  = os.getenv("POSTGRES_DSN", "")
    conn = psycopg2.connect(dsn, cursor_factory=RealDictCursor)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    c.id,
                    c.nome,
                    c.local,
                    c.ativa,
                    c.ultima_imagem_sftp,
                    COALESCE(c.total_imagens_sftp, 0) AS total_imagens_sftp,
                    COUNT(d.id) FILTER (WHERE d.detectado_em >= NOW() - INTERVAL '1 hour')  AS deteccoes_1h,
                    COUNT(d.id) FILTER (WHERE d.detectado_em >= NOW() - INTERVAL '24 hours') AS deteccoes_24h,
                    COUNT(d.id) FILTER (
                        WHERE d.detectado_em >= NOW() - INTERVAL '24 hours'
                          AND d.watchlist_hit
                    ) AS alertas_24h
                FROM cameras c
                LEFT JOIN deteccoes d ON d.camera_id = c.id
                WHERE c.rec_lpr = TRUE AND c.ativa = TRUE
                GROUP BY c.id, c.nome, c.local, c.ativa, c.ultima_imagem_sftp, c.total_imagens_sftp
                ORDER BY c.nome
            """)
            rows = cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/{camera_id}", summary="Detalhar câmera")
def get_camera_endpoint(
    camera_id: int,
    auth: dict = Depends(require_auth),
):
    """Retorna dados completos de uma câmera incluindo estatísticas 24h."""
    camera = get_camera(camera_id)
    if not camera:
        raise HTTPException(404, f"Câmera id={camera_id} não encontrada")
    return camera


@router.patch("/{camera_id}", summary="Atualizar câmera")
def update_camera_endpoint(
    camera_id: int,
    body: CameraUpdate,
    auth: dict = Depends(require_auth),
):
    """
    Atualização parcial (PATCH). Envie apenas os campos que deseja alterar.
    Para desativar uma câmera, envie `{"ativa": false}`.
    """
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    camera = update_camera(camera_id, data)
    if not camera:
        raise HTTPException(404, f"Câmera id={camera_id} não encontrada")
    return camera


class SchedulePessoasBody(BaseModel):
    faixa_horaria: str = Field(
        "00:00-23:59",
        description="Faixa horária de ativação no formato HH:MM-HH:MM (ex: 08:00-18:00). Use 00:00-23:59 para sempre ativo.",
        pattern=r"^\d{2}:\d{2}-\d{2}:\d{2}$",
    )

@router.patch("/{camera_id}/schedule-pessoas", summary="Configurar horário da contagem de pessoas")
def schedule_pessoas_endpoint(
    camera_id: int,
    body: SchedulePessoasBody,
    auth: dict = Depends(require_auth),
):
    """
    Define a faixa horária em que a câmera processa contagem de pessoas.
    Fora desse horário o stream permanece aberto mas a inferência é pausada.
    """
    camera = update_camera(camera_id, {"faixa_horaria": body.faixa_horaria})
    if not camera:
        raise HTTPException(404, f"Câmera id={camera_id} não encontrada")
    log.info("[SURICATHA-LOG] %s - Horário pessoas atualizado: id=%d faixa=%s",
             _ts(), camera_id, body.faixa_horaria)
    return {"id": camera_id, "faixa_horaria": body.faixa_horaria}


@router.delete("/{camera_id}", status_code=204, summary="Desativar câmera")
def delete_camera_endpoint(
    camera_id: int,
    auth: dict = Depends(require_auth),
):
    """
    Soft delete — desativa a câmera preservando todo o histórico de detecções.
    Para reativar, use PATCH com `{"ativa": true}`.
    """
    if not delete_camera(camera_id):
        raise HTTPException(404, f"Câmera id={camera_id} não encontrada")


@router.post("/{camera_id}/test", summary="Testar conexão SFTP")
def test_sftp_endpoint(
    camera_id: int,
    background_tasks: BackgroundTasks,
    auth: dict = Depends(require_auth),
):
    """
    Testa conectividade TCP na porta SFTP da câmera.
    Atualiza `status_conexao` e `ultima_conexao` no banco.
    Retorna latência em ms se online.
    """
    camera = get_camera(camera_id)
    if not camera:
        raise HTTPException(404, f"Câmera id={camera_id} não encontrada")
    if not camera.get("ip_sftp"):
        raise HTTPException(400, "Câmera não tem IP configurado")

    result = test_sftp_connection(camera_id)
    return {
        "camera_id"   : camera_id,
        "nome"        : camera["nome"],
        "ip"          : camera["ip_sftp"],
        "porta"       : camera["porta_sftp"],
        "status"      : "online" if result["ok"] else "offline",
        "latencia_ms" : result.get("latencia_ms"),
        "error"       : result.get("error"),
    }


@router.get("/{camera_id}/stats", summary="Estatísticas da câmera")
def camera_stats_endpoint(
    camera_id: int,
    dias: int  = Query(7, ge=1, le=90, description="Período em dias"),
    auth: dict = Depends(require_auth),
):
    """
    Estatísticas detalhadas de uma câmera: detecções por dia,
    horários de pico, placas mais frequentes, watchlist hits.
    """
    from psycopg2.extras import RealDictCursor
    import psycopg2, os

    camera = get_camera(camera_id)
    if not camera:
        raise HTTPException(404, f"Câmera id={camera_id} não encontrada")

    dsn  = os.getenv("POSTGRES_DSN", "")
    conn = psycopg2.connect(dsn, cursor_factory=RealDictCursor)
    try:
        with conn.cursor() as cur:
            # Detecções por dia
            cur.execute("""
                SELECT
                    detectado_em::date          AS dia,
                    count(*)                    AS total,
                    count(*) FILTER (WHERE validado)      AS validadas,
                    count(*) FILTER (WHERE watchlist_hit) AS wl_hits,
                    avg(confianca_final)::numeric(5,3)    AS conf_media
                FROM deteccoes
                WHERE camera_id = %s
                  AND detectado_em >= NOW() - (%s || ' days')::INTERVAL
                GROUP BY 1 ORDER BY 1 DESC
            """, (camera_id, dias))
            por_dia = [dict(r) for r in cur.fetchall()]

            # Pico por hora do dia
            cur.execute("""
                SELECT
                    EXTRACT(HOUR FROM detectado_em)::int AS hora,
                    count(*) AS total
                FROM deteccoes
                WHERE camera_id = %s
                  AND detectado_em >= NOW() - (%s || ' days')::INTERVAL
                GROUP BY 1 ORDER BY total DESC
                LIMIT 5
            """, (camera_id, dias))
            pico_horas = [dict(r) for r in cur.fetchall()]

            # Top placas
            cur.execute("""
                SELECT placa, count(*) AS ocorrencias
                FROM deteccoes
                WHERE camera_id = %s
                  AND detectado_em >= NOW() - (%s || ' days')::INTERVAL
                  AND placa IS NOT NULL
                GROUP BY placa ORDER BY ocorrencias DESC
                LIMIT 10
            """, (camera_id, dias))
            top_placas = [dict(r) for r in cur.fetchall()]

        return {
            "camera"    : {"id": camera_id, "nome": camera["nome"]},
            "periodo_dias": dias,
            "por_dia"   : por_dia,
            "pico_horas": pico_horas,
            "top_placas": top_placas,
        }
    finally:
        conn.close()


@router.post("/{camera_id}/reset-sftp", summary="Gerar nova senha SFTP")
def reset_sftp_endpoint(
    camera_id: int,
    auth: dict = Depends(require_role("admin")),
):
    """Gera nova senha SFTP para a câmera e retorna em plaintext (apenas admin)."""
    result = reset_password(camera_id)
    if not result["ok"]:
        raise HTTPException(400, detail=result.get("error"))
    return result


@router.get("/{camera_id}/sftp-credentials", summary="Recuperar credenciais SFTP")
def sftp_credentials_endpoint(
    camera_id: int,
    auth: dict = Depends(require_role("admin")),
):
    """Retorna credenciais SFTP descriptografadas (apenas admin)."""
    result = get_password(camera_id)
    if not result["ok"]:
        raise HTTPException(400, detail=result.get("error"))
    return result
