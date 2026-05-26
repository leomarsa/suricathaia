"""
/app/routers/analytics.py
SuricathaIA — Router de Analytics
Endpoints para consulta de contagens, EPI e resumo geral.
"""

import os
import logging
import time
from typing import Optional
from datetime import date

from pathlib import Path as _Path

from fastapi import APIRouter, HTTPException, Query, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from core.auth import require_auth

import psycopg2
from psycopg2.extras import RealDictCursor

log    = logging.getLogger("suricatha.routers.analytics")
router = APIRouter(prefix="/api/v1/analytics", tags=["Analytics"])

PG_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db"
)


def _conn():
    return psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)


def _ts():
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ════════════════════════════════════════════════════════════════════════════
#  RESUMO GERAL
# ════════════════════════════════════════════════════════════════════════════

@router.get("/resumo", summary="Resumo analytics por câmera (24h)")
def analytics_resumo(auth: dict = Depends(require_auth)):
    """
    Retorna para cada câmera ativa:
    - LPR: detecções e alertas watchlist
    - Pessoas: total, pico e alertas de lotação
    - EPI: eventos e taxa de conformidade
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM analytics_resumo")
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# ════════════════════════════════════════════════════════════════════════════
#  CONTAGEM DE PESSOAS
# ════════════════════════════════════════════════════════════════════════════

@router.get("/pessoas", summary="Listagem de contagens de pessoas")
def list_contagens(
    camera_id:    Optional[int]  = Query(None),
    data_inicio:  Optional[date] = Query(None),
    data_fim:     Optional[date] = Query(None),
    apenas_alertas: bool         = Query(False, description="Somente registros com alerta de lotação"),
    limit:        int            = Query(50, ge=1, le=500),
    offset:       int            = Query(0, ge=0),
    auth: dict = Depends(require_auth),
):
    filters, params = [], []
    if camera_id:     filters.append("cp.camera_id = %s");         params.append(camera_id)
    if data_inicio:   filters.append("cp.detectado_em >= %s");     params.append(data_inicio)
    if data_fim:      filters.append("cp.detectado_em < %s");      params.append(data_fim)
    if apenas_alertas: filters.append("cp.alerta_lotacao = TRUE")

    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    conn  = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT count(*) AS n FROM contagens_pessoas cp {where}", params)
            total = cur.fetchone()["n"]
            cur.execute(f"""
                SELECT cp.*, c.nome AS camera_nome, c.local AS camera_local
                FROM contagens_pessoas cp
                LEFT JOIN cameras c ON c.id = cp.camera_id
                {where}
                ORDER BY cp.detectado_em DESC
                LIMIT %s OFFSET %s
            """, params + [limit, offset])
            rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            # Sempre gera snapshot_url — endpoint tem fallback pelo nome canônico
            # mesmo quando snapshot_path é NULL (gravado antes da correção do worker)
            if r.get("total_pessoas", 0) > 0:
                r["snapshot_url"] = f"/api/v1/analytics/pessoas/{r['id']}/snapshot"
            else:
                r["snapshot_url"] = None
        return {"total": total, "limit": limit, "offset": offset, "data": rows}
    finally:
        conn.close()


@router.get("/pessoas/{record_id}/snapshot")
def pessoas_snapshot(record_id: int):
    """Retorna o snapshot JPEG de uma contagem de pessoas (sem auth — usado por <img src>)."""
    snap_dir = _Path("/app/snapshots")
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT snapshot_path FROM contagens_pessoas WHERE id=%s", (record_id,))
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Registro não encontrado")

    snap_path: Optional[str] = row["snapshot_path"]

    # 1. Tenta o path armazenado (suporta absoluto e relativo)
    if snap_path:
        p = _Path(snap_path)
        path = p if p.is_absolute() else snap_dir / p
        if path.exists():
            return FileResponse(str(path), media_type="image/jpeg",
                                headers={"Cache-Control": "public, max-age=86400"})
        # path guardado mas arquivo movido/deletado — tenta nome canônico
        log.warning("Snapshot path guardado não encontrado: %s", snap_path)

    # 2. Fallback: nome canônico pessoas_{id}.jpg
    canonical = snap_dir / f"pessoas_{record_id}.jpg"
    if canonical.exists():
        return FileResponse(str(canonical), media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400"})

    raise HTTPException(status_code=404, detail="Snapshot não encontrado")


@router.get("/pessoas/stats", summary="Estatísticas de contagem de pessoas")
def pessoas_stats(
    camera_id: Optional[int]  = Query(None),
    dias:      int             = Query(7, ge=1, le=90),
    auth: dict = Depends(require_auth),
):
    conn  = _conn()
    cam_f = "AND camera_id = %s" if camera_id else ""
    params = []
    if camera_id: params.append(camera_id)
    params.append(dias)

    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT
                    detectado_em::date          AS dia,
                    count(*)                    AS frames,
                    sum(total_pessoas)          AS total_pessoas,
                    max(total_pessoas)          AS pico,
                    round(avg(total_pessoas),1) AS media,
                    count(*) FILTER (WHERE alerta_lotacao) AS alertas
                FROM contagens_pessoas
                WHERE detectado_em >= NOW() - (%s || ' days')::INTERVAL {cam_f}
                GROUP BY 1 ORDER BY 1 DESC
            """, [dias] + ([camera_id] if camera_id else []))
            por_dia = [dict(r) for r in cur.fetchall()]

            cur.execute(f"""
                SELECT
                    EXTRACT(HOUR FROM detectado_em)::int AS hora,
                    round(avg(total_pessoas),1)          AS media_pessoas
                FROM contagens_pessoas
                WHERE detectado_em >= NOW() - (%s || ' days')::INTERVAL {cam_f}
                GROUP BY 1 ORDER BY media_pessoas DESC
                LIMIT 5
            """, [dias] + ([camera_id] if camera_id else []))
            pico_horas = [dict(r) for r in cur.fetchall()]

        return {"periodo_dias": dias, "por_dia": por_dia, "pico_por_hora": pico_horas}
    finally:
        conn.close()


