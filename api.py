"""
/app/api.py
SuricathaIA — API REST
FastAPI servindo o Lovable/frontend. Apenas leitura e gestão de cadastros.
O pipeline de ingestão roda separado via watchdog_service.py.
"""

import os
import json
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, date
from typing import Optional, AsyncGenerator

from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, HTTPException, Query, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response, FileResponse
from pydantic import BaseModel, Field
from core.auth import require_auth, require_role, create_token
from routers.cameras    import router as cameras_router
from routers.analytics  import router as analytics_router
from routers.telemetria import router as telemetria_router

import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2 import pool as pgpool

log = logging.getLogger("suricatha.api")

# ── Formato de log ────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[SURICATHA-LOG] %(asctime)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
for noisy in ("uvicorn.access", "httpx", "httpcore"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

# ── Connection pool ───────────────────────────────────────────────────────────
_pool: Optional[pgpool.ThreadedConnectionPool] = None

def get_pool():
    global _pool
    if _pool is None:
        _pool = pgpool.ThreadedConnectionPool(
            minconn=2, maxconn=20,
            dsn=os.getenv("POSTGRES_DSN",
                          "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db")
        )
    return _pool


def get_conn():
    pool = get_pool()
    conn = pool.getconn()
    try:
        yield conn
    finally:
        conn.rollback()
        pool.putconn(conn)


# ── SSE subscribers ───────────────────────────────────────────────────────────
_subscribers: list[asyncio.Queue] = []
_last_det_id     = 0
_last_pessoas_id = 0
_last_epi_id     = 0
_last_portaria_lpr_id = 0


async def _broadcast(event: dict):
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    get_pool()
    from services.reports import ReportScheduler
    scheduler = ReportScheduler()
    scheduler.start()
    from services.update_checker import start_daemon as _start_updater
    _updater = _start_updater()
    from services.rtsp_people_counter import start_service as _start_rtsp
    _rtsp_svc = _start_rtsp()
    from services.rtmp_stream_worker import start_service as _start_rtmp
    _rtmp_svc = _start_rtmp()
    from services.alarm_cctv import start_service as _start_alarm, register_sse_broadcast
    _alarm_svc = _start_alarm()
    # Conecta o AlarmService ao broadcast SSE existente
    import asyncio as _asyncio
    _loop = _asyncio.get_event_loop()
    def _alarm_sse_bridge(event: dict):
        async def _push():
            await _broadcast(event)
        _asyncio.run_coroutine_threadsafe(_push(), _loop)
    register_sse_broadcast(_alarm_sse_bridge)
    from services.automacoes import start_engine as _start_auto
    _auto_eng = _start_auto()
    from services.intelbras_lpr import start_service as _start_intelbras
    _intelbras_svc = _start_intelbras()
    from services.rtsp_epi_service import start_service as _start_epi_rtsp
    _epi_rtsp_svc = _start_epi_rtsp()
    from services.rtsp_telemetry_service import start_service as _start_tel, register_sse_broadcast as _reg_tel_sse
    _tel_svc = _start_tel()
    def _tel_sse_bridge(event: dict):
        async def _push():
            await _broadcast(event)
        _asyncio.run_coroutine_threadsafe(_push(), _loop)
    _reg_tel_sse(_tel_sse_bridge)
    log.info("[SURICATHA-LOG] %s - API iniciada na porta %s",
             time.strftime("%Y-%m-%d %H:%M:%S"), os.getenv("API_PORT", "8000"))
    task  = asyncio.create_task(_poll_new_deteccoes())
    task2 = asyncio.create_task(_poll_analytics_alerts())
    task3 = asyncio.create_task(_poll_portaria_lpr())
    yield
    task.cancel()
    task2.cancel()
    task3.cancel()
    scheduler.stop()
    _updater.stop()
    _rtsp_svc.stop()
    _rtmp_svc.stop()
    _alarm_svc.stop()
    _auto_eng.stop()
    _intelbras_svc.stop()
    _epi_rtsp_svc.stop()
    _tel_svc.stop()
    if _pool: _pool.closeall()
    log.info("[SURICATHA-LOG] %s - API encerrada", time.strftime("%Y-%m-%d %H:%M:%S"))


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="SuricathaIA API",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restringir para domínio Lovable em produção
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(cameras_router)
app.include_router(analytics_router)
from routers.portaria import router as portaria_router
app.include_router(portaria_router)
app.include_router(telemetria_router)


# ════════════════════════════════════════════════════════════════════════════
#  SCHEMAS
# ════════════════════════════════════════════════════════════════════════════
class WatchlistIn(BaseModel):
    placa:         str   = Field(..., min_length=7, max_length=7)
    tipo:          str   = Field("suspeito",
                            pattern="^(suspeito|roubado|bloqueado|vip|monitorado)$")
    descricao:     Optional[str] = None
    prioridade:    int   = Field(3, ge=1, le=5)
    alerta_sonoro: bool  = True


class CameraIn(BaseModel):
    # Identificação
    nome:      str           = Field(..., min_length=1, max_length=64)
    local:     str           = Field(..., min_length=1, max_length=128)
    descricao: Optional[str] = None
    observacoes: Optional[str] = None
    # Localização
    latitude:  Optional[float] = None
    longitude: Optional[float] = None
    # Hardware
    fabricante:   Optional[str] = None
    modelo:       Optional[str] = None
    numero_serie: Optional[str] = None
    # Stream
    protocolo:  str = "sftp"
    url_base:   Optional[str] = None
    url_stream: Optional[str] = None
    resolucao:  Optional[str] = "1080p"
    fps:        Optional[int] = 15
    # SFTP
    ip_sftp:          Optional[str] = None
    porta_sftp:       Optional[int] = 22
    usuario_sftp:     Optional[str] = None
    pasta_upload:     Optional[str] = None
    prefixo_arquivo:  Optional[str] = None
    faixa_horaria:    Optional[str] = "00:00-23:59"
    # Pillar LPR
    rec_lpr:              bool = True
    rec_deteccao_unica:   bool = False
    janela_dedup_seg:     Optional[int] = 60
    intervalo_captura_seg: Optional[int] = 0
    tipo:    str = "lpr"
    sentido: str = "ambos"
    # Pillar EPI
    rec_epi:        bool = False
    zona_interesse: Optional[str] = None
    # Pillar Contagem
    rec_contagem_pessoas: bool = False
    limite_pessoas:       Optional[int] = None
    # Credenciais HTTP da câmera (API nativa Intelbras/Hikvision)
    usuario_camera: Optional[str] = None
    senha_camera:   Optional[str] = None
    porta_http:     Optional[int] = 80
    https_camera:   Optional[bool] = False


# ════════════════════════════════════════════════════════════════════════════
#  HEALTH
# ════════════════════════════════════════════════════════════════════════════
@app.get("/health", tags=["Sistema"])
def health(conn=Depends(get_conn)):
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT
            count(*) AS total_deteccoes,
            count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'1h') AS ultima_hora
        FROM deteccoes
    """)
    stats = dict(cur.fetchone())
    return {"status": "online", "timestamp": datetime.utcnow().isoformat(),
            "version": "2.0.0", "total_deteccoes": stats["total_deteccoes"],
            "ultima_hora": stats["ultima_hora"]}


# ════════════════════════════════════════════════════════════════════════════
#  DETECÇÕES
# ════════════════════════════════════════════════════════════════════════════
@app.get("/api/v1/deteccoes", tags=["Detecções"])
def list_deteccoes(
    limit:             int            = Query(20, ge=1, le=200),
    offset:            int            = Query(0, ge=0),
    placa:             Optional[str]  = Query(None),
    camera_id:         Optional[int]  = Query(None),
    watchlist_hit:     Optional[bool] = Query(None),
    validado:          Optional[bool] = Query(None),
    data_inicio:       Optional[date] = Query(None),
    data_fim:          Optional[date] = Query(None),
    confianca_minima:  Optional[float] = Query(None, ge=0.0, le=1.0, description="Confiança mínima (0.0–1.0)"),
    apenas_com_placa:  Optional[bool]  = Query(None, description="Exibe só registros com placa identificada"),
    fonte:             Optional[str]   = Query(None, description="Origem: sftp_pillar | sftp_legado | reprocessamento"),
    conn=Depends(get_conn),
):
    filters, params = [], []
    if placa:             filters.append("d.placa ILIKE %s");          params.append(f"%{placa.upper()}%")
    if camera_id:         filters.append("d.camera_id = %s");          params.append(camera_id)
    if watchlist_hit is not None: filters.append("d.watchlist_hit = %s"); params.append(watchlist_hit)
    if validado is not None:      filters.append("d.validado = %s");      params.append(validado)
    if data_inicio:       filters.append("d.detectado_em >= %s");     params.append(data_inicio)
    if data_fim:          filters.append("d.detectado_em < %s");      params.append(data_fim)
    if confianca_minima is not None:
        filters.append("d.confianca_final >= %s");                     params.append(confianca_minima)
    if apenas_com_placa:
        filters.append("d.placa IS NOT NULL AND d.placa != ''")
    if fonte:
        filters.append("d.fonte = %s");                                params.append(fonte)

    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    cur   = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"SELECT count(*) AS n FROM deteccoes d {where}", params)
    total = cur.fetchone()["n"]

    cur.execute(f"""
        SELECT d.id, d.uuid::text, d.camera_id, c.nome AS camera_nome,
               d.placa, d.confianca_final, d.validado, d.divergencia,
               d.watchlist_hit, w.tipo AS watchlist_tipo,
               d.arquivo_original, d.caminho_storage, d.crop_url,
               d.tempo_processo_ms, d.detectado_em, d.erro, d.fonte
        FROM deteccoes d
        LEFT JOIN cameras   c ON c.id = d.camera_id
        LEFT JOIN watchlist w ON w.id = d.watchlist_id
        {where}
        ORDER BY d.detectado_em DESC
        LIMIT %s OFFSET %s
    """, params + [limit, offset])

    return {"total": total, "limit": limit, "offset": offset,
            "data": [dict(r) for r in cur.fetchall()]}


@app.get("/api/v1/deteccoes/stats", tags=["Detecções"])
def deteccoes_stats(conn=Depends(get_conn)):
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT
            count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'24h')  AS total_24h,
            count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'1h')   AS total_1h,
            count(*) FILTER (WHERE validado AND detectado_em >= NOW()-INTERVAL'24h') AS validadas_24h,
            count(*) FILTER (WHERE watchlist_hit AND detectado_em >= NOW()-INTERVAL'24h') AS watchlist_hits_24h,
            count(*) FILTER (WHERE divergencia AND detectado_em >= NOW()-INTERVAL'24h') AS divergencias_24h,
            avg(tempo_processo_ms) FILTER
                (WHERE detectado_em >= NOW()-INTERVAL'24h')::int AS tempo_medio_ms
        FROM deteccoes
    """)
    return {k: (v or 0) for k, v in cur.fetchone().items()}


@app.get("/api/v1/deteccoes/timeline", tags=["Detecções"])
def deteccoes_timeline(
    periodo:   str           = Query("24h", description="6h | 24h | 7d | 30d"),
    camera_id: Optional[int] = Query(None),
    conn=Depends(get_conn),
):
    """Série temporal de leituras LPR agrupadas por hora/dia."""
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
    params: list = [interval_expr]
    if camera_id:
        base_filters.append("camera_id = %s")
        params.append(camera_id)
    where = "WHERE " + " AND ".join(base_filters)

    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(f"""
        SELECT
            date_trunc('{trunc}', detectado_em)                             AS ts,
            count(*)                                                         AS total,
            count(*) FILTER (WHERE placa IS NOT NULL AND placa != '')        AS com_placa,
            count(*) FILTER (WHERE watchlist_hit)                            AS watchlist,
            count(*) FILTER (WHERE validado)                                 AS validadas,
            count(*) FILTER (WHERE divergencia)                              AS divergencias,
            COALESCE(round(
                avg(confianca_final) FILTER (WHERE confianca_final IS NOT NULL)::numeric * 100, 1
            ), 0)                                                            AS confianca_media
        FROM deteccoes
        {where}
        GROUP BY 1
        ORDER BY 1 ASC
    """, params)
    rows = []
    for r in cur.fetchall():
        d = dict(r)
        d["ts"] = d["ts"].isoformat() if d["ts"] else None
        rows.append(d)

    pico_leituras = max((r["com_placa"] for r in rows), default=0)
    return {"periodo": periodo, "pico_leituras": pico_leituras, "data": rows}


