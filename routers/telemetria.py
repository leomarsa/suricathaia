"""
/app/routers/telemetria.py
SuricathaIA — Router de Vídeo Telemétrica
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any, Optional

import psycopg2
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from psycopg2.extras import RealDictCursor
from pydantic import BaseModel

from core.auth import require_role

_tel_auth = Depends(require_role("admin", "gerente"))

log    = logging.getLogger("suricatha.routers.telemetria")
router = APIRouter(prefix="/api/v1/telemetria", tags=["Telemétrica"])

PG_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db",
)
SNAPSHOTS_DIR = Path("/app/snapshots")
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)

# ── Mapeamento de tipos de evento por fabricante de câmera ────────────────────

_TIPO_MAP: dict[str, str] = {
    # Português / genérico
    "fadiga": "fadiga", "celular": "celular", "bocejo": "bocejo", "distracao": "distracao",
    # Inglês
    "fatigue": "fadiga", "phone": "celular", "yawn": "bocejo", "distraction": "distracao",
    "drowsiness": "fadiga", "smoking": "distracao",
    # Hikvision DSM
    "FatigueAlarm": "fadiga", "UsePhoneAlarm": "celular",
    "SmokeAlarm": "distracao", "DistractedAlarm": "distracao", "Yawn": "bocejo",
    # Dahua
    "Fatigue": "fadiga", "Phone": "celular", "Distraction": "distracao",
    # Códigos numéricos
    "1": "fadiga", "2": "celular", "3": "bocejo", "4": "distracao",
}

_SEV_DEFAULT: dict[str, str] = {
    "fadiga": "alto", "celular": "alto", "bocejo": "medio", "distracao": "medio",
}


def _conn():
    return psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)


def _ensure_webhook_token_column():
    """Migração lazy — adiciona webhook_token se ainda não existir."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    ALTER TABLE config_telemetria
                    ADD COLUMN IF NOT EXISTS webhook_token TEXT
                """)
            conn.commit()
    except Exception:
        pass


_ensure_webhook_token_column()


# ── Models ────────────────────────────────────────────────────────────────────

class MotoristaIn(BaseModel):
    nome:      str
    cpf:       Optional[str] = None
    cnh:       Optional[str] = None
    categoria: str = "B"
    telefone:  Optional[str] = None


class VeiculoIn(BaseModel):
    placa:        str
    modelo:       Optional[str] = None
    marca:        Optional[str] = None
    ano:          Optional[int] = None
    tipo:         str = "truck"
    camera_id:    Optional[int] = None
    motorista_id: Optional[int] = None


class ConfigTelIn(BaseModel):
    camera_id:        int
    ativo:            bool  = True
    ear_threshold:    float = 0.25
    ear_frames_alert: int   = 15
    mar_threshold:    float = 0.55
    phone_conf:       float = 0.55
    cooldown_seg:     int   = 60
    notif_sonoro:     bool  = True
    notif_whatsapp:   bool  = False
    notif_telegram:   bool  = False
    destinatarios:    list  = []


# ── Helpers internos ──────────────────────────────────────────────────────────

def _get_camera_config(camera_id: int) -> Optional[dict]:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT ct.*, c.nome AS camera_nome, c.url_stream,
                       v.id AS veiculo_id, v.placa AS veiculo_placa,
                       m.id AS motorista_id, m.nome AS motorista_nome,
                       ct.cooldown_seg, ct.notif_sonoro,
                       ct.notif_whatsapp, ct.notif_telegram, ct.destinatarios
                FROM config_telemetria ct
                JOIN cameras c ON c.id = ct.camera_id
                LEFT JOIN veiculos v   ON v.camera_id = ct.camera_id AND v.ativo
                LEFT JOIN motoristas m ON m.id = v.motorista_id AND m.ativo
                WHERE ct.camera_id = %s AND ct.ativo
            """, (camera_id,))
            return cur.fetchone()


