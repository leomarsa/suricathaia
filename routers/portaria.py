"""
/app/routers/portaria.py
SuricathaIA — Gestão de Portaria
Modelo unificado: Pessoas (funcionario/visitante/prestador) + Visitas
"""
import os, re, json, time, uuid, logging, shutil, secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor
from fastapi import APIRouter, HTTPException, Query, Depends, Request, UploadFile, File, Form
from pydantic import BaseModel, Field

from core.auth import require_auth, require_role

log    = logging.getLogger("suricatha.portaria")
router = APIRouter(prefix="/api/v1/portaria", tags=["Portaria"])

DB_DSN      = os.getenv("POSTGRES_DSN", "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db")
STORAGE_DIR = Path(os.getenv("STORAGE_DIR", "/opt/suricatha/storage")) / "portaria"
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXT         = {".jpg", ".jpeg", ".png", ".webp"}
MAX_FOTOS_VEICULO   = 6
MAX_FOTOS_DOCUMENTO = 4
TIPOS_PESSOA        = ("funcionario", "visitante", "prestador")
TIPOS_DOC           = ("CPF", "RG", "CNH", "Passaporte", "RNE", "Outro")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _conn():
    return psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)

def _ts():
    return time.strftime("%Y-%m-%d %H:%M:%S")

def _now():
    return datetime.now(timezone.utc)

def _json_safe(obj):
    if isinstance(obj, dict):   return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)): return [_json_safe(v) for v in obj]
    if isinstance(obj, datetime): return obj.isoformat()
    return obj

def _audit(conn, tabela, operacao, registro_id, antes=None, depois=None,
           usuario_id=None, ip=None):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO audit_logs
                (tabela, operacao, registro_id, dados_antes, dados_depois, usuario_id, ip_cliente)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
        """, (tabela, operacao, registro_id,
              json.dumps(_json_safe(dict(antes)))  if antes  else None,
              json.dumps(_json_safe(dict(depois))) if depois else None,
              usuario_id, ip))

def _save_photo(file: UploadFile, subfolder: str) -> str:
    ext = Path(file.filename or "foto.jpg").suffix.lower()
    if ext not in ALLOWED_EXT: ext = ".jpg"
    dest = STORAGE_DIR / subfolder
    dest.mkdir(parents=True, exist_ok=True)
    fname = f"{uuid.uuid4().hex}{ext}"
    with (dest / fname).open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return f"/storage/portaria/{subfolder}/{fname}"

def _try_delete(url: str):
    try:
        path = Path(os.getenv("STORAGE_DIR", "/opt/suricatha/storage")) / url.removeprefix("/storage/")
        if path.exists(): path.unlink()
    except Exception:
        pass


# ── Schemas ───────────────────────────────────────────────────────────────────

class PessoaCreate(BaseModel):
    tipo:           str           = Field("visitante")
    nome:           str           = Field(..., min_length=2, max_length=128)
    cpf:            Optional[str] = Field(None, max_length=14)
    rg:             Optional[str] = None
    cnh:            Optional[str] = Field(None, max_length=11)
    telefone:       Optional[str] = None
    empresa:        Optional[str] = None
    departamento:   Optional[str] = None
    ramal:          Optional[str] = None
    email:          Optional[str] = None
    observacoes:    Optional[str] = None
    # legado — mantido por compatibilidade
    documento:      Optional[str] = Field(None, max_length=32)
    tipo_documento: str           = Field("CPF")

class PessoaUpdate(BaseModel):
    tipo:            Optional[str]  = None
    nome:            Optional[str]  = None
    cpf:             Optional[str]  = None
    rg:              Optional[str]  = None
    cnh:             Optional[str]  = None
    telefone:        Optional[str]  = None
    empresa:         Optional[str]  = None
    departamento:    Optional[str]  = None
    ramal:           Optional[str]  = None
    email:           Optional[str]  = None
    status_blacklist: Optional[bool] = None
    ativo:           Optional[bool] = None
    observacoes:     Optional[str]  = None
    # legado
    documento:       Optional[str]  = None
    tipo_documento:  Optional[str]  = None

class EntradaBody(BaseModel):
    pessoa_visitante_id: int
    pessoa_visitado_id:  Optional[int] = None
    placa_veiculo:       Optional[str] = None
    motivo:              Optional[str] = None
    observacoes:         Optional[str] = None
    status:              str           = Field("em_visita")

class AgendarBody(BaseModel):
    pessoa_visitante_id: int
    pessoa_visitado_id:  Optional[int] = None
    placa_veiculo:       Optional[str] = None
    motivo:              Optional[str] = None
    observacoes:         Optional[str] = None

class SaidaBody(BaseModel):
    observacoes: Optional[str] = None


# ── PESSOAS ───────────────────────────────────────────────────────────────────

def _normalizar_cpf(cpf: str) -> str:
    return re.sub(r'\D', '', cpf).upper()

def _validar_cpf(cpf: str) -> bool:
    n = re.sub(r'\D', '', cpf)
    if len(n) != 11 or len(set(n)) == 1:
        return False
    for k in (9, 10):
        s = sum(int(n[i]) * (k + 1 - i) for i in range(k))
        d = (s * 10 % 11) % 10
        if d != int(n[k]):
            return False
    return True

_PESSOA_FIELDS = """
    id, tipo, nome, cpf, rg, cnh, telefone,
    empresa, departamento, ramal, email,
    foto_url, fotos_documento, status_blacklist, observacoes, ativo, criado_em,
    documento, tipo_documento