@app.get("/api/v1/deteccoes/{det_id}", tags=["Detecções"])
def get_deteccao(det_id: int, conn=Depends(get_conn)):
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT d.*, d.uuid::text, c.nome AS camera_nome, w.tipo AS watchlist_tipo
        FROM deteccoes d
        LEFT JOIN cameras   c ON c.id = d.camera_id
        LEFT JOIN watchlist w ON w.id = d.watchlist_id
        WHERE d.id = %s
    """, (det_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Detecção não encontrada")
    return dict(row)


# ════════════════════════════════════════════════════════════════════════════
#  CÂMERAS — rotas gerenciadas por routers/cameras.py (include_router l.124)
# ════════════════════════════════════════════════════════════════════════════




# ════════════════════════════════════════════════════════════════════════════
#  WATCHLIST
# ════════════════════════════════════════════════════════════════════════════
@app.get("/api/v1/watchlist", tags=["Watchlist"])
def list_watchlist(
    ativa: Optional[bool] = Query(True),
    tipo:  Optional[str]  = Query(None),
    conn=Depends(get_conn),
):
    cur = conn.cursor(cursor_factory=RealDictCursor)
    filters, params = [], []
    if ativa is not None: filters.append("ativa = %s");  params.append(ativa)
    if tipo:              filters.append("tipo = %s");    params.append(tipo)
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    cur.execute(f"""
        SELECT id, uuid::text, placa, tipo, descricao,
               prioridade, ativa, alerta_sonoro, criado_em
        FROM watchlist {where} ORDER BY prioridade DESC, placa
    """, params)
    return [dict(r) for r in cur.fetchall()]


@app.post("/api/v1/watchlist", status_code=201, tags=["Watchlist"])
def add_watchlist(body: WatchlistIn, conn=Depends(get_conn)):
    placa = body.placa.upper().strip()
    cur   = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        INSERT INTO watchlist (placa, tipo, descricao, prioridade, alerta_sonoro)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (placa) DO UPDATE SET
            tipo=EXCLUDED.tipo, descricao=EXCLUDED.descricao,
            prioridade=EXCLUDED.prioridade, ativa=TRUE
        RETURNING id, uuid::text, placa, tipo, descricao,
                  prioridade, ativa, alerta_sonoro, criado_em
    """, (placa, body.tipo, body.descricao, body.prioridade, body.alerta_sonoro))
    conn.commit()
    log.info("[SURICATHA-LOG] %s - Watchlist add: %s tipo=%s",
             time.strftime("%Y-%m-%d %H:%M:%S"), placa, body.tipo)
    return dict(cur.fetchone())


@app.delete("/api/v1/watchlist/{placa}", status_code=204, tags=["Watchlist"])
def remove_watchlist(placa: str, conn=Depends(get_conn)):
    cur = conn.cursor()
    cur.execute("UPDATE watchlist SET ativa=FALSE WHERE placa=%s", (placa.upper(),))
    if cur.rowcount == 0:
        raise HTTPException(404, "Placa não encontrada na watchlist")
    conn.commit()


# ════════════════════════════════════════════════════════════════════════════
#  SSE — Server-Sent Events
# ════════════════════════════════════════════════════════════════════════════
@app.get("/api/v1/stream", tags=["Real-time"])
async def sse_stream(request: Request):
    """
    Eventos em tempo real para o Lovable.
    Uso no frontend:
        const es = new EventSource('http://<VPS>:8000/api/v1/stream')
        es.onmessage = e => console.log(JSON.parse(e.data))
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.append(queue)

    async def gen() -> AsyncGenerator[str, None]:
        yield 'data: {"type":"connected"}\n\n'
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = queue.get_nowait()
                    yield f"data: {json.dumps(event, default=str)}\n\n"
                except asyncio.QueueEmpty:
                    yield ": ping\n\n"
                    await asyncio.sleep(15)
        finally:
            _subscribers.remove(queue)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


async def _poll_new_deteccoes():
    """Poll banco a cada 2s e broadcast via SSE."""
    global _last_det_id
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT COALESCE(MAX(id),0) AS n FROM deteccoes")
            _last_det_id = cur.fetchone()["n"]
    finally:
        pool.putconn(conn)

    # Ponteiro separado para nova_leitura (todas as detecções, não só placas lidas)
    _last_any_id = _last_det_id

    while True:
        await asyncio.sleep(2)
        if not _subscribers:
            continue
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # ── 1. Alertas de placa (alta confiança) — para Dashboard/notificações
                cur.execute("""
                    SELECT d.id, d.placa, d.confianca_final, d.validado,
                           d.watchlist_hit, d.detectado_em,
                           c.nome AS camera
                    FROM deteccoes d
                    LEFT JOIN cameras c ON c.id = d.camera_id
                    WHERE d.id > %s
                      AND d.placa IS NOT NULL AND d.placa != ''
                      AND d.confianca_final >= 0.80
                    ORDER BY d.id ASC LIMIT 50
                """, (_last_det_id,))
                for row in cur.fetchall():
                    _last_det_id = max(_last_det_id, row["id"])
                    await _broadcast({
                        "type":          "deteccao",
                        "id":            row["id"],
                        "placa":         row["placa"],
                        "confianca":     row["confianca_final"],
                        "validado":      row["validado"],
                        "watchlist_hit": row["watchlist_hit"],
                        "camera":        row["camera"],
                        "detectado_em":  row["detectado_em"].isoformat()
                                         if row["detectado_em"] else None,
                    })

                # ── 2. Nova leitura (todas) — live feed dashboard + sync LPR page
                cur.execute("""
                    SELECT d.id, d.camera_id, d.placa, d.confianca_final,
                           d.validado, d.watchlist_hit, d.divergencia,
                           d.caminho_storage, d.crop_url,
                           c.nome AS camera, c.beep_lpr, d.detectado_em
                    FROM deteccoes d
                    LEFT JOIN cameras c ON c.id = d.camera_id
                    WHERE d.id > %s
                    ORDER BY d.id ASC LIMIT 50
                """, (_last_any_id,))
                rows_any = cur.fetchall()
                if rows_any:
                    _last_any_id = max(r["id"] for r in rows_any)
                    for row in rows_any:
                        await _broadcast({
                            "type":            "nova_leitura",
                            "id":              row["id"],
                            "camera_id":       row["camera_id"],
                            "placa":           row["placa"],
                            "confianca":       row["confianca_final"],
                            "validado":        row["validado"],
                            "watchlist_hit":   row["watchlist_hit"],
                            "divergencia":     row["divergencia"],
                            "caminho_storage": row["caminho_storage"],
                            "crop_url":        row["crop_url"],
                            "camera":          row["camera"],
                            "beep_lpr":        bool(row["beep_lpr"]) if row["beep_lpr"] is not None else False,
                            "detectado_em":    row["detectado_em"].isoformat()
                                               if row["detectado_em"] else None,
                        })
        except Exception as exc:
            log.warning("[SURICATHA-LOG] %s - SSE poll erro: %s",
                        time.strftime("%Y-%m-%d %H:%M:%S"), exc)
        finally:
            pool.putconn(conn)


async def _poll_analytics_alerts():
    """Poll banco a cada 5s — broadcast SSE para alerta_lotacao e epi_violacao."""
    global _last_pessoas_id, _last_epi_id
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT COALESCE(MAX(id),0) AS n FROM contagens_pessoas")
            _last_pessoas_id = cur.fetchone()["n"]
            cur.execute("SELECT COALESCE(MAX(id),0) AS n FROM eventos_epi")
            _last_epi_id = cur.fetchone()["n"]
    except Exception:
        pass
    finally:
        pool.putconn(conn)

    while True:
        await asyncio.sleep(5)
        if not _subscribers:
            continue
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT cp.id, cp.camera_id, cp.total_pessoas,
                           cp.alerta_lotacao, cp.snapshot_path, cp.detectado_em,
                           c.nome AS camera, c.limite_pessoas
                    FROM contagens_pessoas cp
                    LEFT JOIN cameras c ON c.id = cp.camera_id
                    WHERE cp.id > %s AND cp.alerta_lotacao = TRUE
                    ORDER BY cp.id ASC LIMIT 20
                """, (_last_pessoas_id,))
                for row in cur.fetchall():
                    _last_pessoas_id = max(_last_pessoas_id, row["id"])
                    await _broadcast({
                        "type":        "alerta_lotacao",
                        "id":          row["id"],
                        "camera_id":   row["camera_id"],
                        "camera":      row["camera"],
                        "total":       row["total_pessoas"],
                        "limite":      row["limite_pessoas"],
                        "snapshot":    row["snapshot_path"],
                        "criado_em":   row["detectado_em"].isoformat() if row["detectado_em"] else None,
                    })

                cur.execute("""
                    SELECT ev.id, ev.camera_id, ev.total_pessoas,
                           ev.sem_capacete, ev.sem_colete,
                           ev.percentual_conformidade, ev.snapshot_path, ev.detectado_em,
                           c.nome AS camera
                    FROM eventos_epi ev
                    LEFT JOIN cameras c ON c.id = ev.camera_id
                    WHERE ev.id > %s AND ev.conformidade = FALSE
                    ORDER BY ev.id ASC LIMIT 20
                """, (_last_epi_id,))
                for row in cur.fetchall():
                    _last_epi_id = max(_last_epi_id, row["id"])
                    await _broadcast({
                        "type":         "epi_violacao",
                        "id":           row["id"],
                        "camera_id":    row["camera_id"],
                        "camera":       row["camera"],
                        "total":        row["total_pessoas"],
                        "sem_capacete": row["sem_capacete"],
                        "sem_colete":   row["sem_colete"],
                        "pct_conf":     float(row["percentual_conformidade"] or 0),
                        "snapshot":     row["snapshot_path"],
                        "criado_em":    row["detectado_em"].isoformat() if row["detectado_em"] else None,
                    })
        except Exception as exc:
            log.warning("[SURICATHA-LOG] %s - SSE analytics poll erro: %s",
                        time.strftime("%Y-%m-%d %H:%M:%S"), exc)
        finally:
            pool.putconn(conn)