def _save_webhook_event(
    camera_id: int,
    tipo: str,
    severidade: str,
    confianca: float,
    snapshot_bytes: Optional[bytes],
    veiculo_id: Optional[int],
    motorista_id: Optional[int],
    source_ts: Optional[datetime] = None,
) -> Optional[int]:
    snapshot_path: Optional[str] = None

    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO eventos_telemetria
                        (camera_id, veiculo_id, motorista_id, tipo_evento, severidade,
                         confianca, snapshot_path, detectado_em)
                    VALUES (%s,%s,%s,%s,%s,%s,%s, COALESCE(%s::timestamptz, NOW()))
                    RETURNING id
                """, (
                    camera_id, veiculo_id, motorista_id,
                    tipo, severidade, confianca, None,
                    source_ts.isoformat() if source_ts else None,
                ))
                ev_id = cur.fetchone()["id"]
            conn.commit()

        if snapshot_bytes:
            fname = f"tel_cam{camera_id}_{ev_id}.jpg"
            (SNAPSHOTS_DIR / fname).write_bytes(snapshot_bytes)
            with _conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE eventos_telemetria SET snapshot_path=%s WHERE id=%s",
                        (fname, ev_id),
                    )
                conn.commit()

        return ev_id

    except Exception as exc:
        log.error("[TELEMETRY-WEBHOOK] save evento erro: %s", exc)
        return None


def _sse_push_event(payload: dict):
    try:
        from services.rtsp_telemetry_service import _sse_push
        _sse_push(payload)
    except Exception:
        pass


def _send_notifications(cfg: dict, tipo: str):
    try:
        from services.rtsp_telemetry_service import _send_notification, TelCameraConfig
        tc = TelCameraConfig(
            camera_id      = cfg["camera_id"],
            camera_nome    = cfg["camera_nome"],
            url_stream     = cfg.get("url_stream", ""),
            veiculo_id     = cfg.get("veiculo_id"),
            veiculo_placa  = cfg.get("veiculo_placa"),
            motorista_id   = cfg.get("motorista_id"),
            motorista_nome = cfg.get("motorista_nome"),
            cooldown_seg   = cfg.get("cooldown_seg", 60),
            notif_sonoro   = bool(cfg.get("notif_sonoro", True)),
            notif_whatsapp = bool(cfg.get("notif_whatsapp", False)),
            notif_telegram = bool(cfg.get("notif_telegram", False)),
            destinatarios  = cfg.get("destinatarios") or [],
        )
        _send_notification(tc, tipo, tc.motorista_nome, tc.veiculo_placa, "")
    except Exception as exc:
        log.debug("[TELEMETRY-WEBHOOK] notif erro: %s", exc)


# cooldown em memória por (camera_id, tipo)
_wh_cooldown: dict[tuple, float] = {}


# ══ Webhook — recebe alertas das câmeras com detecção embarcada ═══════════════

@router.post("/camera/alert/{camera_id}", tags=["Webhook Câmera"])
async def camera_alert_webhook(
    camera_id:  int,
    request:    Request,
    token:      Optional[str] = Query(None, description="Token de autenticação da câmera"),
    x_camera_token: Optional[str] = Header(None, alias="X-Camera-Token"),
    snapshot:   Optional[UploadFile] = File(None),
):
    """
    Recebe alertas de câmeras com detecção embarcada (DSM).
    Compatível com: Hikvision, Dahua, Intelbras e câmeras genéricas HTTP.

    Autenticação via token de câmera (query ?token= ou header X-Camera-Token).

    Formatos de event_type aceitos:
      - Português: fadiga | celular | bocejo | distracao
      - Inglês: fatigue | phone | yawn | distraction
      - Hikvision: FatigueAlarm | UsePhoneAlarm | DistractedAlarm | Yawn
      - Dahua: Fatigue | Phone | Distraction
    """
    # ── Valida token ──────────────────────────────────────────────────────────
    auth_token = token or x_camera_token
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT webhook_token, ativo FROM config_telemetria WHERE camera_id=%s",
                (camera_id,),
            )
            cfg_row = cur.fetchone()

    if not cfg_row or not cfg_row["ativo"]:
        raise HTTPException(404, "Câmera não configurada para telemétrica")

    stored_token = cfg_row.get("webhook_token")
    if stored_token and auth_token != stored_token:
        raise HTTPException(403, "Token inválido")

    # ── Parse do corpo ────────────────────────────────────────────────────────
    body: dict[str, Any] = {}
    ct = request.headers.get("content-type", "")

    if "application/json" in ct:
        try:
            body = await request.json()
        except Exception:
            body = {}
    elif "multipart" not in ct:
        # tenta query params / form
        try:
            form = await request.form()
            body = dict(form)
        except Exception:
            pass

    # campos flexíveis — múltiplos nomes aceitos
    raw_tipo = (
        body.get("event_type") or body.get("eventType") or body.get("EventType") or
        body.get("tipo") or body.get("type") or "fadiga"
    )
    tipo = _TIPO_MAP.get(str(raw_tipo), "distracao")

    confianca = float(body.get("confidence") or body.get("conf") or body.get("score") or 0.8)
    confianca = max(0.0, min(1.0, confianca))

    severidade = body.get("severity") or body.get("severidade") or _SEV_DEFAULT.get(tipo, "medio")
    if severidade not in ("baixo", "medio", "alto", "critico"):
        severidade = _SEV_DEFAULT.get(tipo, "medio")

    source_ts: Optional[datetime] = None
    ts_raw = body.get("timestamp") or body.get("ts") or body.get("dateTime")
    if ts_raw:
        try:
            source_ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        except Exception:
            pass

    # ── Cooldown em memória ───────────────────────────────────────────────────
    key = (camera_id, tipo)
    agora = time.time()
    cooldown = 60
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT cooldown_seg FROM config_telemetria WHERE camera_id=%s", (camera_id,))
                row = cur.fetchone()
                if row:
                    cooldown = int(row["cooldown_seg"])
    except Exception:
        pass

    if agora - _wh_cooldown.get(key, 0) < cooldown:
        return {"ok": False, "skipped": "cooldown"}
    _wh_cooldown[key] = agora

    # ── Snapshot ──────────────────────────────────────────────────────────────
    snap_bytes: Optional[bytes] = None
    if snapshot:
        snap_bytes = await snapshot.read()

    # ── Busca veiculo / motorista ─────────────────────────────────────────────
    veiculo_id: Optional[int] = None
    motorista_id: Optional[int] = None
    camera_nome = f"Câmera {camera_id}"
    veiculo_placa: Optional[str] = None
    motorista_nome: Optional[str] = None

    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT c.nome AS camera_nome,
                           v.id AS veiculo_id, v.placa AS veiculo_placa,
                           m.id AS motorista_id, m.nome AS motorista_nome,
                           ct.cooldown_seg, ct.notif_sonoro,
                           ct.notif_whatsapp, ct.notif_telegram, ct.destinatarios
                    FROM cameras c
                    LEFT JOIN config_telemetria ct ON ct.camera_id = c.id
                    LEFT JOIN veiculos v   ON v.camera_id = c.id AND v.ativo
                    LEFT JOIN motoristas m ON m.id = v.motorista_id AND m.ativo
                    WHERE c.id = %s
                """, (camera_id,))
                cam_row = cur.fetchone()
        if cam_row:
            camera_nome    = cam_row["camera_nome"] or camera_nome
            veiculo_id     = cam_row["veiculo_id"]
            veiculo_placa  = cam_row["veiculo_placa"]
            motorista_id   = cam_row["motorista_id"]
            motorista_nome = cam_row["motorista_nome"]
            cfg_for_notif  = dict(cam_row)
            cfg_for_notif["camera_id"] = camera_id
    except Exception as exc:
        log.warning("[TELEMETRY-WEBHOOK] lookup cam_id=%d: %s", camera_id, exc)
        cfg_for_notif = {"camera_id": camera_id, "camera_nome": camera_nome}

    # ── Grava no banco ────────────────────────────────────────────────────────
    ev_id = _save_webhook_event(
        camera_id, tipo, severidade, confianca,
        snap_bytes, veiculo_id, motorista_id, source_ts,
    )

    snap_url = f"/api/v1/telemetria/eventos/{ev_id}/snapshot" if ev_id and snap_bytes else None

    log.info(
        "[TELEMETRY-WEBHOOK] cam_id=%d tipo=%s sev=%s conf=%.2f ev_id=%s",
        camera_id, tipo, severidade, confianca, ev_id,
    )

    # ── SSE ───────────────────────────────────────────────────────────────────
    _sse_push_event({
        "type"          : "telemetria_alerta",
        "evento_id"     : ev_id,
        "camera_id"     : camera_id,
        "camera_nome"   : camera_nome,
        "tipo_evento"   : tipo,
        "severidade"    : severidade,
        "confianca"     : confianca,
        "veiculo_placa" : veiculo_placa,
        "motorista_nome": motorista_nome,
        "snapshot_url"  : snap_url,
        "ts"            : datetime.utcnow().isoformat(),
        "sonoro"        : True,
        "source"        : "camera_embarcada",
    })

    # ── Notificações ──────────────────────────────────────────────────────────
    _send_notifications(cfg_for_notif, tipo)

    return {"ok": True, "evento_id": ev_id, "tipo": tipo, "severidade": severidade}


