"""
/app/core/auth.py
SuricathaIA — Autenticação JWT + RBAC
"""

import os
import time
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

log = logging.getLogger("suricatha.auth")
bearer = HTTPBearer(auto_error=False)

JWT_SECRET   = os.getenv("JWT_SECRET", secrets.token_hex(32))
JWT_ALGO     = "HS256"
JWT_EXPIRE_H = int(os.getenv("JWT_EXPIRE_HOURS", "720"))

_API_KEYS: set = {
    k.strip()
    for k in os.getenv("API_KEYS", "").split(",")
    if k.strip()
}


def _import_jwt():
    try:
        import jwt
        return jwt
    except ImportError:
        raise RuntimeError("PyJWT não instalado: pip install pyjwt")


def create_token(subject: str, extra: dict = None) -> str:
    jwt = _import_jwt()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(hours=JWT_EXPIRE_H),
        **(extra or {}),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)
    log.info("[SURICATHA-LOG] %s - Token gerado para '%s' (exp=%dh)",
             _ts(), subject, JWT_EXPIRE_H)
    return token


def decode_token(token: str) -> dict:
    jwt = _import_jwt()
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expirado")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Token inválido: {exc}")


# ── require_auth deve ser definido ANTES de require_role ─────────────────────
def require_auth(
    creds: Optional[HTTPAuthorizationCredentials] = Security(bearer),
) -> dict:
    """
    Dependency base. Aceita JWT Bearer OU API Key estática.
    """
    if creds is None:
        raise HTTPException(status_code=401, detail="Authorization header obrigatório")

    token = creds.credentials

    if _API_KEYS and token in _API_KEYS:
        return {"sub": "api_key", "type": "api_key", "role": "admin"}

    return decode_token(token)


def require_role(*roles: str):
    """Factory que retorna Dependency exigindo um dos perfis."""
    def _dep(auth: dict = Depends(require_auth)) -> dict:
        if auth.get("role") not in roles:
            raise HTTPException(
                status_code=403,
                detail=f"Acesso restrito a: {', '.join(roles)}"
            )
        return auth
    return _dep


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")