# ════════════════════════════════════════════════════════════════════════════
#  EPI / PPE
# ════════════════════════════════════════════════════════════════════════════

@router.get("/pessoas/timeline", summary="Timeline temporal de contagem de pessoas")
def pessoas_timeline(
    camera_id:       Optional[int] = Query(None),
    periodo:         str           = Query("24h", description="6h | 24h | 7d | 30d"),
    apenas_deteccoes: bool         = Query(True,  description="Considera apenas frames onde pessoas foram detectadas (>0)"),
    auth: dict = Depends(require_auth),
):
    """
    Retorna série temporal agrupada por hora (6h/24h/7d) ou dia (30d).
    Por padrão filtra apenas frames com detecções (total_pessoas > 0) para evitar
    que frames vazios contaminem as métricas de pico e média.
    """
    cfg = {
        "6h":  ("6  hours",  "hour"),
        "24h": ("24 hours",  "hour"),
        "7d":  ("7  days",   "hour"),
        "30d": ("30 days",   "day"),
    }
    if periodo not in cfg:
        periodo = "24h"
    interval_expr, trunc = cfg[periodo]

    # Filtros base (sem restrição de pessoas — sempre incluímos todos os frames para ter total real)
    base_filters = ["detectado_em >= NOW() - (%s::text || ' ')::INTERVAL"]
    params       = [interval_expr]
    if camera_id:
        base_filters.append("camera_id = %s")
        params.append(camera_id)

    where = "WHERE " + " AND ".join(base_filters)

    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT
                    date_trunc('{trunc}', detectado_em)                              AS ts,
                    count(*) FILTER (WHERE total_pessoas > 0)                        AS frames,
                    count(*)                                                          AS frames_total,
                    COALESCE(max(total_pessoas), 0)                                   AS pico,
                    COALESCE(round(
                        avg(total_pessoas) FILTER (WHERE total_pessoas > 0)::numeric, 1
                    ), 0)                                                             AS media,
                    COALESCE(sum(total_pessoas), 0)                                   AS total,
                    count(*) FILTER (WHERE alerta_lotacao)                            AS alertas
                FROM contagens_pessoas
                {where}
                GROUP BY 1
                ORDER BY 1 ASC
            """, params)
            rows = []
            for r in cur.fetchall():
                d = dict(r)
                d["ts"] = d["ts"].isoformat() if d["ts"] else None
                rows.append(d)

        pico_global = max((r["pico"] for r in rows), default=0)
        return {"periodo": periodo, "pico_global": pico_global, "data": rows}
    finally:
        conn.close()


@router.get("/epi", summary="Listagem de eventos EPI")
def list_epi(
    camera_id:       Optional[int]  = Query(None),
    data_inicio:     Optional[date] = Query(None),
    data_fim:        Optional[date] = Query(None),
    apenas_violacoes: bool          = Query(False, description="Somente registros sem conformidade"),
    apenas_deteccoes: bool          = Query(False, description="Somente registros com pessoas detectadas"),
    limit:  int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    auth: dict = Depends(require_auth),
):
    filters, params = [], []
    if camera_id:        filters.append("ee.camera_id = %s");      params.append(camera_id)
    if data_inicio:      filters.append("ee.detectado_em >= %s");  params.append(data_inicio)
    if data_fim:         filters.append("ee.detectado_em < %s");   params.append(data_fim)
    if apenas_violacoes: filters.append("ee.conformidade = FALSE")
    if apenas_deteccoes: filters.append("ee.total_pessoas > 0")

    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    conn  = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT count(*) AS n FROM eventos_epi ee {where}", params)
            total = cur.fetchone()["n"]
            cur.execute(f"""
                SELECT ee.id, ee.uuid::text, ee.camera_id,
                       c.nome AS camera_nome, c.local AS camera_local,
                       ee.total_pessoas,
                       ee.com_capacete, ee.sem_capacete,
                       ee.com_colete,   ee.sem_colete,
                       ee.conformidade, ee.percentual_conformidade,
                       ee.snapshot_path,
                       ee.tempo_processo_ms, ee.detectado_em, ee.erro
                FROM eventos_epi ee
                LEFT JOIN cameras c ON c.id = ee.camera_id
                {where}
                ORDER BY ee.detectado_em DESC
                LIMIT %s OFFSET %s
            """, params + [limit, offset])
            rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            if r.get("total_pessoas", 0) > 0:
                r["snapshot_url"] = f"/api/v1/analytics/epi/{r['id']}/snapshot"
            else:
                r["snapshot_url"] = None
        return {"total": total, "limit": limit, "offset": offset, "data": rows}
    finally:
        conn.close()


@router.get("/epi/{record_id}/snapshot")
def epi_snapshot(record_id: int):
    """Retorna o snapshot JPEG de um evento EPI (sem auth — usado por <img src>)."""
    snap_dir     = _Path("/app/snapshots")
    storage_root = _Path("/opt/suricatha/storage")
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT snapshot_path, caminho_storage, arquivo_original,
                       (detectado_em AT TIME ZONE 'UTC')::date AS dia
                FROM eventos_epi WHERE id=%s
            """, (record_id,))
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Registro não encontrado")

    _hdr = {"Cache-Control": "public, max-age=86400"}

    # 1. Snapshot anotado gerado pelo worker
    if row["snapshot_path"]:
        p = _Path(row["snapshot_path"])
        path = p if p.is_absolute() else snap_dir / p
        if path.exists():
            return FileResponse(str(path), media_type="image/jpeg", headers=_hdr)

    # 2. Nome canônico no diretório de snapshots
    canonical = snap_dir / f"epi_{record_id}.jpg"
    if canonical.exists():
        return FileResponse(str(canonical), media_type="image/jpeg", headers=_hdr)

    # 3. Arquivo original no storage (caminho completo gravado pelo worker)
    if row["caminho_storage"]:
        p = _Path(row["caminho_storage"])
        if p.exists():
            return FileResponse(str(p), media_type="image/jpeg", headers=_hdr)

    # 4. Fallback por padrão de data + arquivo_original no storage
    if row["arquivo_original"] and row["dia"]:
        for candidate in [
            storage_root / str(row["dia"]) / row["arquivo_original"],
            storage_root / str(row["dia"]) / _Path(row["arquivo_original"]).name,
        ]:
            if candidate.exists():
                return FileResponse(str(candidate), media_type="image/jpeg", headers=_hdr)

    raise HTTPException(status_code=404, detail="Snapshot não encontrado")


