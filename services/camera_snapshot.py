"""
/app/services/camera_snapshot.py
SuricathaIA — Captura de snapshots via HTTP API nativa ou RTSP

Hierarquia de tentativas:
  1. HTTP API nativa da câmera (Hikvision ISAPI / Intelbras CGI)
  2. RTSP + OpenCV (fallback universal)
"""

from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger("suricatha.camera_snapshot")


def _http_snapshot(
    ip: str,
    fabricante: str,
    usuario: str,
    senha: str,
    porta: int = 80,
    https: bool = False,
    channel: int = 1,
) -> Optional[bytes]:
    """Captura snapshot via HTTP digest auth da API nativa da câmera."""
    import requests
    from requests.auth import HTTPDigestAuth
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    scheme = "https" if https else "http"
    fab = (fabricante or "").lower()
    auth = HTTPDigestAuth(usuario, senha)

    if "hikvision" in fab or "hik" in fab:
        channel_id = channel * 100 + 1          # canal 1 → 101
        url = f"{scheme}://{ip}:{porta}/ISAPI/Streaming/channels/{channel_id}/picture"
    elif "intelbras" in fab:
        url = f"{scheme}://{ip}:{porta}/cgi-bin/snapshot.cgi?channel={channel}"
    else:
        return None

    try:
        r = requests.get(url, auth=auth, timeout=8, verify=False)
        if r.status_code == 200 and len(r.content) > 500:
            log.debug("[SNAPSHOT] HTTP OK: %s", url)
            return r.content
        log.debug("[SNAPSHOT] HTTP %d: %s", r.status_code, url)
    except Exception as exc:
        log.debug("[SNAPSHOT] HTTP falhou (%s): %s", url, exc)
    return None


def _rtsp_snapshot(url_stream: str, skip: int = 4) -> Optional[bytes]:
    """Captura snapshot via RTSP com OpenCV."""
    if not url_stream:
        return None
    import cv2
    cap = cv2.VideoCapture(url_stream, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8_000)
    cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5_000)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    try:
        for _ in range(skip):
            cap.grab()
        ret, frame = cap.retrieve()
        if not ret:
            ret, frame = cap.read()
        if not ret or frame is None:
            log.debug("[SNAPSHOT] RTSP sem frame: %s", url_stream)
            return None
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if ok:
            log.debug("[SNAPSHOT] RTSP OK: %s", url_stream)
            return buf.tobytes()
    except Exception as exc:
        log.debug("[SNAPSHOT] RTSP erro: %s", exc)
    finally:
        cap.release()
    return None


def capture_snapshot(
    *,
    ip: Optional[str]         = None,
    fabricante: Optional[str] = None,
    usuario_camera: Optional[str] = None,
    senha_camera: Optional[str]   = None,
    porta_http: int           = 80,
    https_camera: bool        = False,
    url_stream: Optional[str] = None,
    channel: int              = 1,
) -> Optional[bytes]:
    """
    Tenta capturar snapshot JPEG:
      1. HTTP API nativa (Hikvision/Intelbras) se credenciais disponíveis
      2. RTSP via OpenCV como fallback
    Retorna bytes JPEG ou None.
    """
    # 1. HTTP API nativa
    if ip and fabricante and usuario_camera and senha_camera:
        jpeg = _http_snapshot(ip, fabricante, usuario_camera, senha_camera,
                              porta_http, https_camera, channel)
        if jpeg:
            return jpeg

    # 2. RTSP fallback
    return _rtsp_snapshot(url_stream)


def capture_snapshot_from_cam(cam: dict, channel: int = 1) -> Optional[bytes]:
    """
    Versão conveniente que recebe um dict com as colunas da tabela cameras.
    cam deve ter as chaves: ip_sftp/url_stream/url_base/fabricante/usuario_camera/etc.
    """
    import re
    # Extrai IP do url_stream se ip_sftp não disponível
    ip = None
    if cam.get("ip_sftp"):
        ip = str(cam["ip_sftp"])
    elif cam.get("url_base"):
        m = re.search(r'https?://([^:/]+)', cam["url_base"])
        if m:
            ip = m.group(1)
    elif cam.get("url_stream"):
        m = re.search(r'@([^:/]+)', cam["url_stream"])
        if m:
            ip = m.group(1)

    return capture_snapshot(
        ip=ip,
        fabricante=cam.get("fabricante"),
        usuario_camera=cam.get("usuario_camera"),
        senha_camera=cam.get("senha_camera"),
        porta_http=cam.get("porta_http") or 80,
        https_camera=bool(cam.get("https_camera")),
        url_stream=cam.get("url_stream"),
        channel=channel,
    )