async def _poll_portaria_lpr():
    """
    Monitora novas detecções LPR e emite SSE para:
    - 'portaria_sugestao'    : placa detectada coincide com visita agendada/aguardando
    - 'portaria_nao_agendado': placa detectada sem visita ativa correspondente
    """
    global _last_portaria_lpr_id
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT COALESCE(MAX(id),0) AS n FROM deteccoes")
            _last_portaria_lpr_id = cur.fetchone()["n"]
            # Verifica se tabelas de portaria existem
            cur.execute("""
                SELECT 1 FROM information_schema.tables
                WHERE table_name='visitas' LIMIT 1
            """)
            _portaria_ok = cur.fetchone() is not None
    except Exception:
        _portaria_ok = False
    finally:
        pool.putconn(conn)

    if not _portaria_ok:
        return

    while True:
        await asyncio.sleep(4)
        if not _subscribers:
            continue
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT d.id, d.placa, d.detectado_em, c.nome AS camera, c.local AS camera_local
                    FROM deteccoes d
                    LEFT JOIN cameras c ON c.id = d.camera_id
                    WHERE d.id > %s AND d.placa IS NOT NULL
                    ORDER BY d.id ASC LIMIT 30
                """, (_last_portaria_lpr_id,))
                novas = cur.fetchall()
                if not novas:
                    continue
                _last_portaria_lpr_id = max(r["id"] for r in novas)

                for det in novas:
                    placa = det["placa"]
                    # Verifica visita agendada/aguardando com esta placa
                    cur.execute("""
                        SELECT v.id, v.status, vi.nome AS visitante_nome,
                               vi.empresa, a.nome AS anfitriao_nome, a.ramal
                        FROM visitas v
                        JOIN visitantes vi ON vi.id = v.visitante_id
                        LEFT JOIN anfitrioes a ON a.id = v.anfitriao_id
                        WHERE v.placa_veiculo = %s
                          AND v.status IN ('agendado','aguardando')
                        LIMIT 1
                    """, (placa,))
                    visita = cur.fetchone()

                    if visita:
                        await _broadcast({
                            "type":           "portaria_sugestao",
                            "placa":          placa,
                            "camera":         det["camera"],
                            "camera_local":   det["camera_local"],
                            "lpr_id":         det["id"],
                            "detectado_em":   det["detectado_em"].isoformat(),
                            "visita_id":      visita["id"],
                            "visita_status":  visita["status"],
                            "visitante_nome": visita["visitante_nome"],
                            "empresa":        visita["empresa"],
                            "anfitriao_nome": visita["anfitriao_nome"],
                            "anfitriao_ramal":visita["ramal"],
                        })
                    else:
                        # Verifica se não há visita ativa (para não spammar)
                        cur.execute("""
                            SELECT 1 FROM visitas
                            WHERE placa_veiculo=%s AND status='em_visita'
                            LIMIT 1
                        """, (placa,))
                        if not cur.fetchone():
                            await _broadcast({
                                "type":         "portaria_nao_agendado",
                                "placa":        placa,
                                "camera":       det["camera"],
                                "camera_local": det["camera_local"],
                                "lpr_id":       det["id"],
                                "detectado_em": det["detectado_em"].isoformat(),
                            })
        except Exception as exc:
            log.warning("[SURICATHA-LOG] %s - SSE portaria poll erro: %s",
                        time.strftime("%Y-%m-%d %H:%M:%S"), exc)
        finally:
            pool.putconn(conn)


# ════════════════════════════════════════════════════════════════════════════
#  AUTH — login por usuário/senha + API Key
# ════════════════════════════════════════════════════════════════════════════
class TokenRequest(BaseModel):
    api_key: str

class LoginRequest(BaseModel):
    email: str
    senha: str

@app.post("/api/v1/token", tags=["Auth"])
def issue_token(body: TokenRequest):
    """Troca uma API Key por JWT Bearer."""
    valid = {k.strip() for k in os.getenv("API_KEYS","").split(",") if k.strip()}
    if body.api_key not in valid:
        raise HTTPException(status_code=401, detail="API Key inválida")
    token = create_token(subject="api_key", extra={"role": "admin"})
    return {"access_token": token, "token_type": "bearer"}


@app.post("/api/v1/auth/login", tags=["Auth"])
def login(body: LoginRequest, conn=Depends(get_conn)):
    """Login por e-mail e senha. Retorna JWT Bearer."""
    import bcrypt as _bcrypt
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(
        "SELECT id, uuid::text, nome, email, senha_hash, perfil, avatar FROM operadores WHERE email=%s AND ativo",
        (body.email.lower().strip(),)
    )
    op = cur.fetchone()
    if not op:
        raise HTTPException(status_code=401, detail="Credenciais inválidas")
    try:
        ok = _bcrypt.checkpw(body.senha.encode(), op["senha_hash"].encode())
    except Exception:
        ok = False
    if not ok:
        raise HTTPException(status_code=401, detail="Credenciais inválidas")

    # Registra último login
    cur.execute("UPDATE operadores SET ultimo_login=NOW() WHERE id=%s", (op["id"],))
    conn.commit()

    token = create_token(
        subject=op["email"],
        extra={"role": op["perfil"], "nome": op["nome"], "op_id": op["id"]}
    )
    log.info("[SURICATHA-LOG] %s - Login: %s (%s)",
             time.strftime("%Y-%m-%d %H:%M:%S"), op["email"], op["perfil"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "operador": {"nome": op["nome"], "email": op["email"], "perfil": op["perfil"], "avatar": op.get("avatar")},
    }


@app.get("/api/v1/auth/me", tags=["Auth"])
def me(auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Retorna dados completos do operador autenticado."""
    if auth.get("type") == "api_key":
        return {"nome": "API Key", "email": "—", "perfil": "admin"}
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(
        """SELECT id, nome, email, perfil, ultimo_login,
                  whatsapp, telegram, cargo, departamento, avatar
           FROM operadores WHERE email=%s""",
        (auth.get("sub"),)
    )
    op = cur.fetchone()
    if not op:
        return {"nome": auth.get("sub"), "email": auth.get("sub"), "perfil": auth.get("role","operador")}
    return dict(op)


class MeUpdate(BaseModel):
    nome:         Optional[str] = None
    whatsapp:     Optional[str] = None
    telegram:     Optional[str] = None
    cargo:        Optional[str] = None
    departamento: Optional[str] = None
    senha_atual:  Optional[str] = None
    nova_senha:   Optional[str] = None

