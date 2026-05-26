"""
/app/services/sftp_provisioner.py
SuricathaIA — Auto-provisionamento de usuários SFTP por câmera.

Fluxo:
  1. Gera username canônico: cam_{id:03d}
  2. Gera senha aleatória (24 chars) e criptografa com Fernet (chave do JWT_SECRET)
  3. Cria usuário Linux com home restrito e shell desabilitado
  4. Cria subdiretórios por pilar (lpr/ epi/) com permissões corretas
  5. Persiste usuario_sftp, pasta_upload, sftp_provisioned, sftp_password_enc no banco
  6. Escreve Match User block em /etc/ssh/sshd_config.d/10-suricatha-cameras.conf
     com ForceCommand internal-sftp -d /<pilar_primario> e recarrega SSH
"""

import os
import hashlib
import base64
import logging
import secrets
import subprocess

import psycopg2
from cryptography.fernet import Fernet

log = logging.getLogger("suricatha.sftp_provisioner")

PG_DSN           = os.getenv("POSTGRES_DSN", "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db")
SFTP_ROOT        = os.getenv("SFTP_ROOT", "/srv/suricatha/sftp_camera")
SSHD_CAMERAS_CONF = "/etc/ssh/sshd_config.d/10-suricatha-cameras.conf"


# ── Crypto ────────────────────────────────────────────────────────────────────

def _fernet() -> Fernet:
    raw = os.getenv("JWT_SECRET", "change-me")
    key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest())
    return Fernet(key)

def encrypt_password(pwd: str) -> str:
    return _fernet().encrypt(pwd.encode()).decode()

def decrypt_password(enc: str) -> str:
    try:
        return _fernet().decrypt(enc.encode()).decode()
    except Exception:
        return ""


# ── Linux user helpers ────────────────────────────────────────────────────────

def _run(cmd: list[str], input_text: str | None = None) -> tuple[int, str]:
    try:
        r = subprocess.run(
            cmd, input=input_text, text=True,
            capture_output=True, timeout=10,
        )
        return r.returncode, (r.stderr or r.stdout or "").strip()
    except Exception as exc:
        return 1, str(exc)


def _user_exists(username: str) -> bool:
    code, _ = _run(["id", username])
    return code == 0


SFTP_GROUP = "sftp_cameras"


def _create_linux_user(username: str, home_dir: str) -> tuple[bool, str]:
    if _user_exists(username):
        # Garante que está no grupo mesmo se já existia
        _run(["usermod", "-aG", SFTP_GROUP, username])
        return True, "already exists"

    code, err = _run([
        "useradd",
        "--home-dir", home_dir,
        "--no-create-home",
        "--shell", "/usr/sbin/nologin",
        "--comment", "SuricathaIA SFTP camera user",
        "--groups", SFTP_GROUP,
        username,
    ])
    if code != 0:
        return False, err
    return True, "created"


def _set_password(username: str, password: str) -> tuple[bool, str]:
    code, err = _run(["chpasswd"], input_text=f"{username}:{password}\n")
    return code == 0, err


def _setup_dirs(username: str, home_dir: str, pillars: list[str]) -> list[str]:
    created = []
    os.makedirs(home_dir, exist_ok=True)
    for sub in pillars:
        path = os.path.join(home_dir, sub)
        os.makedirs(path, exist_ok=True)
        created.append(path)

    # Chroot exige: home root:root 755
    _run(["chown", "root:root", home_dir])
    _run(["chmod", "755", home_dir])
    # Subpastas: owner=cam_NNN, group=sftp_cameras, rwxrwxr-x
    for path in created:
        _run(["chown", f"{username}:{SFTP_GROUP}", path])
        _run(["chmod", "775", path])
    return created


# ── SSH sshd_config management ───────────────────────────────────────────────

def _primary_dir(rec_lpr: bool, rec_epi: bool, rec_pessoas: bool = False) -> str:
    if rec_lpr:    return "/lpr"
    if rec_epi:    return "/epi"
    if rec_pessoas: return "/pessoas"
    return "/uploads"