"""

@router.get("/pessoas/check-cpf")
def check_cpf(cpf: str = Query(...), excluir_id: Optional[int] = Query(None),
              auth: dict = Depends(require_auth)):
    cpf_norm = _normalizar_cpf(cpf)
    if not _validar_cpf(cpf_norm):
        return {"valido": False, "duplicado": False, "erro": "CPF inválido"}
    conn = _conn()
    try:
        with conn.cursor() as cur:
            if excluir_id:
                cur.execute("SELECT id, nome FROM pessoas WHERE cpf=%s AND id<>%s", (cpf_norm, excluir_id))
            else:
                cur.execute("SELECT id, nome FROM pessoas WHERE cpf=%s", (cpf_norm,))
            row = cur.fetchone()
        if row:
            return {"valido": True, "duplicado": True, "nome_existente": row["nome"], "id_existente": row["id"]}
        return {"valido": True, "duplicado": False}
    finally:
        conn.close()


@router.get("/publico/check-cpf")
def check_cpf_publico(cpf: str = Query(...)):
    cpf_norm = _normalizar_cpf(cpf)
    if not _validar_cpf(cpf_norm):
        return {"valido": False, "duplicado": False, "erro": "CPF inválido"}
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, nome FROM pessoas WHERE cpf=%s", (cpf_norm,))
            row = cur.fetchone()
        if row:
            return {"valido": True, "duplicado": True, "nome_existente": row["nome"]}
        return {"valido": True, "duplicado": False}
    finally:
        conn.close()


@router.get("/pessoas")
def listar_pessoas(
    q:     str = Query("", max_length=64),
    tipo:  str = Query(""),
    ativo: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    auth: dict = Depends(require_auth),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            where, params = ["1=1"], []
            if tipo and tipo in TIPOS_PESSOA:
                where.append("tipo=%s"); params.append(tipo)
            if ativo is not None:
                where.append("ativo=%s"); params.append(ativo)
            if q:
                where.append("""(
                    lower(nome) LIKE lower(%s) OR documento ILIKE %s
                    OR rg ILIKE %s OR telefone ILIKE %s
                    OR lower(empresa) LIKE lower(%s) OR lower(departamento) LIKE lower(%s)
                )""")
                params += [f"%{q}%"] * 6

            w = " AND ".join(where)
            cur.execute(f"""
                SELECT {_PESSOA_FIELDS} FROM pessoas
                WHERE {w} ORDER BY nome LIMIT %s OFFSET %s
            """, params + [limit, offset])
            rows = cur.fetchall()
            cur.execute(f"SELECT COUNT(*) AS n FROM pessoas WHERE {w}", params)
            total = cur.fetchone()["n"]
        return {"total": total, "data": [dict(r) for r in rows]}
    finally:
        conn.close()


@router.post("/pessoas", status_code=201)
def criar_pessoa(body: PessoaCreate, request: Request, auth: dict = Depends(require_role("admin", "operador"))):
    if body.tipo not in TIPOS_PESSOA:
        raise HTTPException(422, f"tipo inválido: {body.tipo}")
    if body.cpf:
        cpf_norm = _normalizar_cpf(body.cpf)
        if not _validar_cpf(cpf_norm):
            raise HTTPException(422, "CPF inválido")
        body = body.model_copy(update={"cpf": cpf_norm})
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                INSERT INTO pessoas
                    (tipo, nome, cpf, rg, cnh, telefone,
                     empresa, departamento, ramal, email, observacoes,
                     documento, tipo_documento)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING {_PESSOA_FIELDS}
            """, (body.tipo,
                  body.nome.strip(),
                  body.cpf.strip().upper() if body.cpf else None,
                  body.rg.strip().upper() if body.rg else None,
                  body.cnh.strip().upper() if body.cnh else None,
                  body.telefone.strip() if body.telefone else None,
                  body.empresa.strip() if body.empresa else None,
                  body.departamento.strip() if body.departamento else None,
                  body.ramal.strip() if body.ramal else None,
                  body.email.strip().lower() if body.email else None,
                  body.observacoes,
                  body.documento.strip().upper() if body.documento else None,
                  body.tipo_documento))
            row = cur.fetchone()
            _audit(conn, "pessoas", "INSERT", row["id"], depois=row,
                   usuario_id=auth.get("sub"), ip=request.client.host if request.client else None)
        conn.commit()
        return dict(row)
    except psycopg2.errors.UniqueViolation as e:
        conn.rollback()
        msg = "CPF já cadastrado para outra pessoa" if "pessoas_cpf_unique" in str(e) else "Documento já cadastrado para outra pessoa"
        raise HTTPException(409, msg)
    finally:
        conn.close()