@router.get("/epi/timeline", summary="Timeline temporal de eventos EPI")
def epi_timeline(
    camera_id: Optional[int] = Query(None),
    periodo:   str           = Query("24h", description="6h | 24h | 7d | 30d"),
    auth: dict = Depends(require_auth),
):
    cfg = {
        "6h":  ("6  hours", "hour"),
        "24h": ("24 hours", "hour"),
        "7d":  ("7  days",  "hour"),
        "30d": ("30 days",  "day"),
    }
    if periodo not in cfg:
        periodo = "24h"
    interval_expr, trunc = cfg[periodo]

    base_filters = ["detectado_em >= NOW() - (%s::text || ' ')::INTERVAL"]
    params       = [interval_expr]
    if camera_id:
        base_filters.append("camera_id = %s")
        params.append(camera_id)
    where = "WHERE " + " AND ".join(base_filters)

    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT
                    date_trunc('{trunc}', detectado_em)                              AS ts,
                    count(*)                                                          AS total_frames,
                    count(*) FILTER (WHERE total_pessoas > 0)                        AS frames_com_pessoas,
                    count(*) FILTER (WHERE NOT conformidade)                         AS violacoes,
                    count(*) FILTER (WHERE conformidade AND total_pessoas > 0)       AS conformes,
                    COALESCE(sum(sem_capacete), 0)                                   AS sem_capacete,
                    COALESCE(sum(sem_colete), 0)                                     AS sem_colete,
                    COALESCE(round(
                        avg(percentual_conformidade) FILTER (WHERE total_pessoas > 0)::numeric, 1
                    ), 100)                                                           AS conformidade_media
                FROM eventos_epi
                {where}
                GROUP BY 1
                ORDER BY 1 ASC
            """, params)
            rows = []
            for r in cur.fetchall():
                d = dict(r)
                d["ts"] = d["ts"].isoformat() if d["ts"] else None
                rows.append(d)

        pico_violacoes = max((r["violacoes"] for r in rows), default=0)
        return {"periodo": periodo, "pico_violacoes": pico_violacoes, "data": rows}
    finally:
        conn.close()


@router.get("/epi/stats", summary="Estatísticas EPI por câmera")
def epi_stats(
    camera_id: Optional[int] = Query(None),
    dias:      int            = Query(7, ge=1, le=90),
    auth: dict = Depends(require_auth),
):
    conn  = _conn()
    cam_f = "AND camera_id = %s" if camera_id else ""

    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT
                    detectado_em::date                              AS dia,
                    count(*)                                        AS frames,
                    sum(total_pessoas)                              AS total_pessoas,
                    sum(sem_capacete)                               AS total_sem_capacete,
                    sum(sem_colete)                                 AS total_sem_colete,
                    count(*) FILTER (WHERE NOT conformidade)        AS violacoes,
                    round(avg(percentual_conformidade)::numeric, 1) AS conformidade_media
                FROM eventos_epi
                WHERE detectado_em >= NOW() - (%s || ' days')::INTERVAL {cam_f}
                GROUP BY 1 ORDER BY 1 DESC
            """, [dias] + ([camera_id] if camera_id else []))
            return {"periodo_dias": dias, "por_dia": [dict(r) for r in cur.fetchall()]}
    finally:
        conn.close()