@app.patch("/api/v1/auth/me", tags=["Auth"])
def update_me(body: MeUpdate, auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Atualiza dados do operador autenticado. E-mail e perfil não podem ser alterados."""
    if auth.get("type") == "api_key":
        raise HTTPException(400, "API Key não pode alterar perfil")
    import bcrypt as _bc
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(
        "SELECT id, nome, email, perfil, senha_hash FROM operadores WHERE email=%s",
        (auth.get("sub"),)
    )
    op = cur.fetchone()
    if not op:
        raise HTTPException(404, "Usuário não encontrado")

    fields, vals = [], []

    if body.nome is not None:
        if len(body.nome.strip()) < 2:
            raise HTTPException(422, "Nome deve ter ao menos 2 caracteres")
        fields.append("nome=%s"); vals.append(body.nome.strip())

    for field in ("whatsapp", "telegram", "cargo", "departamento"):
        val = getattr(body, field)
        if val is not None:
            fields.append(f"{field}=%s"); vals.append(val.strip() or None)

    if body.nova_senha is not None:
        if not body.senha_atual:
            raise HTTPException(422, "Informe a senha atual para alterá-la")
        if not _bc.checkpw(body.senha_atual.encode(), op["senha_hash"].encode()):
            raise HTTPException(401, "Senha atual incorreta")
        if len(body.nova_senha) < 6:
            raise HTTPException(422, "Nova senha deve ter ao mínimo 6 caracteres")
        h = _bc.hashpw(body.nova_senha.encode(), _bc.gensalt(12)).decode()
        fields.append("senha_hash=%s"); vals.append(h)

    if not fields:
        raise HTTPException(422, "Nenhum campo para atualizar")

    vals.append(op["id"])
    cur.execute(
        f"""UPDATE operadores SET {', '.join(fields)} WHERE id=%s
            RETURNING id, nome, email, perfil, whatsapp, telegram, cargo, departamento""",
        vals
    )
    updated = dict(cur.fetchone())
    conn.commit()
    log.info("[SURICATHA-LOG] %s atualizou próprio perfil", op["email"])
    return updated


# ════════════════════════════════════════════════════════════════════════════
#  GESTÃO DE USUÁRIOS — CRUD completo (apenas admin)
# ════════════════════════════════════════════════════════════════════════════

_require_admin = Depends(require_role("admin"))

class UsuarioCreate(BaseModel):
    nome:         str
    email:        str
    senha:        str
    perfil:       str = "operador"
    ativo:        bool = True
    whatsapp:     Optional[str] = None
    telegram:     Optional[str] = None
    cargo:        Optional[str] = None
    departamento: Optional[str] = None

class UsuarioUpdate(BaseModel):
    nome:         Optional[str]  = None
    email:        Optional[str]  = None
    perfil:       Optional[str]  = None
    ativo:        Optional[bool] = None
    whatsapp:     Optional[str]  = None
    telegram:     Optional[str]  = None
    cargo:        Optional[str]  = None
    departamento: Optional[str]  = None

class SenhaReset(BaseModel):
    nova_senha: str

_USER_COLS = "id, uuid::text, nome, email, perfil, ativo, ultimo_login, criado_em, whatsapp, telegram, cargo, departamento, avatar"

@app.get("/api/v1/usuarios", tags=["Usuários"])
def listar_usuarios(
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Lista todos os operadores. Apenas admin."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(f"SELECT {_USER_COLS} FROM operadores ORDER BY criado_em DESC")
    return cur.fetchall()


@app.post("/api/v1/usuarios", tags=["Usuários"], status_code=201)
def criar_usuario(
    body: UsuarioCreate,
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Cria novo operador. Apenas admin."""
    if body.perfil not in ("admin", "gerente", "operador", "viewer"):
        raise HTTPException(422, "Perfil inválido. Use: admin, gerente, operador ou viewer")
    import bcrypt as _bc
    h = _bc.hashpw(body.senha.encode(), _bc.gensalt(12)).decode()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute(f"""
            INSERT INTO operadores (nome, email, senha_hash, perfil, ativo, whatsapp, telegram, cargo, departamento)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_USER_COLS}
        """, (
            body.nome.strip(), body.email.lower().strip(), h, body.perfil, body.ativo,
            body.whatsapp or None, body.telegram or None,
            body.cargo or None, body.departamento or None,
        ))
        op = dict(cur.fetchone())
        conn.commit()
        log.info("[SURICATHA-LOG] Admin %s criou usuário %s (%s)",
                 auth.get("sub"), op["email"], op["perfil"])
        return op
    except Exception:
        conn.rollback()
        raise HTTPException(409, "E-mail já cadastrado")


@app.patch("/api/v1/usuarios/{uid}", tags=["Usuários"])
def atualizar_usuario(
    uid: int,
    body: UsuarioUpdate,
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Atualiza dados do operador. Apenas admin."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT id, email FROM operadores WHERE id=%s", (uid,))
    op = cur.fetchone()
    if not op:
        raise HTTPException(404, "Usuário não encontrado")

    fields, vals = [], []
    if body.nome   is not None: fields.append("nome=%s");  vals.append(body.nome.strip())
    if body.email  is not None: fields.append("email=%s"); vals.append(body.email.lower().strip())
    if body.perfil is not None:
        if body.perfil not in ("admin", "gerente", "operador", "viewer"):
            raise HTTPException(422, "Perfil inválido")
        fields.append("perfil=%s"); vals.append(body.perfil)
    if body.ativo  is not None: fields.append("ativo=%s"); vals.append(body.ativo)
    for f in ("whatsapp", "telegram", "cargo", "departamento"):
        v = getattr(body, f)
        if v is not None:
            fields.append(f"{f}=%s"); vals.append(v.strip() or None)
    if not fields:
        raise HTTPException(422, "Nenhum campo para atualizar")

    vals.append(uid)
    try:
        cur.execute(f"UPDATE operadores SET {', '.join(fields)} WHERE id=%s RETURNING {_USER_COLS}", vals)
        updated = dict(cur.fetchone())
        conn.commit()
        return updated
    except Exception:
        conn.rollback()
        raise HTTPException(409, "E-mail já cadastrado")


@app.delete("/api/v1/usuarios/{uid}", tags=["Usuários"], status_code=204)
def excluir_usuario(
    uid: int,
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Remove operador permanentemente. Apenas admin."""
    # Impede auto-exclusão
    if auth.get("op_id") == uid:
        raise HTTPException(400, "Você não pode excluir seu próprio usuário")
    cur = conn.cursor()
    cur.execute("DELETE FROM operadores WHERE id=%s", (uid,))
    if cur.rowcount == 0:
        raise HTTPException(404, "Usuário não encontrado")
    conn.commit()


@app.post("/api/v1/usuarios/{uid}/reset-senha", tags=["Usuários"])
def reset_senha(
    uid: int,
    body: SenhaReset,
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Redefine a senha de um operador. Apenas admin."""
    if len(body.nova_senha) < 6:
        raise HTTPException(422, "Senha deve ter no mínimo 6 caracteres")
    import bcrypt as _bc
    h = _bc.hashpw(body.nova_senha.encode(), _bc.gensalt(12)).decode()
    cur = conn.cursor()
    cur.execute("UPDATE operadores SET senha_hash=%s WHERE id=%s", (h, uid))
    if cur.rowcount == 0:
        raise HTTPException(404, "Usuário não encontrado")
    conn.commit()
    return {"ok": True}


class AvatarBody(BaseModel):
    avatar: Optional[str] = None  # base64 data URL or null to remove

@app.put("/api/v1/usuarios/{uid}/avatar", tags=["Usuários"])
def set_avatar(
    uid: int,
    body: AvatarBody,
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Define ou remove o avatar de um operador. Apenas admin."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("UPDATE operadores SET avatar=%s WHERE id=%s RETURNING id", (body.avatar, uid))
    if cur.rowcount == 0:
        raise HTTPException(404, "Usuário não encontrado")
    conn.commit()
    return {"ok": True}

@app.put("/api/v1/auth/me/avatar", tags=["Auth"])
def set_my_avatar(
    body: AvatarBody,
    auth: dict = Depends(require_auth),
    conn=Depends(get_conn),
):
    """Atualiza o avatar do operador autenticado."""
    if auth.get("type") == "api_key":
        raise HTTPException(400, "API keys não suportam avatar")
    cur = conn.cursor()
    cur.execute("UPDATE operadores SET avatar=%s WHERE email=%s", (body.avatar, auth.get("sub")))
    conn.commit()
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════════════
#  ALERTAS — agregação em tempo real
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/v1/alerts", tags=["Alertas"])
def list_alerts(auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """
    Agrega alertas em tempo real de todas as fontes:
    câmeras offline, watchlist hits, erros LPR, saúde do sistema,
    alertas de lotação, disco cheio, fila travada, modelos ausentes.
    """
    import shutil as _shutil, pathlib as _pathlib, time as _time
    cur  = conn.cursor(cursor_factory=RealDictCursor)
    now  = datetime.utcnow().isoformat() + "Z"
    alts = []

    # ── 1. Câmeras offline ────────────────────────────────────────────────────
    cur.execute("""
        SELECT id, nome, local, status_conexao, ultima_conexao
        FROM cameras
        WHERE ativa = TRUE AND status_conexao IN ('offline','erro')
        ORDER BY ultima_conexao ASC NULLS FIRST
    """)
    for c in cur.fetchall():
        alts.append({
            "id"         : f"cam_offline_{c['id']}",
            "tipo"       : "camera_offline",
            "severidade" : "critico",
            "titulo"     : "Câmera offline",
            "mensagem"   : f"{c['nome']} ({c['local']}) está {c['status_conexao']}",
            "contexto"   : {"camera_id": c["id"], "nome": c["nome"], "link": "/cameras"},
            "ts"         : c["ultima_conexao"].isoformat() + "Z" if c["ultima_conexao"] else now,
        })

    # ── 2. Câmeras sem check recente (> 10 min) ───────────────────────────────
    cur.execute("""
        SELECT id, nome, local, ultima_conexao
        FROM cameras
        WHERE ativa = TRUE
          AND status_conexao = 'desconhecida'
          AND (ultima_conexao IS NULL OR ultima_conexao < NOW() - INTERVAL '10 minutes')
        ORDER BY id
    """)
    for c in cur.fetchall():
        alts.append({
            "id"         : f"cam_nocheck_{c['id']}",
            "tipo"       : "camera_sem_check",
            "severidade" : "aviso",
            "titulo"     : "Câmera sem verificação",
            "mensagem"   : f"{c['nome']} ({c['local']}) sem resposta há mais de 10 min",
            "contexto"   : {"camera_id": c["id"], "nome": c["nome"], "link": "/cameras"},
            "ts"         : c["ultima_conexao"].isoformat() + "Z" if c["ultima_conexao"] else now,
        })

    # ── 3. Watchlist hits (última 1h) ────────────────────────────────────────
    cur.execute("""
        SELECT d.id, d.placa, d.confianca_final, d.detectado_em,
               c.nome AS camera_nome
        FROM deteccoes d
        LEFT JOIN cameras c ON c.id = d.camera_id
        WHERE d.watchlist_hit = TRUE
          AND d.detectado_em >= NOW() - INTERVAL '1 hour'
        ORDER BY d.detectado_em DESC
        LIMIT 10
    """)
    hits = cur.fetchall()
    if hits:
        alts.append({
            "id"         : f"watchlist_hits_{hits[0]['id']}",
            "tipo"       : "watchlist_hit",
            "severidade" : "critico",
            "titulo"     : f"Placa monitorada detectada",
            "mensagem"   : f"{len(hits)} alerta(s) da watchlist na última hora — última: {hits[0]['placa']} em {hits[0]['camera_nome'] or 'câmera desconhecida'}",
            "contexto"   : {"count": len(hits), "link": "/deteccoes"},
            "ts"         : hits[0]["detectado_em"].isoformat() + "Z",
        })

    # ── 4. Erros de leitura LPR (última 1h) ──────────────────────────────────
    cur.execute("""
        SELECT count(*) AS n,
               max(detectado_em) AS ultima
        FROM deteccoes
        WHERE erro IS NOT NULL
          AND detectado_em >= NOW() - INTERVAL '1 hour'
    """)
    row = cur.fetchone()
    if row and row["n"] > 0:
        alts.append({
            "id"         : "lpr_errors",
            "tipo"       : "erro_lpr",
            "severidade" : "aviso",
            "titulo"     : "Erros de leitura LPR",
            "mensagem"   : f"{row['n']} leitura(s) com erro na última hora",
            "contexto"   : {"count": int(row["n"]), "link": "/deteccoes"},
            "ts"         : row["ultima"].isoformat() + "Z" if row["ultima"] else now,
        })

    # ── 5. Alertas de lotação (última 1h) ────────────────────────────────────
    cur.execute("""
        SELECT count(*) AS n, max(cp.detectado_em) AS ultima,
               c.nome AS camera_nome
        FROM contagens_pessoas cp
        LEFT JOIN cameras c ON c.id = cp.camera_id
        WHERE cp.alerta_lotacao = TRUE
          AND cp.detectado_em >= NOW() - INTERVAL '1 hour'
        GROUP BY c.nome
        ORDER BY n DESC
        LIMIT 5
    """)
    for row in cur.fetchall():
        alts.append({
            "id"         : f"lotacao_{row['camera_nome']}",
            "tipo"       : "alerta_lotacao",
            "severidade" : "aviso",
            "titulo"     : "Alerta de lotação",
            "mensagem"   : f"{row['camera_nome']}: {row['n']} alerta(s) de lotação na última hora",
            "contexto"   : {"link": "/pessoas"},
            "ts"         : row["ultima"].isoformat() + "Z" if row["ultima"] else now,
        })

    # ── 6. Saúde do sistema (update_checker) ─────────────────────────────────
    try:
        from services.update_checker import get_last_check
        chk = get_last_check()
        if chk:
            if not chk.watchdog.ok:
                alts.append({
                    "id": "sys_watchdog", "tipo": "sistema",
                    "severidade": "critico", "titulo": "Watchdog parado",
                    "mensagem": chk.watchdog.mensagem,
                    "contexto": {"link": "/sistema"}, "ts": now,
                })
            if not chk.sftp_pendentes.ok:
                alts.append({
                    "id": "sys_sftp", "tipo": "sistema",
                    "severidade": "aviso", "titulo": "Arquivos SFTP travados",
                    "mensagem": chk.sftp_pendentes.mensagem,
                    "contexto": {"link": "/sistema"}, "ts": now,
                })
            if not chk.banco.ok:
                alts.append({
                    "id": "sys_banco", "tipo": "sistema",
                    "severidade": "critico", "titulo": "Banco de dados com falha",
                    "mensagem": chk.banco.mensagem,
                    "contexto": {"link": "/sistema"}, "ts": now,
                })
            if not chk.disco.ok:
                alts.append({
                    "id": "sys_disco", "tipo": "sistema",
                    "severidade": "aviso", "titulo": "Disco com espaço baixo",
                    "mensagem": chk.disco.mensagem,
                    "contexto": {"link": "/sistema"}, "ts": now,
                })
            if not chk.modelos.ok:
                alts.append({
                    "id": "sys_modelos", "tipo": "sistema",
                    "severidade": "aviso", "titulo": "Modelos IA ausentes",
                    "mensagem": chk.modelos.mensagem,
                    "contexto": {"link": "/sistema"}, "ts": now,
                })
            if chk.saude_geral == "critico":
                pass  # já capturado item a item acima
    except Exception:
        pass

    # ── 7. Disco cheio (direto) ───────────────────────────────────────────────
    try:
        usage = _shutil.disk_usage(os.getenv("STORAGE_DIR", "/opt/suricatha/storage"))
        pct   = usage.used / usage.total * 100
        if pct >= 90:
            alts.append({
                "id": "disk_critical", "tipo": "disco",
                "severidade": "critico", "titulo": "Disco quase cheio",
                "mensagem": f"Uso de disco em {pct:.0f}% — {usage.free / 1e9:.1f} GB livres",
                "contexto": {"link": "/sistema"}, "ts": now,
            })
        elif pct >= 80:
            alts.append({
                "id": "disk_warning", "tipo": "disco",
                "severidade": "aviso", "titulo": "Disco com espaço reduzido",
                "mensagem": f"Uso de disco em {pct:.0f}% — {usage.free / 1e9:.1f} GB livres",
                "contexto": {"link": "/sistema"}, "ts": now,
            })
    except Exception:
        pass

    # ── 8. Modelos IA ausentes (direto) ──────────────────────────────────────
    for env_key, label in [("YOLO_PEOPLE_MODEL", "Pessoas"), ("YOLO_PPE_MODEL", "EPI")]:
        path = os.getenv(env_key, "")
        if path and not _pathlib.Path(path).exists():
            alts.append({
                "id": f"model_{env_key.lower()}", "tipo": "modelo_ia",
                "severidade": "aviso", "titulo": f"Modelo IA ausente — {label}",
                "mensagem": f"Arquivo não encontrado: {path}",
                "contexto": {"link": "/sistema"}, "ts": now,
            })

    # ── 9. Violações EPI (última 1h) ─────────────────────────────────────────
    try:
        cur.execute("""
            SELECT count(*) AS n, max(detectado_em) AS ultima,
                   coalesce(sum(sem_capacete + sem_colete), 0) AS total_viol
            FROM eventos_epi
            WHERE NOT conformidade
              AND detectado_em >= NOW() - INTERVAL '1 hour'
        """)
        row = cur.fetchone()
        if row and row["n"] and int(row["n"]) > 0:
            alts.append({
                "id": "epi_violacoes",
                "tipo": "epi_violacao",
                "severidade": "aviso",
                "titulo": "Violações de EPI detectadas",
                "mensagem": f"{int(row['n'])} frame(s) com não-conformidade · {int(row['total_viol'])} violação(ões) na última hora",
                "contexto": {"link": "/epi"},
                "ts": row["ultima"].isoformat() + "Z" if row["ultima"] else now,
            })
    except Exception:
        pass

    # ── 10. Alarmes CCTV disparados (última 1h) ───────────────────────────────
    try:
        cur.execute("""
            SELECT count(*) AS n, max(detectado_em) AS ultima,
                   max(camera_nome) AS camera
            FROM alarmes_cctv_eventos
            WHERE detectado_em >= NOW() - INTERVAL '1 hour'
        """)
        row = cur.fetchone()
        if row and row["n"] and int(row["n"]) > 0:
            alts.append({
                "id": "alarmes_cctv_recentes",
                "tipo": "alarme_cctv",
                "severidade": "critico",
                "titulo": "Alarmes CCTV recentes",
                "mensagem": f"{int(row['n'])} alarme(s) na última hora — última câmera: {row['camera'] or '?'}",
                "contexto": {"link": "/alarme"},
                "ts": row["ultima"].isoformat() + "Z" if row["ultima"] else now,
            })
    except Exception:
        pass

    # ── 11. Divergências LPR (última 1h) ──────────────────────────────────────
    try:
        cur.execute("""
            SELECT count(*) AS n, max(d.detectado_em) AS ultima,
                   max(c.nome) AS camera
            FROM deteccoes d
            LEFT JOIN cameras c ON c.id = d.camera_id
            WHERE d.divergencia = TRUE
              AND d.detectado_em >= NOW() - INTERVAL '1 hour'
        """)
        row = cur.fetchone()
        if row and row["n"] and int(row["n"]) > 0:
            alts.append({
                "id": "lpr_divergencias",
                "tipo": "divergencia_lpr",
                "severidade": "aviso",
                "titulo": "Divergências de leitura LPR",
                "mensagem": f"{int(row['n'])} leitura(s) com divergência na última hora",
                "contexto": {"link": "/deteccoes"},
                "ts": row["ultima"].isoformat() + "Z" if row["ultima"] else now,
            })
    except Exception:
        pass

    # ── 12. WhatsApp não configurado ──────────────────────────────────────────
    try:
        from services.whatsapp_evo import is_configured as _wa_cfg
        if not _wa_cfg():
            alts.append({
                "id": "whatsapp_not_cfg", "tipo": "whatsapp_offline",
                "severidade": "info", "titulo": "WhatsApp não configurado",
                "mensagem": "Notificações via WhatsApp inativas — configure a Evolution API",
                "contexto": {"link": "/whatsapp"}, "ts": now,
            })
    except Exception:
        pass

    # ── 13. Telegram não configurado ──────────────────────────────────────────
    try:
        from services.telegram_svc import is_configured as _tg_cfg
        if not _tg_cfg():
            alts.append({
                "id": "telegram_not_cfg", "tipo": "telegram_offline",
                "severidade": "info", "titulo": "Telegram não configurado",
                "mensagem": "Notificações via Telegram inativas — configure o bot",
                "contexto": {"link": "/telegram"}, "ts": now,
            })
    except Exception:
        pass

    # ── Resumo ────────────────────────────────────────────────────────────────
    criticos = sum(1 for a in alts if a["severidade"] == "critico")
    avisos   = sum(1 for a in alts if a["severidade"] == "aviso")
    infos    = sum(1 for a in alts if a["severidade"] == "info")

    return {
        "total"   : len(alts),
        "criticos": criticos,
        "avisos"  : avisos,
        "infos"   : infos,
        "alertas" : alts,
        "ts"      : now,
    }


# ════════════════════════════════════════════════════════════════════════════
#  CONFIGURAÇÕES — permissões de perfil
# ════════════════════════════════════════════════════════════════════════════

_DEFAULT_PERM = {
    "operador": {
        "watchlist_ver": True, "watchlist_editar": True,
        "cameras_ver": True,   "cameras_crud": False,
        "cameras_testar": True, "sistema": True, "usuarios": False,
    },
    "viewer": {
        "watchlist_ver": True, "watchlist_editar": False,
        "cameras_ver": False,  "cameras_crud": False,
        "cameras_testar": False, "sistema": False, "usuarios": False,
    },
}


@app.get("/api/v1/config/permissoes", tags=["Configurações"])
def get_permissoes(auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Retorna a matriz de permissões por perfil."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT valor FROM configuracoes WHERE chave = 'permissoes_perfil'")
    row = cur.fetchone()
    return row["valor"] if row else _DEFAULT_PERM


@app.get("/api/v1/config/emitente", tags=["Configurações"])
def get_emitente(auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Retorna os dados da empresa para cabeçalho de relatórios."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT nome_empresa, cnpj, endereco, cidade_uf,
               telefone, email, logo_url, slogan, atualizado_em
        FROM empresa LIMIT 1
    """)
    row = cur.fetchone()
    if not row:
        return {}
    return {k: v for k, v in row.items() if k != "atualizado_em"}


@app.put("/api/v1/config/emitente", tags=["Configurações"])
def set_emitente(
    body: dict,
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Salva os dados da empresa. Apenas admin."""
    allowed = {"nome_empresa", "cnpj", "endereco", "telefone", "email", "logo_url", "slogan", "cidade_uf"}
    unknown = set(body.keys()) - allowed
    if unknown:
        raise HTTPException(422, f"Campos inválidos: {unknown}")
    op_id = auth.get("op_id")
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        INSERT INTO empresa (nome_empresa, cnpj, endereco, cidade_uf, telefone, email, logo_url, slogan, atualizado_em, atualizado_por)
        VALUES (%(nome_empresa)s, %(cnpj)s, %(endereco)s, %(cidade_uf)s,
                %(telefone)s, %(email)s, %(logo_url)s, %(slogan)s, NOW(), %(op_id)s)
        ON CONFLICT ((TRUE)) DO UPDATE SET
            nome_empresa   = EXCLUDED.nome_empresa,
            cnpj           = EXCLUDED.cnpj,
            endereco       = EXCLUDED.endereco,
            cidade_uf      = EXCLUDED.cidade_uf,
            telefone       = EXCLUDED.telefone,
            email          = EXCLUDED.email,
            logo_url       = EXCLUDED.logo_url,
            slogan         = EXCLUDED.slogan,
            atualizado_em  = NOW(),
            atualizado_por = EXCLUDED.atualizado_por
        RETURNING nome_empresa, cnpj, endereco, cidade_uf, telefone, email, logo_url, slogan
    """, {**{k: body.get(k) for k in allowed}, "op_id": op_id})
    conn.commit()
    row = cur.fetchone()
    return dict(row) if row else body


@app.put("/api/v1/config/permissoes", tags=["Configurações"])
def set_permissoes(
    body: dict,
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Salva a matriz de permissões por perfil. Apenas admin."""
    import json as _json
    allowed_keys = {"watchlist_ver", "watchlist_editar", "cameras_ver",
                    "cameras_crud", "cameras_testar", "sistema", "usuarios"}
    for perfil in ("operador", "viewer"):
        if perfil not in body:
            raise HTTPException(422, f"Campo '{perfil}' ausente")
        unknown = set(body[perfil].keys()) - allowed_keys
        if unknown:
            raise HTTPException(422, f"Chaves inválidas: {unknown}")
        for k, v in body[perfil].items():
            if not isinstance(v, bool):
                raise HTTPException(422, f"Valor de '{k}' deve ser boolean")
    op_id = auth.get("op_id")
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO configuracoes (chave, valor, atualizado_em, atualizado_por)
        VALUES ('permissoes_perfil', %s, NOW(), %s)
        ON CONFLICT (chave) DO UPDATE
            SET valor = EXCLUDED.valor,
                atualizado_em = NOW(),
                atualizado_por = EXCLUDED.atualizado_por
    """, (_json.dumps(body), op_id))
    conn.commit()
    log.info("[SURICATHA-LOG] Admin %s atualizou permissões de perfil", auth.get("sub"))
    return body


# ════════════════════════════════════════════════════════════════════════════
#  RELATÓRIOS
# ════════════════════════════════════════════════════════════════════════════
@app.get("/api/v1/reports/daily", tags=["Relatórios"])
def daily_report(date: str = Query(None, description="YYYY-MM-DD"),
                 auth: dict = Depends(require_auth)):
    """Gera ou retorna o relatório diário. Dispara envio via Telegram."""
    from services.reports import generate_daily_report
    try:
        data = generate_daily_report(date_str=date)
        return data
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/v1/reports/custom", tags=["Relatórios"])
def custom_report(
    tipo: str = Query("lpr", description="lpr | pessoas | epi | geral"),
    data_inicio: str = Query(None, description="YYYY-MM-DD"),
    data_fim:    str = Query(None, description="YYYY-MM-DD"),
    camera_id:   int = Query(None),
    auth: dict = Depends(require_auth),
    conn=Depends(get_conn),
):
    """Dados para relatório customizado por tipo e período."""
    import datetime as _dt
    cur = conn.cursor(cursor_factory=RealDictCursor)

    hoje = _dt.date.today()
    try:
        d_ini = _dt.date.fromisoformat(data_inicio) if data_inicio else (hoje - _dt.timedelta(days=6))
        d_fim = _dt.date.fromisoformat(data_fim)    if data_fim    else hoje
    except ValueError:
        raise HTTPException(422, "Datas inválidas — use YYYY-MM-DD")

    ts_ini = f"{d_ini} 00:00:00"
    ts_fim = f"{d_fim} 23:59:59"
    cam_filter = " AND camera_id = %s" if camera_id else ""
    params_base = [ts_ini, ts_fim] + ([camera_id] if camera_id else [])

    result: dict = {
        "tipo": tipo,
        "periodo": {"inicio": str(d_ini), "fim": str(d_fim)},
        "cameras": [],
    }

    if tipo in ("lpr", "geral"):
        cur.execute(f"""
            SELECT c.id, c.nome, c.local,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE d.placa IS NOT NULL) AS com_placa,
                   COUNT(*) FILTER (WHERE d.watchlist_hit) AS watchlist,
                   COUNT(*) FILTER (WHERE d.divergencia) AS divergencias,
                   ROUND(AVG(d.confianca_final)::numeric,2) AS confianca_media
            FROM deteccoes d
            JOIN cameras c ON c.id = d.camera_id
            WHERE d.detectado_em BETWEEN %s AND %s {cam_filter}
            GROUP BY c.id, c.nome, c.local ORDER BY total DESC
        """, params_base)
        result["lpr"] = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(detectado_em) AS dia,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE placa IS NOT NULL) AS com_placa,
                   COUNT(*) FILTER (WHERE watchlist_hit) AS watchlist,
                   ROUND(AVG(confianca_final)::numeric,2) AS confianca_media
            FROM deteccoes
            WHERE detectado_em BETWEEN %s AND %s {cam_filter}
            GROUP BY dia ORDER BY dia
        """, params_base)
        result["lpr_timeline"] = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(detectado_em) AS dia,
                   EXTRACT(HOUR FROM detectado_em)::int AS hora,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE watchlist_hit) AS accent
            FROM deteccoes
            WHERE detectado_em BETWEEN %s AND %s {cam_filter}
            GROUP BY dia, hora ORDER BY dia, hora
        """, params_base)
        result["lpr_heatmap"] = [dict(r) for r in cur.fetchall()]

    if tipo in ("pessoas", "geral"):
        cur.execute(f"""
            SELECT c.id, c.nome, c.local,
                   COUNT(*) AS frames,
                   SUM(cp.total_pessoas) AS total_pessoas,
                   MAX(cp.total_pessoas) AS pico,
                   COUNT(*) FILTER (WHERE cp.alerta_lotacao) AS alertas
            FROM contagens_pessoas cp
            JOIN cameras c ON c.id = cp.camera_id
            WHERE cp.detectado_em BETWEEN %s AND %s {cam_filter}
            GROUP BY c.id, c.nome, c.local ORDER BY total_pessoas DESC NULLS LAST
        """, params_base)
        result["pessoas"] = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(detectado_em) AS dia,
                   COUNT(*) AS frames,
                   SUM(total_pessoas) AS total_pessoas,
                   MAX(total_pessoas) AS pico,
                   COUNT(*) FILTER (WHERE alerta_lotacao) AS alertas
            FROM contagens_pessoas
            WHERE detectado_em BETWEEN %s AND %s {cam_filter}
            GROUP BY dia ORDER BY dia
        """, params_base)
        result["pessoas_timeline"] = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(detectado_em) AS dia,
                   EXTRACT(HOUR FROM detectado_em)::int AS hora,
                   COALESCE(SUM(total_pessoas),0)::int AS total,
                   COUNT(*) FILTER (WHERE alerta_lotacao) AS accent
            FROM contagens_pessoas
            WHERE detectado_em BETWEEN %s AND %s {cam_filter}
            GROUP BY dia, hora ORDER BY dia, hora
        """, params_base)
        result["pessoas_heatmap"] = [dict(r) for r in cur.fetchall()]

    if tipo in ("epi", "geral"):
        cur.execute(f"""
            SELECT c.id, c.nome, c.local,
                   COUNT(*) AS eventos,
                   SUM(e.total_pessoas) AS total_pessoas,
                   COUNT(*) FILTER (WHERE NOT e.conformidade) AS violacoes,
                   ROUND(AVG(e.percentual_conformidade)::numeric,1) AS conformidade_media
            FROM eventos_epi e
            JOIN cameras c ON c.id = e.camera_id
            WHERE e.detectado_em BETWEEN %s AND %s {cam_filter}
              AND e.total_pessoas > 0
            GROUP BY c.id, c.nome, c.local ORDER BY violacoes DESC
        """, params_base)
        result["epi"] = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(detectado_em) AS dia,
                   COUNT(*) AS eventos,
                   SUM(total_pessoas) AS total_pessoas,
                   COUNT(*) FILTER (WHERE NOT conformidade) AS violacoes,
                   ROUND(AVG(percentual_conformidade)::numeric,1) AS conformidade_media
            FROM eventos_epi
            WHERE detectado_em BETWEEN %s AND %s {cam_filter}
              AND total_pessoas > 0
            GROUP BY dia ORDER BY dia
        """, params_base)
        result["epi_timeline"] = [dict(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT DATE(detectado_em) AS dia,
                   EXTRACT(HOUR FROM detectado_em)::int AS hora,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE NOT conformidade) AS accent
            FROM eventos_epi
            WHERE detectado_em BETWEEN %s AND %s {cam_filter}
              AND total_pessoas > 0
            GROUP BY dia, hora ORDER BY dia, hora
        """, params_base)
        result["epi_heatmap"] = [dict(r) for r in cur.fetchall()]

    return result


# ════════════════════════════════════════════════════════════════════════════
#  WHATSAPP — Evolution API
# ════════════════════════════════════════════════════════════════════════════

class WhatsAppConfigBody(BaseModel):
    url:      str
    key:      str = ""
    instance: str
    phone:    str = ""
    provider: str = "evolution"

class SendTestBody(BaseModel):
    phone: Optional[str] = None
    message: Optional[str] = None


@app.get("/api/v1/whatsapp/config", tags=["WhatsApp"])
def whatsapp_get_config(auth: dict = Depends(require_auth)):
    """Retorna configuração atual da Evolution API (chave mascarada)."""
    from services.whatsapp_evo import get_config
    cfg = get_config()
    # mask the key
    key = cfg.get("key", "")
    if key:
        key = key[:4] + "****" + key[-4:] if len(key) > 8 else "****"
    return {
        "url":      cfg.get("url", ""),
        "key":      key,
        "instance": cfg.get("instance", ""),
        "phone":    cfg.get("phone", ""),
        "provider": cfg.get("provider", "evolution"),
        "configured": bool(cfg.get("url") and cfg.get("key") and cfg.get("instance")),
    }


@app.put("/api/v1/whatsapp/config", tags=["WhatsApp"])
def whatsapp_save_config(body: WhatsAppConfigBody, auth: dict = Depends(require_auth)):
    """Salva configuração da Evolution API no banco de dados."""
    from services.whatsapp_evo import get_config, save_config
    try:
        key = body.key.strip()
        if not key:
            # preserve existing key — user didn't change it
            existing = get_config()
            key = existing.get("key", "")
        if not key:
            raise HTTPException(400, "API Key é obrigatória")
        save_config(body.url, key, body.instance, body.phone, body.provider)
        return {"ok": True, "message": "Configuração salva"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/v1/whatsapp/status", tags=["WhatsApp"])
def whatsapp_status(auth: dict = Depends(require_auth)):
    """Retorna estado da instância + QR code se desconectada."""
    from services.whatsapp_evo import get_config, get_instance_status, get_qrcode, is_configured
    cfg = get_config()
    if not is_configured(cfg):
        return {"ok": False, "state": "not_configured", "qrcode": None}
    status = get_instance_status(cfg)
    qrcode = None
    if status.get("state") in ("close", "connecting", "unknown"):
        qr = get_qrcode(cfg)
        if qr.get("ok"):
            qrcode = qr.get("base64") or qr.get("code")
    return {**status, "qrcode": qrcode}


@app.get("/api/v1/whatsapp/instances", tags=["WhatsApp"])
def whatsapp_list_instances(auth: dict = Depends(require_auth)):
    """Lista todas as instâncias disponíveis na Evolution API."""
    from services.whatsapp_evo import get_config, list_instances
    cfg = get_config()
    result = list_instances(cfg)
    if not result.get("ok"):
        raise HTTPException(502, result.get("error", "Erro ao listar instâncias"))
    return result


@app.post("/api/v1/whatsapp/instance/restart", tags=["WhatsApp"])
def whatsapp_restart(auth: dict = Depends(require_auth)):
    """Reinicia a instância Evolution API."""
    from services.whatsapp_evo import get_config, restart_instance
    cfg = get_config()
    result = restart_instance(cfg)
    if not result.get("ok"):
        raise HTTPException(502, result.get("error", "Erro ao reiniciar"))
    return result


@app.post("/api/v1/whatsapp/instance/logout", tags=["WhatsApp"])
def whatsapp_logout(auth: dict = Depends(require_auth)):
    """Desconecta a instância do WhatsApp."""
    from services.whatsapp_evo import get_config, logout_instance
    cfg = get_config()
    result = logout_instance(cfg)
    if not result.get("ok"):
        raise HTTPException(502, result.get("error", "Erro ao desconectar"))
    return result


@app.post("/api/v1/whatsapp/test", tags=["WhatsApp"])
def whatsapp_test(auth: dict = Depends(require_auth)):
    """Testa conexão com a Evolution API — verifica se instância está aberta."""
    from services.whatsapp_evo import get_config, get_instance_status, is_configured
    cfg = get_config()
    if not is_configured(cfg):
        raise HTTPException(400, "Evolution API não configurada")
    result = get_instance_status(cfg)
    if not result.get("ok"):
        raise HTTPException(503, detail=result)
    return result


@app.post("/api/v1/whatsapp/send-test", tags=["WhatsApp"])
def whatsapp_send_test(body: SendTestBody = SendTestBody(), auth: dict = Depends(require_auth)):
    """Envia mensagem de teste via Evolution API."""
    from services.whatsapp_evo import get_config, send_text, is_configured
    cfg = get_config()
    if not is_configured(cfg):
        raise HTTPException(400, "Evolution API não configurada")
    phone = body.phone or cfg.get("phone", "")
    if not phone:
        raise HTTPException(400, "Número de telefone não informado")
    msg = body.message or "✅ *SuricathaIA* — Teste de conectividade WhatsApp OK!"
    result = send_text(phone, msg, cfg)
    if not result.get("ok"):
        raise HTTPException(502, result.get("error", "Falha ao enviar"))
    return {"ok": True, "message": "Mensagem enviada", "phone": phone}


# ════════════════════════════════════════════════════════════════════════════
#  TELEGRAM
# ════════════════════════════════════════════════════════════════════════════

class TelegramConfigBody(BaseModel):
    token:      str
    chat_id:    str
    parse_mode: str = "Markdown"

class TelegramSendTestBody(BaseModel):
    message: Optional[str] = None


@app.get("/api/v1/telegram/config", tags=["Telegram"])
def telegram_get_config(auth: dict = Depends(require_auth)):
    """Retorna configuração atual do Telegram (token mascarado)."""
    from services.telegram_svc import get_config
    cfg = get_config()
    token = cfg.get("token", "")
    if token:
        token = token[:6] + "****" + token[-4:] if len(token) > 10 else "****"
    return {
        "token":      token,
        "chat_id":    cfg.get("chat_id", ""),
        "parse_mode": cfg.get("parse_mode", "Markdown"),
        "configured": bool(cfg.get("token") and cfg.get("chat_id")),
    }


@app.put("/api/v1/telegram/config", tags=["Telegram"])
def telegram_save_config(body: TelegramConfigBody, auth: dict = Depends(require_auth)):
    """Salva configuração do Telegram no banco de dados."""
    from services.telegram_svc import save_config
    try:
        save_config(body.token, body.chat_id, body.parse_mode)
        return {"ok": True, "message": "Configuração salva"}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/v1/telegram/status", tags=["Telegram"])
def telegram_status(auth: dict = Depends(require_auth)):
    """Verifica token (getMe) e chat_id (getChat)."""
    from services.telegram_svc import get_config, get_bot_info, get_chat_info, is_configured
    cfg = get_config()
    if not is_configured(cfg):
        return {"ok": False, "configured": False, "bot": None, "chat": None}
    bot  = get_bot_info(cfg)
    chat = get_chat_info(cfg) if bot.get("ok") else {"ok": False, "error": "Token inválido"}
    return {
        "ok":         bot.get("ok") and chat.get("ok"),
        "configured": True,
        "bot":        bot,
        "chat":       chat,
    }


@app.post("/api/v1/telegram/test", tags=["Telegram"])
def telegram_test_connection(auth: dict = Depends(require_auth)):
    """Testa a conexão verificando token e chat."""
    from services.telegram_svc import get_config, get_bot_info, is_configured
    cfg = get_config()
    if not is_configured(cfg):
        raise HTTPException(400, "Telegram não configurado")
    result = get_bot_info(cfg)
    if not result.get("ok"):
        raise HTTPException(503, detail=result)
    return result


@app.post("/api/v1/telegram/send-test", tags=["Telegram"])
def telegram_send_test(body: TelegramSendTestBody = TelegramSendTestBody(),
                       auth: dict = Depends(require_auth)):
    """Envia mensagem de teste via Telegram."""
    from services.telegram_svc import get_config, send_message, is_configured
    cfg = get_config()
    if not is_configured(cfg):
        raise HTTPException(400, "Telegram não configurado")
    msg = body.message or "✅ *SuricathaIA* — Teste de conectividade Telegram OK\\!"
    result = send_message(msg, cfg)
    if not result.get("ok"):
        raise HTTPException(502, result.get("error", "Falha ao enviar"))
    return {"ok": True, "message": "Mensagem enviada"}


# ════════════════════════════════════════════════════════════════════════════
#  AUTOMAÇÕES DE ALERTAS
# ════════════════════════════════════════════════════════════════════════════

class AutomacaoBody(BaseModel):
    nome:            str
    descricao:       Optional[str]  = None
    ativo:           bool           = True
    tipo_evento:     str
    condicoes:       dict           = {}
    canais:          dict           = {}
    mensagem_custom: Optional[str]  = None
    cooldown_min:    int            = 5
    horario_inicio:  Optional[str]  = None   # "HH:MM"
    horario_fim:     Optional[str]  = None
    dias_semana:     Optional[list] = None   # [0,1,2,3,4,5,6]


@app.get("/api/v1/automacoes", tags=["Automações"])
def list_automacoes(auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Lista todas as automações de alerta com histórico resumido."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT a.*,
                   COUNT(h.id)            AS total_disparos,
                   MAX(h.disparado_em)    AS ultimo_disparo
            FROM automacoes_alertas a
            LEFT JOIN automacoes_historico h ON h.automacao_id = a.id
            GROUP BY a.id
            ORDER BY a.id
        """)
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        if r.get("horario_inicio"):  r["horario_inicio"] = str(r["horario_inicio"])[:5]
        if r.get("horario_fim"):     r["horario_fim"]    = str(r["horario_fim"])[:5]
    return rows