@router.get("/pessoas/{pid}")
def get_pessoa(pid: int, auth: dict = Depends(require_auth)):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {_PESSOA_FIELDS} FROM pessoas WHERE id=%s", (pid,))
            row = cur.fetchone()
            if not row: raise HTTPException(404, "Pessoa não encontrada")
        return dict(row)
    finally:
        conn.close()


@router.patch("/pessoas/{pid}")
def atualizar_pessoa(pid: int, body: PessoaUpdate, request: Request,
                     auth: dict = Depends(require_role("admin", "operador"))):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {_PESSOA_FIELDS} FROM pessoas WHERE id=%s", (pid,))
            antes = cur.fetchone()
            if not antes: raise HTTPException(404, "Pessoa não encontrada")

            fields, vals = [], []
            if body.tipo            is not None: fields.append("tipo=%s");            vals.append(body.tipo)
            if body.nome            is not None: fields.append("nome=%s");            vals.append(body.nome.strip())
            if body.cpf             is not None: fields.append("cpf=%s");             vals.append(body.cpf.strip().upper() if body.cpf.strip() else None)
            if body.rg              is not None: fields.append("rg=%s");              vals.append(body.rg.strip().upper() if body.rg.strip() else None)
            if body.cnh             is not None: fields.append("cnh=%s");             vals.append(body.cnh.strip().upper() if body.cnh.strip() else None)
            if body.telefone        is not None: fields.append("telefone=%s");        vals.append(body.telefone)
            if body.empresa         is not None: fields.append("empresa=%s");         vals.append(body.empresa)
            if body.departamento    is not None: fields.append("departamento=%s");    vals.append(body.departamento)
            if body.ramal           is not None: fields.append("ramal=%s");           vals.append(body.ramal)
            if body.email           is not None: fields.append("email=%s");           vals.append(body.email.lower() if body.email else None)
            if body.status_blacklist is not None: fields.append("status_blacklist=%s"); vals.append(body.status_blacklist)
            if body.ativo           is not None: fields.append("ativo=%s");           vals.append(body.ativo)
            if body.observacoes     is not None: fields.append("observacoes=%s");     vals.append(body.observacoes)
            if body.documento       is not None: fields.append("documento=%s");       vals.append(body.documento.strip().upper() if body.documento.strip() else None)
            if body.tipo_documento  is not None: fields.append("tipo_documento=%s");  vals.append(body.tipo_documento)
            if not fields: return dict(antes)

            fields.append("atualizado_em=NOW()")
            vals.append(pid)
            cur.execute(f"UPDATE pessoas SET {','.join(fields)} WHERE id=%s RETURNING {_PESSOA_FIELDS}", vals)
            depois = cur.fetchone()
            _audit(conn, "pessoas", "UPDATE", pid, antes=antes, depois=depois,
                   usuario_id=auth.get("sub"), ip=request.client.host if request.client else None)
        conn.commit()
        return dict(depois)
    finally:
        conn.close()


# ── UPLOAD FOTOS ──────────────────────────────────────────────────────────────