@router.get("/alertas-lotacao", summary="Histórico de alertas de lotação")
def list_alertas_lotacao(
    camera_id: Optional[int] = None,
    limit: int = 100,
    offset: int = 0,
    auth: dict = Depends(require_auth),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            filters = []
            params: list = []
            if camera_id:
                filters.append("a.camera_id = %s")
                params.append(camera_id)
            where = ("WHERE " + " AND ".join(filters)) if filters else ""

            cur.execute(f"""
                SELECT count(*) AS n FROM alertas_lotacao a {where}
            """, params)
            total = cur.fetchone()["n"]

            cur.execute(f"""
                SELECT
                    a.id, a.camera_id, a.contagem_id,
                    a.camera_nome, a.total_pessoas, a.limite_pessoas,
                    a.confianca_media, a.snapshot_path,
                    a.notificado, a.criado_em
                FROM alertas_lotacao a
                {where}
                ORDER BY a.criado_em DESC
                LIMIT %s OFFSET %s
            """, params + [limit, offset])
            rows = cur.fetchall()

            def row_out(r):
                d = dict(r)
                if d.get("snapshot_path"):
                    d["snapshot_url"] = f"/snapshots/{d['snapshot_path']}"
                d["criado_em"] = d["criado_em"].isoformat() if d.get("criado_em") else None
                return d

            return {"total": total, "data": [row_out(r) for r in rows]}
    finally:
        conn.close()


@router.get("/alertas-epi", summary="Histórico de alertas de violação EPI")
def list_alertas_epi(
    camera_id: Optional[int] = None,
    limit: int = 100,
    offset: int = 0,
    auth: dict = Depends(require_auth),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            filters, params = [], []
            if camera_id:
                filters.append("a.camera_id = %s")
                params.append(camera_id)
            where = ("WHERE " + " AND ".join(filters)) if filters else ""
            cur.execute(f"SELECT count(*) AS n FROM alertas_epi a {where}", params)
            total = cur.fetchone()["n"]
            cur.execute(f"""
                SELECT a.id, a.camera_id, a.evento_epi_id, a.camera_nome,
                       a.total_pessoas, a.sem_capacete, a.sem_colete,
                       a.percentual_conformidade, a.snapshot_path,
                       a.notificado, a.criado_em
                FROM alertas_epi a {where}
                ORDER BY a.criado_em DESC
                LIMIT %s OFFSET %s
            """, params + [limit, offset])
            def fmt(r):
                d = dict(r)
                if d.get("snapshot_path"):
                    d["snapshot_url"] = f"/snapshots/{d['snapshot_path']}"
                d["criado_em"] = d["criado_em"].isoformat() if d.get("criado_em") else None
                return d
            return {"total": total, "data": [fmt(r) for r in cur.fetchall()]}
    finally:
        conn.close()


@router.get("/alertas-watchlist", summary="Histórico de alertas de watchlist LPR")
def list_alertas_watchlist(
    camera_id: Optional[int] = None,
    placa: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    auth: dict = Depends(require_auth),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            filters, params = [], []
            if camera_id:
                filters.append("a.camera_id = %s")
                params.append(camera_id)
            if placa:
                filters.append("a.placa ILIKE %s")
                params.append(f"%{placa}%")
            where = ("WHERE " + " AND ".join(filters)) if filters else ""
            cur.execute(f"SELECT count(*) AS n FROM alertas_watchlist a {where}", params)
            total = cur.fetchone()["n"]
            cur.execute(f"""
                SELECT a.id, a.camera_id, a.deteccao_id, a.camera_nome,
                       a.placa, a.tipo, a.prioridade, a.confianca,
                       a.crop_path, a.notificado, a.criado_em
                FROM alertas_watchlist a {where}
                ORDER BY a.criado_em DESC
                LIMIT %s OFFSET %s
            """, params + [limit, offset])
            def fmt(r):
                d = dict(r)
                if d.get("crop_path"):
                    d["crop_url"] = f"/snapshots/{d['crop_path']}"
                d["criado_em"] = d["criado_em"].isoformat() if d.get("criado_em") else None
                return d
            return {"total": total, "data": [fmt(r) for r in cur.fetchall()]}
    finally:
        conn.close()