def _regenerate_sshd_cameras_conf() -> bool:
    """
    Reescreve /etc/ssh/sshd_config.d/10-suricatha-cameras.conf com um bloco
    Match User cam_NNN para cada câmera provisionada, forçando ForceCommand
    internal-sftp -d /<pilar_primario> para que a sessão SFTP abra direto na
    pasta gravável sem exigir configuração de diretório na câmera.
    """
    conn = psycopg2.connect(PG_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT usuario_sftp, rec_lpr, rec_epi, rec_contagem_pessoas
                FROM cameras
                WHERE sftp_provisioned = TRUE AND usuario_sftp IS NOT NULL
                ORDER BY id
            """)
            rows = cur.fetchall()
    finally:
        conn.close()

    header = (
        "# SuricathaIA — Match User blocks auto-gerados pelo sftp_provisioner.\n"
        "# NAO EDITAR MANUALMENTE — este arquivo é sobrescrito a cada provisionamento.\n\n"
    )
    blocks = []
    for username, rec_lpr, rec_epi, rec_pessoas in rows:
        chroot_dir = os.path.join(SFTP_ROOT, username)
        start_dir  = _primary_dir(rec_lpr, rec_epi, rec_pessoas)
        blocks.append(
            f"Match User {username}\n"
            f"    ChrootDirectory {chroot_dir}\n"
            f"    ForceCommand internal-sftp -d {start_dir}\n"
            f"    AllowTcpForwarding no\n"
            f"    X11Forwarding no\n"
            f"    PermitTTY no\n"
        )

    with open(SSHD_CAMERAS_CONF, "w") as f:
        f.write(header + "\n".join(blocks) + "\n")

    code, err = _run(["sshd", "-t"])
    if code != 0:
        log.error("sshd_config inválido após regeneração: %s", err)
        return False

    code, err = _run(["systemctl", "reload", "ssh"])
    if code != 0:
        log.error("Falha ao recarregar SSH: %s", err)
        return False

    log.info("SSH recarregado com %d blocos de câmera", len(blocks))
    return True


# ── Public API ────────────────────────────────────────────────────────────────

def provision(camera_id: int, rec_lpr: bool, rec_epi: bool, rec_pessoas: bool = False) -> dict:
    """
    Provisiona usuário SFTP para a câmera.
    Retorna dict com username, password (plaintext — exibir UMA vez), status.
    """
    username = f"cam_{camera_id:03d}"
    home_dir = os.path.join(SFTP_ROOT, username)
    password = secrets.token_urlsafe(18)

    pillars: list[str] = []
    if rec_lpr:    pillars.append("lpr")
    if rec_epi:    pillars.append("epi")
    if rec_pessoas: pillars.append("pessoas")
    if not pillars:
        pillars = ["uploads"]

    errors: list[str] = []

    ok_user, msg_user = _create_linux_user(username, home_dir)
    if not ok_user:
        errors.append(f"useradd: {msg_user}")
        log.warning("Falha ao criar usuário Linux %s: %s", username, msg_user)

    ok_pwd, msg_pwd = _set_password(username, password)
    if not ok_pwd:
        errors.append(f"chpasswd: {msg_pwd}")
        log.warning("Falha ao definir senha de %s: %s", username, msg_pwd)

    dirs = _setup_dirs(username, home_dir, pillars)
    log.info("Diretórios criados: %s", dirs)

    enc = encrypt_password(password)

    try:
        conn = psycopg2.connect(PG_DSN)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE cameras SET
                    usuario_sftp      = %s,
                    pasta_upload      = %s,
                    sftp_provisioned  = TRUE,
                    sftp_password_enc = %s,
                    atualizado_em     = NOW()
                WHERE id = %s
            """, (username, home_dir, enc, camera_id))
        conn.commit()
        conn.close()
    except Exception as exc:
        errors.append(f"db: {exc}")
        log.error("Erro ao salvar provisionamento no banco: %s", exc)

    ssh_ok = _regenerate_sshd_cameras_conf()
    if not ssh_ok:
        errors.append("sshd_config: falha ao regenerar/recarregar")

    return {
        "username"    : username,
        "password"    : password,
        "home_dir"    : home_dir,
        "pillars"     : pillars,
        "linux_ok"    : ok_user,
        "password_ok" : ok_pwd,
        "ssh_ok"      : ssh_ok,
        "errors"      : errors,
    }


def reset_password(camera_id: int) -> dict:
    """Gera nova senha para o usuário SFTP da câmera."""
    conn = psycopg2.connect(PG_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT usuario_sftp FROM cameras WHERE id = %s", (camera_id,))
            row = cur.fetchone()
            if not row or not row[0]:
                return {"ok": False, "error": "Usuário SFTP não provisionado"}
            username = row[0]

        password = secrets.token_urlsafe(18)
        ok_pwd, msg = _set_password(username, password)
        if not ok_pwd:
            return {"ok": False, "error": f"chpasswd: {msg}"}

        enc = encrypt_password(password)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE cameras SET sftp_password_enc = %s, atualizado_em = NOW()
                WHERE id = %s
            """, (enc, camera_id))
        conn.commit()
        return {"ok": True, "username": username, "password": password}
    finally:
        conn.close()


def get_password(camera_id: int) -> dict:
    """Descriptografa e retorna a senha SFTP atual (apenas admin)."""
    conn = psycopg2.connect(PG_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT usuario_sftp, sftp_password_enc FROM cameras WHERE id = %s", (camera_id,))
            row = cur.fetchone()
        if not row:
            return {"ok": False, "error": "Câmera não encontrada"}
        username, enc = row[0], row[1]
        if not enc:
            return {"ok": False, "error": "Senha não disponível"}
        return {"ok": True, "username": username, "password": decrypt_password(enc)}
    finally:
        conn.close()