# ── Token de câmera ───────────────────────────────────────────────────────────

@router.post("/camera/token/{camera_id}", tags=["Webhook Câmera"])
def generate_camera_token(camera_id: int, auth=_tel_auth):
    """Gera ou regenera o token de webhook para uma câmera."""
    token = secrets.token_urlsafe(24)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE config_telemetria SET webhook_token=%s WHERE camera_id=%s RETURNING webhook_token
            """, (token, camera_id))
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(404, "Config não encontrada para esta câmera")
    return {"camera_id": camera_id, "webhook_token": row["webhook_token"]}


@router.get("/camera/token/{camera_id}", tags=["Webhook Câmera"])
def get_camera_token(camera_id: int, auth=_tel_auth):
    """Retorna o token atual de webhook da câmera (gera se não existir)."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT webhook_token FROM config_telemetria WHERE camera_id=%s",
                (camera_id,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Config não encontrada para esta câmera")
    token = row.get("webhook_token")
    if not token:
        return generate_camera_token(camera_id, auth=auth)
    return {"camera_id": camera_id, "webhook_token": token}


# ══ Motoristas ════════════════════════════════════════════════════════════════

@router.get("/motoristas")
def list_motoristas(auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.*, v.placa AS veiculo_placa, v.modelo AS veiculo_modelo
                FROM motoristas m
                LEFT JOIN veiculos v ON v.motorista_id = m.id AND v.ativo
                WHERE m.ativo ORDER BY m.nome
            """)
            return cur.fetchall()


@router.post("/motoristas", status_code=201)
def create_motorista(body: MotoristaIn, auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO motoristas (nome, cpf, cnh, categoria, telefone)
                VALUES (%s,%s,%s,%s,%s) RETURNING *
            """, (body.nome, body.cpf, body.cnh, body.categoria, body.telefone))
            row = cur.fetchone()
        conn.commit()
    return row


@router.patch("/motoristas/{mid}")
def update_motorista(mid: int, body: dict, auth=_tel_auth):
    allowed = {"nome", "cpf", "cnh", "categoria", "telefone", "ativo"}
    fields  = {k: v for k, v in body.items() if k in allowed}
    if not fields:
        raise HTTPException(400, "Nenhum campo válido")
    sets = ", ".join(f"{k}=%s" for k in fields)
    vals = list(fields.values()) + [mid]
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE motoristas SET {sets} WHERE id=%s RETURNING *", vals)
            row = cur.fetchone()
        conn.commit()
    return row


@router.delete("/motoristas/{mid}")
def delete_motorista(mid: int, auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE motoristas SET ativo=FALSE WHERE id=%s", (mid,))
        conn.commit()
    return {"ok": True}


# ══ Veículos ══════════════════════════════════════════════════════════════════

@router.get("/veiculos")
def list_veiculos(auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT v.*, m.nome AS motorista_nome, c.nome AS camera_nome,
                       ct.ativo AS telemetria_ativa
                FROM veiculos v
                LEFT JOIN motoristas m ON m.id = v.motorista_id
                LEFT JOIN cameras c    ON c.id = v.camera_id
                LEFT JOIN config_telemetria ct ON ct.camera_id = v.camera_id
                WHERE v.ativo ORDER BY v.placa
            """)
            return cur.fetchall()


@router.post("/veiculos", status_code=201)
def create_veiculo(body: VeiculoIn, auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO veiculos (placa, modelo, marca, ano, tipo, camera_id, motorista_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """, (body.placa, body.modelo, body.marca, body.ano,
                  body.tipo, body.camera_id, body.motorista_id))
            row = cur.fetchone()
        conn.commit()
    return row


@router.patch("/veiculos/{vid}")
def update_veiculo(vid: int, body: dict, auth=_tel_auth):
    allowed = {"placa", "modelo", "marca", "ano", "tipo", "camera_id", "motorista_id", "ativo"}
    fields  = {k: v for k, v in body.items() if k in allowed}
    if not fields:
        raise HTTPException(400, "Nenhum campo válido")
    sets = ", ".join(f"{k}=%s" for k in fields)
    vals = list(fields.values()) + [vid]
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE veiculos SET {sets} WHERE id=%s RETURNING *", vals)
            row = cur.fetchone()
        conn.commit()
    return row


@router.delete("/veiculos/{vid}")
def delete_veiculo(vid: int, auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE veiculos SET ativo=FALSE WHERE id=%s", (vid,))
        conn.commit()
    return {"ok": True}


# ══ Configuração ══════════════════════════════════════════════════════════════

@router.get("/config")
def list_configs(auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT ct.*, c.nome AS camera_nome
                FROM config_telemetria ct
                JOIN cameras c ON c.id = ct.camera_id
                ORDER BY c.nome
            """)
            return cur.fetchall()


@router.put("/config")
def upsert_config(body: ConfigTelIn, auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO config_telemetria
                    (camera_id, ativo, ear_threshold, ear_frames_alert,
                     mar_threshold, phone_conf, cooldown_seg,
                     notif_sonoro, notif_whatsapp, notif_telegram, destinatarios)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (camera_id) DO UPDATE SET
                    ativo=EXCLUDED.ativo,
                    ear_threshold=EXCLUDED.ear_threshold,
                    ear_frames_alert=EXCLUDED.ear_frames_alert,
                    mar_threshold=EXCLUDED.mar_threshold,
                    phone_conf=EXCLUDED.phone_conf,
                    cooldown_seg=EXCLUDED.cooldown_seg,
                    notif_sonoro=EXCLUDED.notif_sonoro,
                    notif_whatsapp=EXCLUDED.notif_whatsapp,
                    notif_telegram=EXCLUDED.notif_telegram,
                    destinatarios=EXCLUDED.destinatarios
                RETURNING *
            """, (
                body.camera_id, body.ativo,
                body.ear_threshold, body.ear_frames_alert,
                body.mar_threshold, body.phone_conf, body.cooldown_seg,
                body.notif_sonoro, body.notif_whatsapp, body.notif_telegram,
                json.dumps(body.destinatarios),
            ))
            row = cur.fetchone()
        conn.commit()

    from services.rtsp_telemetry_service import get_service
    svc = get_service()
    if svc:
        svc.reload()

    return row


# ══ Eventos ═══════════════════════════════════════════════════════════════════

@router.get("/eventos")
def list_eventos(
    auth=_tel_auth,
    camera_id:  Optional[int]  = None,
    veiculo_id: Optional[int]  = None,
    tipo:       Optional[str]  = None,
    severidade: Optional[str]  = None,
    data_ini:   Optional[date] = Query(None),
    data_fim:   Optional[date] = Query(None),
    limit:      int            = Query(50, le=200),
    offset:     int            = 0,
):
    filters = ["1=1"]
    params: list = []

    if camera_id:  filters.append("et.camera_id=%s");    params.append(camera_id)
    if veiculo_id: filters.append("et.veiculo_id=%s");   params.append(veiculo_id)
    if tipo:       filters.append("et.tipo_evento=%s");  params.append(tipo)
    if severidade: filters.append("et.severidade=%s");   params.append(severidade)
    if data_ini:   filters.append("et.detectado_em >= %s"); params.append(data_ini)
    if data_fim:   filters.append("et.detectado_em < %s + INTERVAL '1 day'"); params.append(data_fim)

    where = " AND ".join(filters)
    params += [limit, offset]

    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT et.*,
                       v.placa AS veiculo_placa,
                       m.nome  AS motorista_nome,
                       c.nome  AS camera_nome
                FROM eventos_telemetria et
                LEFT JOIN veiculos   v ON v.id = et.veiculo_id
                LEFT JOIN motoristas m ON m.id = et.motorista_id
                LEFT JOIN cameras    c ON c.id = et.camera_id
                WHERE {where}
                ORDER BY et.detectado_em DESC
                LIMIT %s OFFSET %s
            """, params)
            rows = list(cur.fetchall())

    for r in rows:
        r["snapshot_url"] = (
            f"/api/v1/telemetria/eventos/{r['id']}/snapshot"
            if r.get("snapshot_path") else None
        )
    return rows


@router.get("/eventos/{ev_id}/snapshot")
def evento_snapshot(ev_id: int, auth=_tel_auth):
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT snapshot_path FROM eventos_telemetria WHERE id=%s", (ev_id,))
            row = cur.fetchone()
    if not row or not row["snapshot_path"]:
        raise HTTPException(404, "Snapshot não encontrado")
    path = SNAPSHOTS_DIR / row["snapshot_path"]
    if not path.exists():
        raise HTTPException(404, "Arquivo não encontrado")
    return FileResponse(str(path), media_type="image/jpeg")


@router.get("/stats")
def telemetria_stats(
    auth=_tel_auth,
    data_ini: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
):
    params_base: list = []
    date_filter = ""
    if data_ini:
        date_filter += " AND detectado_em >= %s"; params_base.append(data_ini)
    if data_fim:
        date_filter += " AND detectado_em < %s + INTERVAL '1 day'"; params_base.append(data_fim)

    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT
                    COUNT(*) FILTER (WHERE tipo_evento='fadiga')    AS total_fadiga,
                    COUNT(*) FILTER (WHERE tipo_evento='celular')   AS total_celular,
                    COUNT(*) FILTER (WHERE tipo_evento='bocejo')    AS total_bocejo,
                    COUNT(*) FILTER (WHERE tipo_evento='distracao') AS total_distracao,
                    COUNT(*) AS total_geral
                FROM eventos_telemetria WHERE 1=1 {date_filter}
            """, params_base)
            totais = dict(cur.fetchone())

            cur.execute(f"""
                SELECT m.nome AS motorista, COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE tipo_evento='fadiga')  AS fadiga,
                       COUNT(*) FILTER (WHERE tipo_evento='celular') AS celular
                FROM eventos_telemetria et
                JOIN motoristas m ON m.id = et.motorista_id
                WHERE 1=1 {date_filter}
                GROUP BY m.nome ORDER BY total DESC LIMIT 10
            """, params_base)
            por_motorista = cur.fetchall()

            cur.execute(f"""
                SELECT tipo_evento, severidade, COUNT(*) AS total
                FROM eventos_telemetria WHERE 1=1 {date_filter}
                GROUP BY tipo_evento, severidade ORDER BY tipo_evento, severidade
            """, params_base)
            por_tipo = cur.fetchall()

    return {"totais": totais, "por_motorista": por_motorista, "por_tipo": por_tipo}


# ══ Sistema ═══════════════════════════════════════════════════════════════════

@router.get("/system/status")
def tel_system_status(auth=_tel_auth):
    from services.rtsp_telemetry_service import get_service
    svc = get_service()
    return {"workers": svc.status() if svc else [], "ativo": svc is not None}


@router.post("/system/reload")
def tel_system_reload(auth=_tel_auth):
    from services.rtsp_telemetry_service import get_service
    svc = get_service()
    if not svc:
        raise HTTPException(503, "Serviço não iniciado")
    svc.reload()
    return {"ok": True, "workers": svc.status()}