@app.post("/api/v1/automacoes", tags=["Automações"])
def create_automacao(body: AutomacaoBody, auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Cria nova automação de alerta."""
    VALID = {"watchlist_hit", "camera_offline", "pessoa_detectada", "epi_violacao", "lpr_qualquer"}
    if body.tipo_evento not in VALID:
        raise HTTPException(400, f"tipo_evento inválido. Use: {', '.join(VALID)}")
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            INSERT INTO automacoes_alertas
                (nome, descricao, ativo, tipo_evento, condicoes, canais,
                 mensagem_custom, cooldown_min, horario_inicio, horario_fim, dias_semana)
            VALUES (%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s)
            RETURNING *
        """, (
            body.nome, body.descricao, body.ativo, body.tipo_evento,
            json.dumps(body.condicoes), json.dumps(body.canais),
            body.mensagem_custom, body.cooldown_min,
            body.horario_inicio, body.horario_fim, body.dias_semana,
        ))
        row = dict(cur.fetchone())
    conn.commit()
    from services.automacoes import get_engine
    get_engine().reload_rules()
    return row


@app.put("/api/v1/automacoes/{aid}", tags=["Automações"])
def update_automacao(aid: int, body: AutomacaoBody,
                     auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Atualiza automação existente."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            UPDATE automacoes_alertas SET
                nome=%s, descricao=%s, ativo=%s, tipo_evento=%s,
                condicoes=%s::jsonb, canais=%s::jsonb,
                mensagem_custom=%s, cooldown_min=%s,
                horario_inicio=%s, horario_fim=%s, dias_semana=%s,
                atualizado_em=NOW()
            WHERE id=%s RETURNING *
        """, (
            body.nome, body.descricao, body.ativo, body.tipo_evento,
            json.dumps(body.condicoes), json.dumps(body.canais),
            body.mensagem_custom, body.cooldown_min,
            body.horario_inicio, body.horario_fim, body.dias_semana, aid,
        ))
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Automação não encontrada")
    conn.commit()
    from services.automacoes import get_engine
    get_engine().reload_rules()
    return dict(row)


@app.patch("/api/v1/automacoes/{aid}/toggle", tags=["Automações"])
def toggle_automacao(aid: int, auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Ativa/desativa uma automação."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            UPDATE automacoes_alertas SET ativo = NOT ativo, atualizado_em=NOW()
            WHERE id=%s RETURNING id, nome, ativo
        """, (aid,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Automação não encontrada")
    conn.commit()
    from services.automacoes import get_engine
    get_engine().reload_rules()
    return dict(row)


@app.delete("/api/v1/automacoes/{aid}", tags=["Automações"])
def delete_automacao(aid: int, auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Remove automação e seu histórico."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM automacoes_alertas WHERE id=%s RETURNING id", (aid,))
        if not cur.fetchone():
            raise HTTPException(404, "Automação não encontrada")
    conn.commit()
    from services.automacoes import get_engine
    get_engine().reload_rules()
    return {"ok": True}


@app.get("/api/v1/automacoes/{aid}/historico", tags=["Automações"])
def automacao_historico(aid: int, limit: int = 50,
                        auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Retorna histórico de disparos de uma automação."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT id, tipo_evento, contexto, canais_enviados, mensagem, disparado_em
            FROM automacoes_historico
            WHERE automacao_id = %s
            ORDER BY disparado_em DESC
            LIMIT %s
        """, (aid, limit))
        return [dict(r) for r in cur.fetchall()]


@app.get("/api/v1/automacoes-historico", tags=["Automações"])
def historico_geral(limit: int = 100, auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """Retorna histórico geral de todos os disparos."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT h.id, h.tipo_evento, h.contexto, h.canais_enviados,
                   h.mensagem, h.disparado_em, a.nome AS automacao_nome
            FROM automacoes_historico h
            JOIN automacoes_alertas a ON a.id = h.automacao_id
            ORDER BY h.disparado_em DESC
            LIMIT %s
        """, (limit,))
        return [dict(r) for r in cur.fetchall()]


# ════════════════════════════════════════════════════════════════════════════
#  SISTEMA — status completo e queue stats
# ════════════════════════════════════════════════════════════════════════════

@app.get("/api/v1/system/status", tags=["Sistema"])
def system_status(auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """
    Status completo do sistema: banco, workers, fila, alertas, modelos.
    Usado pelo dashboard Lovable para painel de saúde.
    """
    import shutil

    status: dict = {"timestamp": datetime.utcnow().isoformat(), "componentes": {}}

    # ── Banco de dados ────────────────────────────────────────────────────────
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT
                count(*) AS total_deteccoes,
                count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'24h') AS deteccoes_24h,
                count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'1h')  AS deteccoes_1h,
                count(*) FILTER (WHERE watchlist_hit AND detectado_em >= NOW()-INTERVAL'24h') AS alertas_24h
            FROM deteccoes
        """)
        db_stats = dict(cur.fetchone())
        cur.execute("SELECT count(*) AS n FROM cameras WHERE ativa")
        db_stats["cameras_ativas"] = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM watchlist WHERE ativa")
        db_stats["watchlist_ativas"] = cur.fetchone()["n"]
        status["componentes"]["banco"] = {"ok": True, **db_stats}
    except Exception as exc:
        status["componentes"]["banco"] = {"ok": False, "erro": str(exc)}

    # ── Fila de prioridade ────────────────────────────────────────────────────
    try:
        from core.priority_queue import get_scheduler
        sched = get_scheduler()
        queue_stats = sched.get_stats()
        status["componentes"]["fila"] = {"ok": True, **queue_stats}
    except Exception as exc:
        status["componentes"]["fila"] = {"ok": False, "erro": str(exc)}

    # ── Modelos IA ────────────────────────────────────────────────────────────
    models = {}
    for key, label in [("YOLO_PEOPLE_MODEL", "yolo_pessoas"), ("YOLO_PPE_MODEL", "yolo_epi")]:
        path = os.getenv(key, "")
        import pathlib
        p = pathlib.Path(path)
        models[label] = {"ok": p.exists(), "path": path,
                         "tamanho_kb": p.stat().st_size // 1024 if p.exists() else 0}
    status["componentes"]["modelos"] = models

    # ── Armazenamento ─────────────────────────────────────────────────────────
    storage_dir = os.getenv("STORAGE_DIR", "/opt/suricatha/storage")
    try:
        usage = shutil.disk_usage(storage_dir)
        status["componentes"]["armazenamento"] = {
            "ok"          : True,
            "total_gb"    : round(usage.total / 1e9, 1),
            "usado_gb"    : round(usage.used  / 1e9, 1),
            "livre_gb"    : round(usage.free  / 1e9, 1),
            "uso_pct"     : round(usage.used / usage.total * 100, 1),
        }
    except Exception as exc:
        status["componentes"]["armazenamento"] = {"ok": False, "erro": str(exc)}

    # ── Alertas ───────────────────────────────────────────────────────────────
    try:
        from services.telegram_svc import get_config as _tg_cfg, is_configured as _tg_ok
        from services.whatsapp_evo import get_config as _wa_cfg, is_configured as _wa_ok
        _tg = _tg_cfg(); _wa = _wa_cfg()
        status["componentes"]["alertas"] = {
            "telegram": _tg_ok(_tg),
            "whatsapp": _wa_ok(_wa),
            "provider": _wa.get("provider", ""),
        }
    except Exception:
        status["componentes"]["alertas"] = {
            "telegram": bool(os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_CHAT_ID")),
            "whatsapp": bool(os.getenv("EVOLUTION_API_URL") and os.getenv("EVOLUTION_API_KEY")),
            "provider": os.getenv("WA_PROVIDER", ""),
        }

    # Resumo geral
    falhas = [k for k, v in status["componentes"].items()
              if isinstance(v, dict) and v.get("ok") is False]
    status["saude"] = "degradado" if falhas else "saudavel"
    status["falhas"] = falhas

    return status


@app.get("/api/v1/system/queue", tags=["Sistema"])
def queue_stats(auth: dict = Depends(require_auth)):
    """Estatísticas em tempo real da fila de prioridade (LPR / Pessoas / EPI)."""
    try:
        from core.priority_queue import get_scheduler
        return get_scheduler().get_stats()
    except Exception as exc:
        raise HTTPException(500, f"Scheduler indisponível: {exc}")


@app.get("/api/v1/system/updates", tags=["Sistema"])
def system_updates(auth: dict = Depends(require_auth)):
    """Retorna resultado do último check de atualização (cache). Rápido."""
    from services.update_checker import get_last_check
    cached = get_last_check()
    if cached:
        return cached
    # Nenhum check executado ainda — roda agora de forma síncrona
    from services.update_checker import run_check_now
    return run_check_now()


@app.get("/api/v1/system/rtsp/status", tags=["Sistema"])
def rtsp_status(auth: dict = Depends(require_auth)):
    """Status dos workers RTSP de contagem de pessoas."""
    from services.rtsp_people_counter import get_service
    svc = get_service()
    if svc is None:
        return {"workers": [], "mensagem": "Serviço RTSP não iniciado"}
    return {"workers": svc.status()}


@app.post("/api/v1/system/rtsp/reload", tags=["Sistema"])
def rtsp_reload(auth: dict = Depends(require_auth)):
    """Relê câmeras do banco e atualiza workers RTSP sem reiniciar a API."""
    from services.rtsp_people_counter import get_service
    svc = get_service()
    if svc is None:
        return {"ok": False, "mensagem": "Serviço não iniciado"}
    svc.reload()
    return {"ok": True, "workers": svc.status()}


@app.get("/api/v1/system/epi/status", tags=["Sistema"])
def epi_rtsp_status(auth: dict = Depends(require_auth)):
    """Status dos workers EPI em tempo real (RTSP/HTTP)."""
    from services.rtsp_epi_service import get_service
    svc = get_service()
    if svc is None:
        return {"workers": [], "mensagem": "Serviço EPI não iniciado"}
    return {"workers": svc.status()}


@app.post("/api/v1/system/epi/reload", tags=["Sistema"])
def epi_rtsp_reload(auth: dict = Depends(require_auth)):
    """Relê câmeras EPI do banco e atualiza workers sem reiniciar a API."""
    from services.rtsp_epi_service import get_service
    svc = get_service()
    if svc is None:
        return {"ok": False, "mensagem": "Serviço não iniciado"}
    svc.reload()
    return {"ok": True, "workers": svc.status()}


@app.get("/api/v1/system/rtmp/status", tags=["Sistema"])
def rtmp_status(auth: dict = Depends(require_auth)):
    """Status dos workers RTMP (stream → MediaMTX → LPR/Contagem)."""
    from services.rtmp_stream_worker import get_service
    svc = get_service()
    if svc is None:
        return {"workers": [], "mensagem": "Serviço RTMP não iniciado"}
    return {"workers": svc.status()}


@app.post("/api/v1/system/rtmp/reload", tags=["Sistema"])
def rtmp_reload(auth: dict = Depends(require_auth)):
    """Relê câmeras RTMP do banco e atualiza workers sem reiniciar a API."""
    from services.rtmp_stream_worker import get_service
    svc = get_service()
    if svc is None:
        return {"ok": False, "mensagem": "Serviço não iniciado"}
    svc.reload()
    return {"ok": True, "workers": svc.status()}


@app.post("/api/v1/system/updates/check", tags=["Sistema"])
def trigger_update_check(auth: dict = Depends(require_auth)):
    """Força um check imediato (pode demorar alguns segundos)."""
    from services.update_checker import run_check_now
    return run_check_now()


@app.get("/api/v1/dashboard/resumo", tags=["Dashboard"])
def dashboard_resumo(auth: dict = Depends(require_auth), conn=Depends(get_conn)):
    """
    Resumo unificado para o Dashboard — uma única chamada retorna:
    LPR 24h, câmeras, pessoas, EPI, sistema e updates.
    """
    import shutil as _shutil
    cur = conn.cursor(cursor_factory=RealDictCursor)
    result: dict = {}

    # ── LPR ──────────────────────────────────────────────────────────────────
    try:
        cur.execute("""
            SELECT
                count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'24h') AS total_24h,
                count(*) FILTER (WHERE detectado_em >= NOW()-INTERVAL'1h')  AS total_1h,
                count(*) FILTER (WHERE validado AND detectado_em >= NOW()-INTERVAL'24h') AS validadas_24h,
                count(*) FILTER (WHERE watchlist_hit AND detectado_em >= NOW()-INTERVAL'24h') AS alertas_24h,
                round(avg(tempo_processo_ms) FILTER (WHERE detectado_em >= NOW()-INTERVAL'24h'))::int AS tempo_medio_ms
            FROM deteccoes
        """)
        result["lpr"] = dict(cur.fetchone())
    except Exception as e:
        result["lpr"] = {"erro": str(e)}

    # ── Câmeras ───────────────────────────────────────────────────────────────
    try:
        cur.execute("""
            SELECT
                count(*) FILTER (WHERE ativa)                             AS total_ativas,
                count(*) FILTER (WHERE ativa AND status_conexao='online') AS online,
                count(*) FILTER (WHERE ativa AND status_conexao='offline') AS offline,
                count(*) FILTER (WHERE ativa AND status_conexao='desconhecida') AS desconhecidas
            FROM cameras
        """)
        result["cameras"] = dict(cur.fetchone())
    except Exception as e:
        result["cameras"] = {"erro": str(e)}

    # ── Pessoas ───────────────────────────────────────────────────────────────
    try:
        cur.execute("""
            SELECT
                count(*)                        AS frames_24h,
                coalesce(sum(total_pessoas), 0) AS total_pessoas_24h,
                coalesce(max(total_pessoas), 0) AS pico_24h,
                count(*) FILTER (WHERE alerta_lotacao) AS alertas_24h
            FROM contagens_pessoas
            WHERE detectado_em >= NOW()-INTERVAL'24h'
        """)
        result["pessoas"] = dict(cur.fetchone())
    except Exception as e:
        result["pessoas"] = {"erro": str(e)}

    # ── EPI ───────────────────────────────────────────────────────────────────
    try:
        cur.execute("""
            SELECT
                count(*)                                        AS eventos_24h,
                count(*) FILTER (WHERE NOT conformidade)        AS violacoes_24h,
                coalesce(round(avg(percentual_conformidade)::numeric, 1), 0) AS conformidade_media
            FROM eventos_epi
            WHERE detectado_em >= NOW()-INTERVAL'24h'
        """)
        result["epi"] = dict(cur.fetchone())
    except Exception as e:
        result["epi"] = {"erro": str(e)}

    # ── Watchlist ─────────────────────────────────────────────────────────────
    try:
        cur.execute("SELECT count(*) AS total FROM watchlist WHERE ativa")
        result["watchlist"] = dict(cur.fetchone())
    except Exception as e:
        result["watchlist"] = {"erro": str(e)}

    # ── Sistema ───────────────────────────────────────────────────────────────
    try:
        storage_dir = os.getenv("STORAGE_DIR", "/opt/suricatha/storage")
        usage = _shutil.disk_usage(storage_dir)
        result["sistema"] = {
            "disco_uso_pct": round(usage.used / usage.total * 100, 1),
            "disco_livre_gb": round(usage.free / 1e9, 1),
            "disco_total_gb": round(usage.total / 1e9, 1),
            "alertas_telegram": __import__('services.telegram_svc', fromlist=['is_configured', 'get_config']).is_configured(),
            "alertas_whatsapp": __import__('services.whatsapp_evo', fromlist=['is_configured', 'get_config']).is_configured(),
        }
    except Exception as e:
        result["sistema"] = {"erro": str(e)}

    # ── Updates ───────────────────────────────────────────────────────────────
    try:
        from services.update_checker import get_last_check
        result["updates"] = get_last_check() or {}
    except Exception:
        result["updates"] = {}

    return result


# ════════════════════════════════════════════════════════════════════════════
#  ALARME CCTV — Configuração e histórico
# ════════════════════════════════════════════════════════════════════════════

class AlarmConfigBody(BaseModel):
    ativo:          Optional[bool]      = None
    min_pessoas:    Optional[int]       = None
    cooldown_seg:   Optional[int]       = None
    notif_sonoro:   Optional[bool]      = None
    notif_whatsapp:   Optional[bool]  = None
    notif_telegram:   Optional[bool]  = None
    destinatarios:    Optional[list]  = None
    notif_usuarios:   Optional[list]  = None   # list of operador IDs
    mensagem_custom:  Optional[str]   = None
    verificacao_yolo: Optional[bool]  = None
    horario_inicio:   Optional[str]   = None   # "HH:MM" or null to clear
    horario_fim:      Optional[str]   = None
    dias_semana:      Optional[list]  = None   # [0..6] Mon=0


@app.get("/api/v1/alarm/config", tags=["Alarme CCTV"])
def alarm_list_configs(
    auth: dict = Depends(require_auth),
    conn=Depends(get_conn),
):
    """Lista configuração de alarme de todas as câmeras ativas."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT c.id AS camera_id, c.nome AS camera_nome, c.local AS camera_local,
               c.protocolo, c.status_conexao, c.ativa,
               COALESCE(ac.id, 0) AS config_id,
               COALESCE(ac.ativo, FALSE)  AS ativo,
               COALESCE(ac.min_pessoas, 1)       AS min_pessoas,
               COALESCE(ac.cooldown_seg, 60)     AS cooldown_seg,
               COALESCE(ac.notif_sonoro, TRUE)   AS notif_sonoro,
               COALESCE(ac.notif_whatsapp, FALSE) AS notif_whatsapp,
               COALESCE(ac.notif_telegram, FALSE) AS notif_telegram,
               COALESCE(ac.destinatarios, '[]'::jsonb) AS destinatarios,
               COALESCE(ac.notif_usuarios, '[]'::jsonb) AS notif_usuarios,
               ac.mensagem_custom,
               COALESCE(ac.verificacao_yolo, TRUE) AS verificacao_yolo,
               ac.horario_inicio, ac.horario_fim, ac.dias_semana,
               (SELECT COUNT(*) FROM alarmes_cctv_eventos ae WHERE ae.camera_id = c.id
                  AND ae.detectado_em >= NOW() - INTERVAL '24h') AS alarmes_24h,
               (SELECT MAX(ae.detectado_em) FROM alarmes_cctv_eventos ae WHERE ae.camera_id = c.id)
                   AS ultimo_alarme
        FROM cameras c
        LEFT JOIN alarmes_cctv_config ac ON ac.camera_id = c.id
        WHERE c.ativa
        ORDER BY c.id
    """)
    rows = cur.fetchall()
    for r in rows:
        if r.get("horario_inicio"): r["horario_inicio"] = str(r["horario_inicio"])[:5]
        if r.get("horario_fim"):    r["horario_fim"]    = str(r["horario_fim"])[:5]
    return rows


@app.put("/api/v1/alarm/config/{camera_id}", tags=["Alarme CCTV"])
def alarm_save_config(
    camera_id: int,
    body: AlarmConfigBody,
    auth: dict = Depends(require_auth),
    conn=Depends(get_conn),
):
    """Salva ou atualiza a configuração de alarme de uma câmera."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT id FROM cameras WHERE id=%s AND ativa", (camera_id,))
    if not cur.fetchone():
        raise HTTPException(404, "Câmera não encontrada")

    fields, vals = [], []
    mapping = {
        "ativo": body.ativo,
        "min_pessoas": body.min_pessoas,
        "cooldown_seg": body.cooldown_seg,
        "notif_sonoro": body.notif_sonoro,
        "notif_whatsapp":   body.notif_whatsapp,
        "notif_telegram":   body.notif_telegram,
        "mensagem_custom":  body.mensagem_custom,
        "verificacao_yolo": body.verificacao_yolo,
    }
    for col, val in mapping.items():
        if val is not None:
            fields.append(f"{col}=%s"); vals.append(val)
    if body.destinatarios is not None:
        fields.append("destinatarios=%s"); vals.append(json.dumps(body.destinatarios))
    if body.notif_usuarios is not None:
        fields.append("notif_usuarios=%s"); vals.append(json.dumps([int(i) for i in body.notif_usuarios]))
    # Schedule fields: allow explicit null to clear
    if "horario_inicio" in body.model_fields_set:
        fields.append("horario_inicio=%s"); vals.append(body.horario_inicio or None)
    if "horario_fim" in body.model_fields_set:
        fields.append("horario_fim=%s"); vals.append(body.horario_fim or None)
    if "dias_semana" in body.model_fields_set:
        fields.append("dias_semana=%s"); vals.append(body.dias_semana or None)
    if not fields:
        raise HTTPException(422, "Nenhum campo para atualizar")
    fields.append("atualizado_em=NOW()")

    vals.append(camera_id)
    cur.execute(f"""
        INSERT INTO alarmes_cctv_config(camera_id) VALUES (%s)
        ON CONFLICT(camera_id) DO NOTHING
    """, (camera_id,))
    cur.execute(f"UPDATE alarmes_cctv_config SET {', '.join(fields)} WHERE camera_id=%s", vals)
    conn.commit()
    return {"ok": True}


@app.get("/api/v1/alarm/events", tags=["Alarme CCTV"])
def alarm_events(
    limit: int = Query(50, ge=1, le=200),
    camera_id: Optional[int] = Query(None),
    auth: dict = Depends(require_auth),
    conn=Depends(get_conn),
):
    """Histórico de eventos de alarme CCTV."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    where = "WHERE TRUE"
    params: list = []
    if camera_id:
        where += " AND camera_id=%s"; params.append(camera_id)
    cur.execute(f"""
        SELECT id, camera_id, camera_nome, total_pessoas, contagem_id, canais,
               detectado_em, snapshot_path
        FROM alarmes_cctv_eventos
        {where}
        ORDER BY detectado_em DESC
        LIMIT %s
    """, params + [limit])
    rows = cur.fetchall()
    # inject snapshot_url for convenience
    for r in rows:
        r["snapshot_url"] = f"/api/v1/alarm/events/{r['id']}/snapshot" if r.get("snapshot_path") else None
    return rows


@app.get("/api/v1/alarm/events/{evento_id}/snapshot", tags=["Alarme CCTV"])
def alarm_event_snapshot(evento_id: int, request: Request, conn=Depends(get_conn)):
    """Retorna o snapshot JPEG do evento de alarme."""
    from pathlib import Path as _Path
    snap_dir = _Path("/app/snapshots")
    # Busca o snapshot_path real gravado no banco
    cur = conn.cursor()
    cur.execute("SELECT snapshot_path FROM alarmes_cctv_eventos WHERE id = %s", (evento_id,))
    row = cur.fetchone()
    if row and row[0]:
        path = snap_dir / row[0]
        if path.exists():
            return FileResponse(str(path), media_type="image/jpeg",
                                headers={"Cache-Control": "public, max-age=86400"})
    # Fallback: nome canônico alarm_{id}.jpg
    path = snap_dir / f"alarm_{evento_id}.jpg"
    if path.exists():
        return FileResponse(str(path), media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400"})
    raise HTTPException(404, "Snapshot não disponível")


@app.get("/api/v1/alarm/events/timeline", tags=["Alarme CCTV"])
def alarm_events_timeline(
    periodo: str = Query("24h", description="6h | 24h | 7d | 30d"),
    camera_id: Optional[int] = Query(None),
    auth: dict = Depends(require_auth),
    conn=Depends(get_conn),
):
    """Série temporal de disparos de alarme agrupados por hora/dia."""
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
    params: list = [interval_expr]
    if camera_id:
        base_filters.append("camera_id = %s")
        params.append(camera_id)
    where = "WHERE " + " AND ".join(base_filters)

    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(f"""
        SELECT
            date_trunc('{trunc}', detectado_em)   AS ts,
            count(*)                               AS disparos,
            sum(total_pessoas)                     AS total_pessoas,
            max(total_pessoas)                     AS pico,
            round(avg(total_pessoas)::numeric, 1)  AS media_pessoas,
            count(DISTINCT camera_id)              AS cameras_ativas
        FROM alarmes_cctv_eventos
        {where}
        GROUP BY 1
        ORDER BY 1 ASC
    """, params)
    rows = []
    for r in cur.fetchall():
        d = dict(r)
        d["ts"] = d["ts"].isoformat() if d["ts"] else None
        rows.append(d)

    pico_global = max((r["disparos"] for r in rows), default=0)
    return {"periodo": periodo, "pico_global": pico_global, "data": rows}


@app.get("/api/v1/system/alarm/status", tags=["Sistema"])
def alarm_cctv_status(auth: dict = Depends(require_auth)):
    from services.alarm_cctv import _service as _alarm_svc
    if _alarm_svc is None:
        return {"workers": [], "mensagem": "Serviço não iniciado"}
    return {"workers": _alarm_svc.status()}


@app.post("/api/v1/system/alarm/reload", tags=["Sistema"])
def alarm_cctv_reload(auth: dict = Depends(require_auth)):
    from services.alarm_cctv import _service as _alarm_svc
    if _alarm_svc is None:
        return {"ok": False, "mensagem": "Serviço não iniciado"}
    _alarm_svc.reload()
    return {"ok": True, "workers": _alarm_svc.status()}


@app.delete("/api/v1/alarm/events", tags=["Alarme CCTV"])
def alarm_clear_events(
    auth: dict = Depends(require_role("admin")),
    conn=Depends(get_conn),
):
    """Limpa histórico de alarmes (admin)."""
    cur = conn.cursor()
    cur.execute("DELETE FROM alarmes_cctv_eventos")
    conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


# ════════════════════════════════════════════════════════════════════════════
#  CCTV — Streaming ao vivo (MJPEG + Snapshot)
# ════════════════════════════════════════════════════════════════════════════

import cv2 as _cv2
from urllib.parse import urlparse as _urlparse


def _require_stream_auth(
    authorization: Optional[str] = Query(None, alias="token"),
    creds=None,
) -> dict:
    """Auth que aceita ?token= (para <img src>) ou header Bearer."""
    from core.auth import decode_token, _API_KEYS
    from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
    return {}  # placeholder — usado via Depends abaixo


def _stream_auth(request: Request) -> dict:
    """Extrai token do header Authorization ou ?token= query param."""
    from core.auth import decode_token, _API_KEYS
    token = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
    if not token:
        token = request.query_params.get("token", "")
    if not token:
        raise HTTPException(401, "Token obrigatório")
    if _API_KEYS and token in _API_KEYS:
        return {"sub": "api_key", "type": "api_key", "role": "admin"}
    return decode_token(token)


def _cam_stream_url(cam: dict) -> Optional[str]:
    """Resolve a URL de stream OpenCV para cada protocolo."""
    proto = (cam.get("protocolo") or "").lower()
    url   = cam.get("url_stream") or ""
    if proto == "rtsp" and url:
        return url
    if proto == "rtmp" and url:
        parsed = _urlparse(url)
        path   = parsed.path.lstrip("/")
        if path:
            return f"rtsp://localhost:8554/{path}"
    return None


def _open_cap(stream_url: str):
    cap = _cv2.VideoCapture(stream_url, _cv2.CAP_FFMPEG)
    cap.set(_cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8_000)
    cap.set(_cv2.CAP_PROP_READ_TIMEOUT_MSEC,  5_000)
    cap.set(_cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def _mjpeg_gen(stream_url: str):
    cap = _open_cap(stream_url)
    failures = 0
    try:
        while failures < 10:
            ret, frame = cap.read()
            if not ret:
                failures += 1
                import time as _t; _t.sleep(0.2)
                continue
            failures = 0
            _, buf = _cv2.imencode(".jpg", frame, [_cv2.IMWRITE_JPEG_QUALITY, 70])
            yield (
                b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                + buf.tobytes()
                + b"\r\n"
            )
    finally:
        cap.release()


@app.get("/api/v1/cameras/{cam_id}/snapshot", tags=["CCTV"])
def camera_snapshot(
    cam_id: int,
    request: Request,
    conn=Depends(get_conn),
):
    """Retorna um frame JPEG único da câmera (para thumbnails)."""
    _stream_auth(request)
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT id, protocolo, url_stream, status_conexao FROM cameras WHERE id=%s AND ativa", (cam_id,))
    cam = cur.fetchone()
    if not cam:
        raise HTTPException(404, "Câmera não encontrada")
    url = _cam_stream_url(cam)
    if not url:
        raise HTTPException(422, "Câmera sem stream configurado")

    import concurrent.futures as _cf
    def _grab():
        cap = _open_cap(url)
        try:
            for _ in range(5):
                cap.grab()
            ret, frame = cap.retrieve()
            if not ret:
                ret, frame = cap.read()
            if not ret or frame is None:
                return None
            _, buf = _cv2.imencode(".jpg", frame, [_cv2.IMWRITE_JPEG_QUALITY, 80])
            return buf.tobytes()
        finally:
            cap.release()

    with _cf.ThreadPoolExecutor(max_workers=1) as ex:
        fut  = ex.submit(_grab)
        data = fut.result(timeout=12)

    if not data:
        raise HTTPException(503, "Stream indisponível")
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "no-cache, no-store"})


@app.get("/api/v1/cameras/{cam_id}/mjpeg", tags=["CCTV"])
def camera_mjpeg(
    cam_id: int,
    request: Request,
    conn=Depends(get_conn),
):
    """MJPEG stream da câmera — usado como src de <img>."""
    _stream_auth(request)
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT id, protocolo, url_stream FROM cameras WHERE id=%s AND ativa", (cam_id,))
    cam = cur.fetchone()
    if not cam:
        raise HTTPException(404, "Câmera não encontrada")
    url = _cam_stream_url(cam)
    if not url:
        raise HTTPException(422, "Câmera sem stream configurado")
    return StreamingResponse(
        _mjpeg_gen(url),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache, no-store"},
    )


# ════════════════════════════════════════════════════════════════════════════
#  ENTRYPOINT
# ════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    n_workers = int(os.getenv("API_WORKERS", "1"))
    uvicorn_kwargs: dict = dict(
        host=os.getenv("API_HOST", "0.0.0.0"),
        port=int(os.getenv("API_PORT", "8000")),
        log_config=None,
    )
    # workers>1 uses multiprocess spawn which doubles background services.
    # For n_workers==1 run single-process mode (no spawn) to keep one service instance.
    if n_workers > 1:
        uvicorn_kwargs["workers"] = n_workers
    uvicorn.run("api:app", **uvicorn_kwargs)