@router.post("/upload/foto-rosto/{pid}")
async def upload_foto_rosto(
    pid: int, foto: UploadFile = File(...),
    auth: dict = Depends(require_role("admin", "operador")),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT foto_url FROM pessoas WHERE id=%s", (pid,))
            row = cur.fetchone()
            if not row: raise HTTPException(404, "Pessoa não encontrada")
            if row["foto_url"]: _try_delete(row["foto_url"])
            url = _save_photo(foto, f"rosto/{pid}")
            cur.execute("UPDATE pessoas SET foto_url=%s, atualizado_em=NOW() WHERE id=%s", (url, pid))
        conn.commit()
        return {"foto_url": url}
    finally:
        conn.close()


@router.delete("/upload/foto-rosto/{pid}")
def remover_foto_rosto(pid: int, auth: dict = Depends(require_role("admin", "operador"))):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT foto_url FROM pessoas WHERE id=%s", (pid,))
            row = cur.fetchone()
            if not row: raise HTTPException(404, "Pessoa não encontrada")
            if row["foto_url"]: _try_delete(row["foto_url"])
            cur.execute("UPDATE pessoas SET foto_url=NULL, atualizado_em=NOW() WHERE id=%s", (pid,))
        conn.commit()
        return {"foto_url": None}
    finally:
        conn.close()


@router.post("/upload/documento/{pid}")
async def upload_foto_documento(
    pid: int, foto: UploadFile = File(...),
    auth: dict = Depends(require_role("admin", "operador")),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT fotos_documento FROM pessoas WHERE id=%s", (pid,))
            row = cur.fetchone()
            if not row: raise HTTPException(404, "Pessoa não encontrada")
            fotos = list(row["fotos_documento"] or [])
            if len(fotos) >= MAX_FOTOS_DOCUMENTO:
                raise HTTPException(400, f"Máximo de {MAX_FOTOS_DOCUMENTO} fotos de documento")
            url = _save_photo(foto, f"documento/{pid}")
            fotos.append(url)
            cur.execute("UPDATE pessoas SET fotos_documento=%s WHERE id=%s", (fotos, pid))
        conn.commit()
        return {"url": url, "fotos": fotos}
    finally:
        conn.close()


@router.delete("/upload/documento/{pid}")
def remover_foto_documento(
    pid: int, url: str = Query(...),
    auth: dict = Depends(require_role("admin", "operador")),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT fotos_documento FROM pessoas WHERE id=%s", (pid,))
            row = cur.fetchone()
            if not row: raise HTTPException(404, "Pessoa não encontrada")
            fotos = [f for f in (row["fotos_documento"] or []) if f != url]
            cur.execute("UPDATE pessoas SET fotos_documento=%s WHERE id=%s", (fotos, pid))
            _try_delete(url)
        conn.commit()
        return {"fotos": fotos}
    finally:
        conn.close()


@router.post("/upload/veiculo")
async def upload_foto_veiculo(
    visita_id: int = Form(...), foto: UploadFile = File(...),
    auth: dict = Depends(require_role("admin", "operador")),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT fotos_veiculo FROM visitas WHERE id=%s", (visita_id,))
            row = cur.fetchone()
            if not row: raise HTTPException(404, "Visita não encontrada")
            fotos = list(row["fotos_veiculo"] or [])
            if len(fotos) >= MAX_FOTOS_VEICULO:
                raise HTTPException(400, f"Máximo de {MAX_FOTOS_VEICULO} fotos por visita")
            url = _save_photo(foto, f"veiculo/{visita_id}")
            fotos.append(url)
            cur.execute("UPDATE visitas SET fotos_veiculo=%s WHERE id=%s", (fotos, visita_id))
        conn.commit()
        return {"url": url, "fotos": fotos}
    finally:
        conn.close()


@router.delete("/upload/veiculo/{visita_id}")
def remover_foto_veiculo(
    visita_id: int, url: str = Query(...),
    auth: dict = Depends(require_role("admin", "operador")),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT fotos_veiculo FROM visitas WHERE id=%s", (visita_id,))
            row = cur.fetchone()
            if not row: raise HTTPException(404, "Visita não encontrada")
            fotos = [f for f in (row["fotos_veiculo"] or []) if f != url]
            cur.execute("UPDATE visitas SET fotos_veiculo=%s WHERE id=%s", (fotos, visita_id))
            _try_delete(url)
        conn.commit()
        return {"fotos": fotos}
    finally:
        conn.close()


# ── STATUS (visitas ativas) ───────────────────────────────────────────────────

_VISITA_SELECT = """
    SELECT
        v.id, v.status, v.pre_cadastro, v.visitado_texto, v.data_entrada, v.data_saida,
        v.placa_veiculo, v.fotos_veiculo, v.motivo, v.observacoes,
        pv.id  AS pessoa_visitante_id, pv.tipo AS visitante_tipo,
        pv.nome AS visitante_nome, pv.empresa AS visitante_empresa,
        pv.foto_url AS visitante_foto, pv.telefone AS visitante_telefone,
        pv.status_blacklist AS visitante_blacklist,
        pv.cpf AS visitante_cpf, pv.rg AS visitante_rg, pv.cnh AS visitante_cnh,
        pv.fotos_documento AS visitante_fotos_doc,
        pvd.id   AS pessoa_visitado_id,
        pvd.nome AS visitado_nome,
        pvd.departamento AS visitado_departamento,
        pvd.ramal AS visitado_ramal,
        pvd.email AS visitado_email,
        EXTRACT(EPOCH FROM (NOW() - v.data_entrada)) AS duracao_seg
    FROM visitas v
    JOIN pessoas pv  ON pv.id  = v.pessoa_visitante_id
    LEFT JOIN pessoas pvd ON pvd.id = v.pessoa_visitado_id
"""

@router.get("/status")
def status_portaria(auth: dict = Depends(require_auth)):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(_VISITA_SELECT + """
                WHERE v.status IN ('em_visita','aguardando','agendado')
                AND v.pessoa_visitante_id IS NOT NULL
                ORDER BY
                    CASE v.status
                        WHEN 'em_visita'  THEN 0
                        WHEN 'aguardando' THEN 1
                        WHEN 'agendado'   THEN 2
                    END,
                    v.data_entrada DESC NULLS LAST
            """)
            visitas = cur.fetchall()

            cur.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE status='em_visita')  AS em_visita,
                    COUNT(*) FILTER (WHERE status='aguardando') AS aguardando,
                    COUNT(*) FILTER (WHERE status='agendado')   AS agendados,
                    COUNT(*) FILTER (WHERE status='saiu'
                        AND data_saida >= NOW() - INTERVAL '24h') AS saidas_hoje
                FROM visitas
                WHERE status IN ('em_visita','aguardando','agendado')
                   OR (status='saiu' AND data_saida >= NOW() - INTERVAL '24h')
            """)
            resumo = cur.fetchone()
        return {"resumo": dict(resumo), "visitas": [dict(r) for r in visitas]}
    finally:
        conn.close()


# ── HISTÓRICO ─────────────────────────────────────────────────────────────────

@router.get("/visitas")
def listar_visitas(
    status: str = Query(""),
    q:      str = Query(""),
    limit:  int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    auth:   dict = Depends(require_auth),
):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            where, params = ["v.pessoa_visitante_id IS NOT NULL"], []
            if status: where.append("v.status=%s"); params.append(status)
            if q:
                where.append("(lower(pv.nome) LIKE lower(%s) OR pv.cpf ILIKE %s OR pv.rg ILIKE %s OR pv.telefone ILIKE %s)")
                params += [f"%{q}%"] * 4
            w = " AND ".join(where)
            cur.execute(f"""
                SELECT
                    v.id, v.status, v.data_entrada, v.data_saida,
                    v.placa_veiculo, v.fotos_veiculo, v.motivo, v.observacoes, v.criado_em,
                    pv.id AS pessoa_visitante_id, pv.tipo AS visitante_tipo,
                    pv.nome AS visitante_nome, pv.empresa, pv.cpf, pv.rg, pv.cnh,
                    pv.telefone, pv.foto_url, pv.fotos_documento, pv.status_blacklist,
                    pvd.nome AS visitado_nome, pvd.departamento, pvd.ramal
                FROM visitas v
                JOIN pessoas pv ON pv.id = v.pessoa_visitante_id
                LEFT JOIN pessoas pvd ON pvd.id = v.pessoa_visitado_id
                WHERE {w}
                ORDER BY v.criado_em DESC
                LIMIT %s OFFSET %s
            """, params + [limit, offset])
            rows = cur.fetchall()
            cur.execute(f"""
                SELECT COUNT(*) AS n FROM visitas v
                JOIN pessoas pv ON pv.id = v.pessoa_visitante_id
                WHERE {w}
            """, params)
            total = cur.fetchone()["n"]
        return {"total": total, "data": [dict(r) for r in rows]}
    finally:
        conn.close()


# ── ENTRADA (check-in) ────────────────────────────────────────────────────────

@router.post("/visitas/entrada")
def registrar_entrada(body: EntradaBody, request: Request,
                      auth: dict = Depends(require_role("admin", "operador"))):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM pessoas WHERE id=%s AND ativo=TRUE", (body.pessoa_visitante_id,))
            visitante = cur.fetchone()
            if not visitante: raise HTTPException(404, "Visitante não encontrado")
            if visitante["status_blacklist"]:
                raise HTTPException(403, "Pessoa bloqueada — consta na lista negra")

            # Verifica se já há entrada ativa
            cur.execute("""
                SELECT id FROM visitas
                WHERE pessoa_visitante_id=%s AND status IN ('em_visita','aguardando')
                LIMIT 1
            """, (body.pessoa_visitante_id,))
            if cur.fetchone():
                raise HTTPException(409, "Pessoa já possui entrada ativa")

            # Verifica se há agendamento pendente para reaproveitar
            cur.execute("""
                SELECT id FROM visitas
                WHERE pessoa_visitante_id=%s AND status='agendado'
                ORDER BY criado_em DESC LIMIT 1
            """, (body.pessoa_visitante_id,))
            agendada = cur.fetchone()

            # LPR: vincula detecção da placa nas últimas 2h
            lpr_id = None
            placa = (body.placa_veiculo or "").strip().upper() or None
            if placa:
                cur.execute("""
                    SELECT id FROM deteccoes
                    WHERE placa=%s AND detectado_em >= NOW() - INTERVAL '2 hours'
                    ORDER BY detectado_em DESC LIMIT 1
                """, (placa,))
                det = cur.fetchone()
                if det: lpr_id = det["id"]

            now = _now()
            if agendada:
                cur.execute("""
                    UPDATE visitas SET
                        status='em_visita', data_entrada=%s,
                        placa_veiculo=COALESCE(%s, placa_veiculo),
                        pessoa_visitado_id=COALESCE(%s, pessoa_visitado_id),
                        lpr_deteccao_id=COALESCE(%s, lpr_deteccao_id),
                        motivo=COALESCE(%s, motivo),
                        observacoes=COALESCE(%s, observacoes),
                        atualizado_em=NOW()
                    WHERE id=%s RETURNING *
                """, (now, placa, body.pessoa_visitado_id, lpr_id,
                      body.motivo, body.observacoes, agendada["id"]))
            else:
                cur.execute("""
                    INSERT INTO visitas
                        (pessoa_visitante_id, pessoa_visitado_id, placa_veiculo,
                         lpr_deteccao_id, data_entrada, status, motivo, observacoes, criado_por)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """, (body.pessoa_visitante_id, body.pessoa_visitado_id, placa,
                      lpr_id, now, body.status, body.motivo, body.observacoes,
                      auth.get("sub")))
            visita = cur.fetchone()
            _audit(conn, "visitas", "CHECKIN", visita["id"], depois=visita,
                   usuario_id=auth.get("sub"), ip=request.client.host if request.client else None)
            log.info("[SURICATHA-LOG] %s - ENTRADA pessoa=%s visita=%d",
                     _ts(), visitante["nome"], visita["id"])
        conn.commit()
        return {"ok": True, "visita_id": visita["id"], "lpr_vinculado": lpr_id is not None}
    finally:
        conn.close()


# ── AGENDAR ───────────────────────────────────────────────────────────────────

@router.post("/visitas/agendar", status_code=201)
def agendar_visita(body: AgendarBody, request: Request,
                   auth: dict = Depends(require_role("admin", "operador"))):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM pessoas WHERE id=%s AND ativo=TRUE", (body.pessoa_visitante_id,))
            if not cur.fetchone(): raise HTTPException(404, "Pessoa não encontrada")
            placa = (body.placa_veiculo or "").strip().upper() or None
            cur.execute("""
                INSERT INTO visitas
                    (pessoa_visitante_id, pessoa_visitado_id, placa_veiculo,
                     status, motivo, observacoes, criado_por)
                VALUES (%s,%s,%s,'agendado',%s,%s,%s) RETURNING *
            """, (body.pessoa_visitante_id, body.pessoa_visitado_id, placa,
                  body.motivo, body.observacoes, auth.get("sub")))
            visita = cur.fetchone()
            _audit(conn, "visitas", "INSERT", visita["id"], depois=visita,
                   usuario_id=auth.get("sub"), ip=request.client.host if request.client else None)
        conn.commit()
        return dict(visita)
    finally:
        conn.close()


# ── SAÍDA (checkout) ──────────────────────────────────────────────────────────

@router.post("/visitas/saida/{visita_id}")
def registrar_saida(visita_id: int, body: SaidaBody, request: Request,
                    auth: dict = Depends(require_role("admin", "operador"))):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT v.*, pv.nome AS visitante_nome
                FROM visitas v JOIN pessoas pv ON pv.id = v.pessoa_visitante_id
                WHERE v.id=%s
            """, (visita_id,))
            visita = cur.fetchone()
            if not visita: raise HTTPException(404, "Visita não encontrada")
            if visita["status"] == "saiu":    raise HTTPException(409, "Saída já registrada")
            if visita["status"] == "cancelado": raise HTTPException(409, "Visita cancelada")

            cur.execute("""
                UPDATE visitas SET
                    status='saiu', data_saida=NOW(),
                    observacoes=COALESCE(%s, observacoes),
                    atualizado_em=NOW()
                WHERE id=%s RETURNING *
            """, (body.observacoes, visita_id))
            depois = cur.fetchone()
            _audit(conn, "visitas", "CHECKOUT", visita_id, antes=visita, depois=depois,
                   usuario_id=auth.get("sub"), ip=request.client.host if request.client else None)
            log.info("[SURICATHA-LOG] %s - SAÍDA pessoa=%s visita=%d",
                     _ts(), visita["visitante_nome"], visita_id)
        conn.commit()
        return {"ok": True, "visita_id": visita_id}
    finally:
        conn.close()


# ── CANCELAR ──────────────────────────────────────────────────────────────────

@router.delete("/visitas/{visita_id}")
def cancelar_visita(visita_id: int, request: Request,
                    auth: dict = Depends(require_role("admin", "operador"))):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM visitas WHERE id=%s", (visita_id,))
            visita = cur.fetchone()
            if not visita: raise HTTPException(404, "Visita não encontrada")
            if visita["status"] in ("saiu", "cancelado"):
                raise HTTPException(409, f"Visita já encerrada (status={visita['status']})")
            cur.execute("UPDATE visitas SET status='cancelado', atualizado_em=NOW() WHERE id=%s", (visita_id,))
            _audit(conn, "visitas", "DELETE", visita_id, antes=visita,
                   usuario_id=auth.get("sub"), ip=request.client.host if request.client else None)
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── LPR ───────────────────────────────────────────────────────────────────────

@router.get("/lpr-sugestoes")
def lpr_sugestoes(auth: dict = Depends(require_auth)):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT ON (v.id)
                    v.id AS visita_id, v.status, v.placa_veiculo,
                    pv.nome AS visitante_nome, pv.empresa,
                    pvd.nome AS visitado_nome, pvd.ramal,
                    d.detectado_em AS lpr_detectado_em,
                    c.nome AS camera_nome
                FROM visitas v
                JOIN pessoas pv  ON pv.id  = v.pessoa_visitante_id
                LEFT JOIN pessoas pvd ON pvd.id = v.pessoa_visitado_id
                JOIN deteccoes d ON d.placa = v.placa_veiculo
                LEFT JOIN cameras c ON c.id = d.camera_id
                WHERE v.status IN ('agendado','aguardando')
                  AND v.placa_veiculo IS NOT NULL
                  AND d.detectado_em >= NOW() - INTERVAL '2 hours'
                ORDER BY v.id, d.detectado_em DESC
            """)
            return {"data": [dict(r) for r in cur.fetchall()]}
    finally:
        conn.close()


@router.get("/lpr-nao-agendado")
def lpr_nao_agendado(auth: dict = Depends(require_auth)):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT ON (d.placa)
                    d.placa, d.detectado_em, c.nome AS camera_nome, c.local AS camera_local
                FROM deteccoes d
                LEFT JOIN cameras c ON c.id = d.camera_id
                WHERE d.placa IS NOT NULL
                  AND d.detectado_em >= NOW() - INTERVAL '2 hours'
                  AND NOT EXISTS (
                      SELECT 1 FROM visitas v
                      WHERE v.placa_veiculo = d.placa
                        AND v.status IN ('agendado','aguardando','em_visita')
                  )
                ORDER BY d.placa, d.detectado_em DESC
                LIMIT 20
            """)
            return {"data": [dict(r) for r in cur.fetchall()]}
    finally:
        conn.close()


# ── PRÉ-CADASTRO PÚBLICO (sem auth) ──────────────────────────────────────────

class PreCadastroBody(BaseModel):
    nome:           str           = Field(..., min_length=2, max_length=128)
    telefone:       Optional[str] = None
    cpf:            Optional[str] = Field(None, max_length=14)
    rg:             Optional[str] = Field(None, max_length=20)
    cnh:            Optional[str] = Field(None, max_length=11)
    empresa:        Optional[str] = None
    visitado_texto: Optional[str] = Field(None, max_length=256)
    visitado_setor: Optional[str] = Field(None, max_length=128)
    motivo:         Optional[str] = Field(None, max_length=256)


def _gerar_token() -> str:
    """Token de 8 caracteres hexadecimais (ex: A3F921BC)."""
    return secrets.token_hex(4).upper()


@router.post("/publico/pre-cadastro", status_code=201)
def pre_cadastro_publico(body: PreCadastroBody):
    if body.cpf:
        cpf_norm = _normalizar_cpf(body.cpf)
        if not _validar_cpf(cpf_norm):
            raise HTTPException(422, "CPF inválido")
        body = body.model_copy(update={"cpf": cpf_norm})
    conn = _conn()
    try:
        with conn.cursor() as cur:
            # Encontra ou cria pessoa
            cpf = body.cpf if body.cpf else None
            rg  = body.rg.strip().upper()  if body.rg  else None
            cnh = body.cnh.strip().upper() if body.cnh else None
            pessoa_id = None

            # Tenta encontrar pelo CPF primeiro
            if cpf:
                cur.execute("SELECT id FROM pessoas WHERE cpf=%s", (cpf,))
                row = cur.fetchone()
                if row:
                    pessoa_id = row["id"]
                    cur.execute("""
                        UPDATE pessoas SET
                            nome=%s, rg=COALESCE(%s, rg), cnh=COALESCE(%s, cnh),
                            telefone=COALESCE(%s, telefone),
                            empresa=COALESCE(%s, empresa), atualizado_em=NOW()
                        WHERE id=%s
                    """, (body.nome.strip(), rg, cnh, body.telefone, body.empresa, pessoa_id))

            if not pessoa_id:
                cur.execute("""
                    INSERT INTO pessoas (tipo, nome, cpf, rg, cnh, telefone, empresa)
                    VALUES ('visitante', %s, %s, %s, %s, %s, %s) RETURNING id
                """, (body.nome.strip(), cpf, rg, cnh,
                      body.telefone.strip() if body.telefone else None,
                      body.empresa.strip() if body.empresa else None))
                pessoa_id = cur.fetchone()["id"]

            # Tenta encontrar funcionário pelo nome livre
            pessoa_visitado_id = None
            if body.visitado_texto:
                palavra = body.visitado_texto.strip().split()[0]
                cur.execute("""
                    SELECT id FROM pessoas
                    WHERE tipo='funcionario' AND lower(nome) LIKE lower(%s) AND ativo=TRUE
                    LIMIT 1
                """, (f"%{palavra}%",))
                match = cur.fetchone()
                if match:
                    pessoa_visitado_id = match["id"]

            # Gera token único
            for _ in range(5):
                token = _gerar_token()
                cur.execute("SELECT 1 FROM visitas WHERE token_acesso=%s", (token,))
                if not cur.fetchone():
                    break

            # Cria visita agendada com flag de pré-cadastro
            visitado_info = body.visitado_texto or ""
            if body.visitado_setor:
                visitado_info = f"{visitado_info} · {body.visitado_setor}".strip(" ·")

            cur.execute("""
                INSERT INTO visitas
                    (pessoa_visitante_id, pessoa_visitado_id, status, motivo,
                     visitado_texto, token_acesso, pre_cadastro, criado_por)
                VALUES (%s, %s, 'agendado', %s, %s, %s, TRUE, 'pre-cadastro-web')
                RETURNING id
            """, (pessoa_id, pessoa_visitado_id, body.motivo, visitado_info or None, token))
            visita_id = cur.fetchone()["id"]

        conn.commit()
        log.info("[SURICATHA-LOG] %s - PRÉ-CADASTRO nome=%s token=%s", _ts(), body.nome, token)
        return {
            "token":     token,
            "visita_id": visita_id,
            "pessoa_id": pessoa_id,
            "nome":      body.nome.strip(),
        }
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        raise HTTPException(409, "Documento já cadastrado. Tente novamente.")
    finally:
        conn.close()


@router.get("/publico/confirmacao/{token}")
def confirmacao_publica(token: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    v.id, v.status, v.motivo, v.visitado_texto, v.criado_em,
                    pv.nome AS visitante_nome, pv.empresa, pv.telefone, pv.foto_url,
                    pv.cpf, pv.rg, pv.cnh,
                    pvd.nome AS visitado_nome, pvd.departamento, pvd.ramal
                FROM visitas v
                JOIN pessoas pv ON pv.id = v.pessoa_visitante_id
                LEFT JOIN pessoas pvd ON pvd.id = v.pessoa_visitado_id
                WHERE v.token_acesso=%s
            """, (token.upper(),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Código não encontrado")
        return dict(row)
    finally:
        conn.close()


@router.post("/publico/upload/rosto/{token}")
async def upload_rosto_publico(token: str, foto: UploadFile = File(...)):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT v.pessoa_visitante_id, p.foto_url
                FROM visitas v JOIN pessoas p ON p.id = v.pessoa_visitante_id
                WHERE v.token_acesso=%s
            """, (token.upper(),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Token inválido")
            pid = row["pessoa_visitante_id"]
            if row["foto_url"]:
                _try_delete(row["foto_url"])
            url = _save_photo(foto, f"rosto/{pid}")
            cur.execute("UPDATE pessoas SET foto_url=%s WHERE id=%s", (url, pid))
        conn.commit()
        return {"foto_url": url}
    finally:
        conn.close()


@router.post("/publico/upload/documento/{token}")
async def upload_documento_publico(token: str, foto: UploadFile = File(...)):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT v.pessoa_visitante_id, p.fotos_documento
                FROM visitas v JOIN pessoas p ON p.id = v.pessoa_visitante_id
                WHERE v.token_acesso=%s
            """, (token.upper(),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Token inválido")
            pid = row["pessoa_visitante_id"]
            fotos = list(row["fotos_documento"] or [])
            if len(fotos) >= MAX_FOTOS_DOCUMENTO:
                raise HTTPException(400, "Máximo de fotos atingido")
            url = _save_photo(foto, f"documento/{pid}")
            fotos.append(url)
            cur.execute("UPDATE pessoas SET fotos_documento=%s WHERE id=%s", (fotos, pid))
        conn.commit()
        return {"url": url, "fotos": fotos}
    finally:
        conn.close()
