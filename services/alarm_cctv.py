"""
/app/services/alarm_cctv.py
SuricathaIA — Motor de Alarme CCTV

Pipeline por câmera:
  1. Worker thread abre stream RTSP diretamente
  2. Captura frame a cada ALARM_CAPTURE_INTERVAL_S segundos
  3. Roda YOLOv8 para contar pessoas (motor primário)
  4. Dispara alarme quando total >= min_pessoas por ALARM_CONFIRM_FRAMES consecutivos
  5. Notifica via SSE, WhatsApp, Telegram
  6. Salva snapshot e evento em alarmes_cctv_eventos
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime as _dt
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

log = logging.getLogger("suricatha.alarm_cctv")

DB_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db",
)

SNAPSHOTS_DIR = Path("/app/snapshots")
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)

ALARM_CAPTURE_INTERVAL = float(os.getenv("ALARM_CAPTURE_INTERVAL_S",  "5"))
ALARM_RECONNECT_DELAY  = float(os.getenv("ALARM_RECONNECT_DELAY_S",   "15"))
ALARM_REFRESH_INTERVAL = float(os.getenv("ALARM_REFRESH_INTERVAL_S",  "120"))
ALARM_CONFIRM_FRAMES   = int(os.getenv("ALARM_CONFIRM_FRAMES",         "3"))
RTSP_TIMEOUT_S         = int(os.getenv("RTSP_TIMEOUT_S",               "15"))
RTSP_BUFFER_SIZE       = int(os.getenv("RTSP_BUFFER_SIZE",              "1"))
# Limiar de confiança mais alto que o contador de pessoas — reduz falsos alarmes
ALARM_CONF_THRESHOLD   = float(os.getenv("ALARM_CONF_THRESHOLD",      "0.55"))
# Altura mínima da bbox em px — descarta detecções de pessoas muito distantes/pequenas
ALARM_MIN_PERSON_H     = int(os.getenv("ALARM_MIN_PERSON_H",          "80"))
# Frames iniciais descartados ao abrir stream (limpa buffer stale)
ALARM_WARMUP_FRAMES    = int(os.getenv("ALARM_WARMUP_FRAMES",          "6"))


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    return psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)


# ── SSE broadcast ─────────────────────────────────────────────────────────────

_sse_broadcast_fn = None


def register_sse_broadcast(fn):
    global _sse_broadcast_fn
    _sse_broadcast_fn = fn


def _sse_push(event: dict):
    if _sse_broadcast_fn:
        try:
            _sse_broadcast_fn(event)
        except Exception as e:
            log.debug("SSE push error: %s", e)


# ── Camera + alarm config ─────────────────────────────────────────────────────

@dataclass
class AlarmCameraConfig:
    cam_id:         int
    cam_nome:       str
    url_stream:     Optional[str]
    protocolo_lpr:  str  = "sftp"
    ip_sftp:        Optional[str] = None
    usuario_camera: Optional[str] = None
    senha_camera:   Optional[str] = None
    porta_http:     int  = 80
    https_camera:   bool = False
    # alarm settings
    min_pessoas:    int  = 1
    cooldown_seg:   int  = 60
    notif_sonoro:   bool = True
    notif_whatsapp: bool = False
    notif_telegram: bool = False
    destinatarios:  list = field(default_factory=list)
    notif_usuarios: list = field(default_factory=list)
    mensagem_custom: Optional[str] = None
    horario_inicio: Optional[object] = None
    horario_fim:    Optional[object] = None
    dias_semana:    Optional[list] = None


def _load_alarm_cameras() -> list[AlarmCameraConfig]:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        c.id AS cam_id, c.nome AS cam_nome, c.url_stream,
                        c.protocolo_lpr,
                        split_part(c.ip_sftp::text, '/', 1) AS ip_sftp,
                        c.usuario_camera, c.senha_camera,
                        COALESCE(c.porta_http, 80) AS porta_http,
                        COALESCE(c.https_camera, FALSE) AS https_camera,
                        COALESCE(ac.min_pessoas, 1)    AS min_pessoas,
                        COALESCE(ac.cooldown_seg, 60)  AS cooldown_seg,
                        COALESCE(ac.notif_sonoro, TRUE) AS notif_sonoro,
                        COALESCE(ac.notif_whatsapp, FALSE) AS notif_whatsapp,
                        COALESCE(ac.notif_telegram, FALSE) AS notif_telegram,
                        COALESCE(ac.destinatarios, '[]'::jsonb) AS destinatarios,
                        COALESCE(ac.notif_usuarios, '[]'::jsonb) AS notif_usuarios,
                        ac.mensagem_custom,
                        ac.horario_inicio, ac.horario_fim, ac.dias_semana
                    FROM cameras c
                    JOIN alarmes_cctv_config ac ON ac.camera_id = c.id
                    WHERE ac.ativo = TRUE
                      AND c.ativa = TRUE
                      AND (
                          (c.url_stream IS NOT NULL AND c.url_stream != '')
                          OR c.protocolo_lpr = 'intelbras_api'
                      )
                    ORDER BY c.id
                """)
                rows = cur.fetchall()
        result = []
        for r in rows:
            result.append(AlarmCameraConfig(
                cam_id         = r["cam_id"],
                cam_nome       = r["cam_nome"],
                url_stream     = r["url_stream"],
                protocolo_lpr  = r.get("protocolo_lpr") or "sftp",
                ip_sftp        = r.get("ip_sftp"),
                usuario_camera = r.get("usuario_camera"),
                senha_camera   = r.get("senha_camera"),
                porta_http     = r.get("porta_http") or 80,
                https_camera   = bool(r.get("https_camera")),
                min_pessoas    = r.get("min_pessoas") or 1,
                cooldown_seg   = r.get("cooldown_seg") or 60,
                notif_sonoro   = bool(r.get("notif_sonoro", True)),
                notif_whatsapp = bool(r.get("notif_whatsapp")),
                notif_telegram = bool(r.get("notif_telegram")),
                destinatarios  = list(r.get("destinatarios") or []),
                notif_usuarios = list(r.get("notif_usuarios") or []),
                mensagem_custom= r.get("mensagem_custom"),
                horario_inicio = r.get("horario_inicio"),
                horario_fim    = r.get("horario_fim"),
                dias_semana    = r.get("dias_semana"),
            ))
        return result
    except Exception as exc:
        log.error("[ALARM-CCTV] Falha ao carregar câmeras: %s", exc)
        return []


# ── Schedule check ────────────────────────────────────────────────────────────

def _in_schedule(cfg: AlarmCameraConfig) -> bool:
    now = _dt.now()
    if cfg.dias_semana:
        if now.weekday() not in cfg.dias_semana:
            return False
    h_ini = cfg.horario_inicio
    h_fim = cfg.horario_fim
    if h_ini and h_fim:
        t = now.time()
        if h_ini <= h_fim:
            return h_ini <= t <= h_fim
        else:
            return t >= h_ini or t <= h_fim
    return True


# ── Notification helpers ──────────────────────────────────────────────────────

def _build_message(camera_nome: str, total: int, custom: Optional[str]) -> str:
    hora = time.strftime("%H:%M:%S")
    data = time.strftime("%d/%m/%Y")
    if custom:
        return (custom
                .replace("{camera}", camera_nome)
                .replace("{pessoas}", str(total))
                .replace("{hora}", hora)
                .replace("{data}", data))
    plural = "pessoa" if total == 1 else "pessoas"
    return (
        f"🚨 *ALARME CCTV — SURICATHA IA*\n\n"
        f"📷 Câmera: *{camera_nome}*\n"
        f"👤 Detectado: *{total} {plural}*\n"
        f"🕐 Horário: {hora} de {data}\n\n"
        f"_Acesse o painel para visualizar ao vivo._"
    )


def _send_whatsapp_alarm(phone: str, msg: str) -> bool:
    try:
        from services.whatsapp_evo import send_text
        return send_text(phone, msg).get("ok", False)
    except Exception as exc:
        log.warning("[ALARM-CCTV] WhatsApp erro (%s): %s", phone, exc)
        return False


def _send_telegram_alarm(msg: str) -> bool:
    try:
        from services.telegram_svc import send_message
        return send_message(msg).get("ok", False)
    except Exception as exc:
        log.warning("[ALARM-CCTV] Telegram erro: %s", exc)
        return False


def _send_telegram_direct(chat_id: str, msg: str) -> bool:
    try:
        from services.telegram_svc import send_message
        return send_message(msg, chat_id=chat_id).get("ok", False)
    except Exception as exc:
        log.warning("[ALARM-CCTV] Telegram direto (%s) erro: %s", chat_id, exc)
        return False


# ── YOLO detection ────────────────────────────────────────────────────────────

def _yolo_count(frame: np.ndarray) -> tuple[int, float, list[dict]]:
    """
    Roda YOLO no frame com limiar de confiança mais alto e filtro de tamanho mínimo.
    Retorna (total_pessoas, confianca_media, detalhes).
    detalhes: lista de {x1, y1, x2, y2, conf}
    """
    try:
        from services.rtsp_people_counter import _yolo
        if _yolo._model is None:
            return 0, 0.0, []
        results = _yolo._model.predict(
            frame, classes=[0], conf=ALARM_CONF_THRESHOLD, verbose=False, stream=False
        )
        detalhes: list[dict] = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                if (y2 - y1) < ALARM_MIN_PERSON_H:
                    continue
                detalhes.append({
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "conf": round(float(box.conf[0]), 3),
                })
        confs = [d["conf"] for d in detalhes]
        conf_media = round(sum(confs) / len(confs), 4) if confs else 0.0
        return len(detalhes), conf_media, detalhes
    except Exception as exc:
        log.warning("[ALARM-CCTV] YOLO erro: %s", exc)
        return 0, 0.0, []


def _annotate_frame(frame: np.ndarray, detalhes: list[dict], total: int) -> np.ndarray:
    """Desenha bboxes de pessoas detectadas e contador no frame."""
    out = frame.copy()
    for d in detalhes:
        x1, y1, x2, y2 = d["x1"], d["y1"], d["x2"], d["y2"]
        conf = d["conf"]
        label = f"Pessoa {conf:.0%}"
        color = (30, 30, 220)  # vermelho BGR

        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        bg_y1 = max(y1 - th - 8, 0)
        cv2.rectangle(out, (x1, bg_y1), (x1 + tw + 6, y1), color, -1)
        cv2.putText(out, label, (x1 + 3, max(y1 - 4, th + 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)

    # Contador no canto superior esquerdo
    plural = "pessoa" if total == 1 else "pessoas"
    counter_label = f"  {total} {plural} detectada(s)  "
    (cw, ch), _ = cv2.getTextSize(counter_label, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2)
    cv2.rectangle(out, (0, 0), (cw + 10, ch + 14), (30, 30, 220), -1)
    cv2.putText(out, counter_label, (5, ch + 6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)

    return out


def _encode_jpeg(frame: np.ndarray) -> Optional[bytes]:
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return buf.tobytes() if ok else None


# ── Persistence ───────────────────────────────────────────────────────────────

def _fire_alarm(cfg: AlarmCameraConfig, total: int, frame: Optional[np.ndarray],
                last_alarm: dict[int, float], detalhes: Optional[list[dict]] = None):
    cam_id   = cfg.cam_id
    cam_nome = cfg.cam_nome
    agora    = time.time()

    if agora - last_alarm.get(cam_id, 0) < cfg.cooldown_seg:
        return
    last_alarm[cam_id] = agora

    log.info("[ALARM-CCTV] 🔔 Alarme: cam=%s pessoas=%d", cam_nome, total)

    msg    = _build_message(cam_nome, total, cfg.mensagem_custom)
    canais = []
    if cfg.notif_sonoro:
        canais.append("sonoro")
    if cfg.notif_whatsapp:
        canais.append("whatsapp")
    if cfg.notif_telegram:
        canais.append("telegram")

    # Save annotated snapshot
    snapshot_path: Optional[str] = None
    annotated = _annotate_frame(frame, detalhes or [], total) if frame is not None else None
    snapshot_jpeg: Optional[bytes] = _encode_jpeg(annotated) if annotated is not None else None
    if snapshot_jpeg:
        ts_name = f"alarm_tmp_{int(time.time()*1000)}.jpg"
        tmp_dest = SNAPSHOTS_DIR / ts_name
        try:
            tmp_dest.write_bytes(snapshot_jpeg)
            snapshot_path = ts_name
        except Exception as exc:
            log.warning("[ALARM-CCTV] Erro ao salvar snapshot: %s", exc)

    # Insert event
    evento_id: Optional[int] = None
    try:
        conn = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO alarmes_cctv_eventos
                    (camera_id, camera_nome, total_pessoas, canais, snapshot_path)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
            """, (cam_id, cam_nome, total, json.dumps(canais), snapshot_path))
            evento_id = cur.fetchone()["id"]
        conn.commit()
        log.info("[ALARM-CCTV] Evento %d gravado — canais=%s", evento_id, canais)

        # Rename snapshot to final name
        if evento_id and snapshot_path:
            final_name = f"alarm_{evento_id}.jpg"
            final_dest = SNAPSHOTS_DIR / final_name
            try:
                (SNAPSHOTS_DIR / snapshot_path).rename(final_dest)
                snapshot_path = final_name
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE alarmes_cctv_eventos SET snapshot_path=%s WHERE id=%s",
                        (snapshot_path, evento_id),
                    )
                conn.commit()
            except Exception as exc:
                log.warning("[ALARM-CCTV] Erro ao renomear snapshot: %s", exc)

        conn.close()
    except Exception as exc:
        log.warning("[ALARM-CCTV] Erro ao salvar evento: %s", exc)

    snapshot_url = (
        f"/api/v1/alarm/events/{evento_id}/snapshot"
        if evento_id and snapshot_path else None
    )

    # SSE
    _sse_push({
        "type"         : "alarm_cctv",
        "evento_id"    : evento_id,
        "camera_id"    : cam_id,
        "camera_nome"  : cam_nome,
        "total_pessoas": total,
        "ts"           : _ts(),
        "mensagem"     : msg,
        "snapshot_url" : snapshot_url,
        "sonoro"       : "sonoro" in canais,
    })

    # Resolve user phones
    user_wa_phones: list[str] = []
    user_tg_ids: list[str] = []
    if cfg.notif_usuarios:
        try:
            ids_str = ",".join(str(int(i)) for i in cfg.notif_usuarios)
            uc = psycopg2.connect(DB_DSN, cursor_factory=RealDictCursor)
            with uc.cursor() as cur:
                cur.execute(
                    f"SELECT whatsapp, telegram FROM operadores WHERE id IN ({ids_str}) AND ativo",
                )
                for u in cur.fetchall():
                    if u.get("whatsapp"):
                        user_wa_phones.append(u["whatsapp"].strip())
                    if u.get("telegram"):
                        user_tg_ids.append(u["telegram"].strip())
            uc.close()
        except Exception as exc:
            log.warning("[ALARM-CCTV] Erro ao buscar telefones: %s", exc)

    # WhatsApp
    if "whatsapp" in canais:
        dest = list(cfg.destinatarios)
        if not dest:
            gp = os.getenv("EVOLUTION_PHONE", "")
            if gp:
                dest = [gp]
        all_wa = list(dict.fromkeys([str(p) for p in dest] + user_wa_phones))
        plain = msg.replace("*", "").replace("_", "")
        threads = [threading.Thread(target=_send_whatsapp_alarm, args=(p, plain), daemon=True)
                   for p in all_wa]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=12)
    elif user_wa_phones:
        plain = msg.replace("*", "").replace("_", "")
        for phone in user_wa_phones:
            threading.Thread(target=_send_whatsapp_alarm, args=(phone, plain), daemon=True).start()

    # Telegram
    if "telegram" in canais:
        threading.Thread(target=_send_telegram_alarm, args=(msg,), daemon=True).start()
    for tg_id in user_tg_ids:
        threading.Thread(
            target=lambda tid=tg_id: _send_telegram_direct(tid, msg),
            daemon=True,
        ).start()


# ── Per-camera worker ─────────────────────────────────────────────────────────

class AlarmCameraWorker(threading.Thread):
    """Thread que monitora um stream RTSP e dispara alarmes via YOLO."""

    def __init__(self, cfg: AlarmCameraConfig, last_alarm: dict[int, float]):
        super().__init__(name=f"alarm-cam{cfg.cam_id}", daemon=True)
        self._cfg         = cfg
        self._last_alarm  = last_alarm
        self._stop        = threading.Event()
        self._ok          = False
        self._errors      = 0
        self._streak      = 0
        self._pending_frame: Optional[np.ndarray] = None

    @property
    def is_ok(self) -> bool:
        return self._ok

    def stop(self):
        self._stop.set()

    def run(self):
        log.info("[ALARM-CCTV] Worker iniciado cam_id=%d (%s)", self._cfg.cam_id, self._cfg.cam_nome)
        while not self._stop.is_set():
            try:
                if self._cfg.protocolo_lpr == "intelbras_api" and self._cfg.ip_sftp:
                    self._http_loop()
                elif self._cfg.url_stream:
                    self._rtsp_loop()
                else:
                    log.warning("[ALARM-CCTV] cam_id=%d sem URL configurada", self._cfg.cam_id)
                    self._stop.wait(60)
            except Exception as exc:
                self._ok = False
                self._errors += 1
                log.error("[ALARM-CCTV] cam_id=%d erro: %s", self._cfg.cam_id, exc)
            if not self._stop.is_set():
                self._stop.wait(ALARM_RECONNECT_DELAY)

    def _rtsp_loop(self):
        log.info("[ALARM-CCTV] Conectando RTSP cam_id=%d %s",
                 self._cfg.cam_id, self._cfg.url_stream)

        cap = cv2.VideoCapture(self._cfg.url_stream, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE,        RTSP_BUFFER_SIZE)
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_TIMEOUT_S * 1000)

        if not cap.isOpened():
            log.warning("[ALARM-CCTV] Não abriu stream cam_id=%d", self._cfg.cam_id)
            cap.release()
            return

        log.info("[ALARM-CCTV] Stream aberto cam_id=%d %.0ffps %dx%d",
                 self._cfg.cam_id,
                 cap.get(cv2.CAP_PROP_FPS),
                 int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                 int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))

        # Drena frames stale do buffer antes de começar a processar
        for _ in range(ALARM_WARMUP_FRAMES):
            cap.grab()

        self._ok     = True
        self._errors = 0
        self._streak = 0  # reset streak ao reconectar
        last_capture = 0.0

        while not self._stop.is_set():
            ret, frame = cap.read()
            if not ret or frame is None:
                log.warning("[ALARM-CCTV] Stream perdido cam_id=%d", self._cfg.cam_id)
                self._ok = False
                break

            now = time.time()
            if now - last_capture < ALARM_CAPTURE_INTERVAL:
                time.sleep(0.05)
                continue

            last_capture = now

            if not _in_schedule(self._cfg):
                time.sleep(30)
                continue

            self._process_frame(frame)

        cap.release()
        self._ok = False

    def _http_loop(self):
        import httpx
        from httpx import DigestAuth

        scheme = "https" if self._cfg.https_camera else "http"
        ip     = (self._cfg.ip_sftp or "").split("/")[0].strip()
        porta  = self._cfg.porta_http or 80
        snap_url = f"{scheme}://{ip}:{porta}/cgi-bin/snapshot.cgi?channel=0&subtype=0"
        auth     = DigestAuth(
            self._cfg.usuario_camera or "admin",
            self._cfg.senha_camera   or "",
        )

        log.info("[ALARM-CCTV] HTTP snapshot loop cam_id=%d %s", self._cfg.cam_id, snap_url)
        self._ok     = True
        self._errors = 0
        self._streak = 0

        while not self._stop.is_set():
            if not _in_schedule(self._cfg):
                self._stop.wait(30)
                continue

            try:
                resp = httpx.get(snap_url, auth=auth, timeout=10.0, follow_redirects=True)
                if resp.status_code != 200:
                    log.warning("[ALARM-CCTV] HTTP %d cam_id=%d", resp.status_code, self._cfg.cam_id)
                    self._stop.wait(ALARM_RECONNECT_DELAY)
                    continue

                img_array = np.frombuffer(resp.content, dtype=np.uint8)
                frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if frame is not None:
                    self._ok = True
                    self._process_frame(frame)

            except Exception as exc:
                self._ok = False
                self._errors += 1
                log.warning("[ALARM-CCTV] HTTP erro cam_id=%d: %s", self._cfg.cam_id, exc)

            self._stop.wait(ALARM_CAPTURE_INTERVAL)

        self._ok = False

    def _process_frame(self, frame: np.ndarray):
        total, conf, detalhes = _yolo_count(frame)

        log.debug("[ALARM-CCTV] cam_id=%d pessoas=%d conf=%.2f streak=%d min=%d",
                  self._cfg.cam_id, total, conf, self._streak, self._cfg.min_pessoas)

        if total >= self._cfg.min_pessoas:
            self._streak += 1
            log.info("[ALARM-CCTV] Detecção cam_id=%d pessoas=%d conf=%.2f (%d/%d)",
                     self._cfg.cam_id, total, conf, self._streak, ALARM_CONFIRM_FRAMES)
            if self._streak >= ALARM_CONFIRM_FRAMES:
                _fire_alarm(self._cfg, total, frame, self._last_alarm, detalhes)
                self._streak = 0
                self._pending_frame = None
        else:
            if self._streak > 0:
                log.info("[ALARM-CCTV] Detecção descartada cam_id=%d (streak interrompido: %d/%d)",
                         self._cfg.cam_id, self._streak, ALARM_CONFIRM_FRAMES)
            self._streak = 0
            self._pending_frame = None


# ── Service ───────────────────────────────────────────────────────────────────

class AlarmCCTVService:
    """Gerencia workers de alarme CCTV para câmeras com alarme ativo."""

    def __init__(self):
        self._workers:    dict[int, AlarmCameraWorker] = {}
        self._lock        = threading.Lock()
        self._global_stop = threading.Event()
        self._watcher:    Optional[threading.Thread] = None
        self._last_alarm: dict[int, float] = {}

    def start(self) -> "AlarmCCTVService":
        self._migrate()
        threading.Thread(target=self._init, daemon=True, name="alarm-cctv-init").start()
        return self

    def _init(self):
        # Aguarda YOLO estar pronto
        try:
            from services.rtsp_people_counter import _yolo
            log.info("[ALARM-CCTV] Aguardando modelo YOLO...")
            if not _yolo._ready.wait(timeout=120):
                log.critical("[ALARM-CCTV] YOLO não carregou — alarmes desabilitados")
                return
            log.info("[ALARM-CCTV] YOLO pronto. Iniciando workers.")
        except Exception as exc:
            log.warning("[ALARM-CCTV] Erro ao aguardar YOLO: %s — iniciando mesmo assim", exc)

        self._sync_cameras()
        self._watcher = threading.Thread(
            target=self._watch_loop, daemon=True, name="alarm-cctv-watcher"
        )
        self._watcher.start()

    def _watch_loop(self):
        while not self._global_stop.is_set():
            self._global_stop.wait(ALARM_REFRESH_INTERVAL)
            if not self._global_stop.is_set():
                self._sync_cameras()

    def _sync_cameras(self):
        cameras    = {c.cam_id: c for c in _load_alarm_cameras()}
        active_ids = set(cameras.keys())

        with self._lock:
            running_ids = set(self._workers.keys())

            for cam_id in running_ids - active_ids:
                log.info("[ALARM-CCTV] Removendo cam_id=%d", cam_id)
                self._workers[cam_id].stop()
                del self._workers[cam_id]

            for cam_id, cfg in cameras.items():
                existing = self._workers.get(cam_id)
                if existing and existing.is_alive():
                    continue
                w = AlarmCameraWorker(cfg, self._last_alarm)
                self._workers[cam_id] = w
                w.start()
                log.info("[ALARM-CCTV] Worker iniciado cam_id=%d (%s)", cam_id, cfg.cam_nome)

    def reload(self):
        self._sync_cameras()

    def status(self) -> list[dict]:
        with self._lock:
            return [
                {
                    "cam_id"    : cam_id,
                    "cam_nome"  : w._cfg.cam_nome,
                    "stream_ok" : w.is_ok,
                    "alive"     : w.is_alive(),
                    "errors"    : w._errors,
                    "min_pessoas": w._cfg.min_pessoas,
                }
                for cam_id, w in self._workers.items()
            ]

    def stop(self):
        self._global_stop.set()
        with self._lock:
            for w in self._workers.values():
                w.stop()
            self._workers.clear()
        log.info("[ALARM-CCTV] %s - Serviço encerrado", _ts())

    def _migrate(self):
        try:
            conn = psycopg2.connect(DB_DSN)
            with conn.cursor() as cur:
                cur.execute("""
                    ALTER TABLE alarmes_cctv_eventos
                    ADD COLUMN IF NOT EXISTS snapshot_path TEXT
                """)
                cur.execute("""
                    ALTER TABLE alarmes_cctv_config
                    ADD COLUMN IF NOT EXISTS verificacao_yolo BOOLEAN NOT NULL DEFAULT TRUE
                """)
                cur.execute("""
                    ALTER TABLE alarmes_cctv_config
                    ADD COLUMN IF NOT EXISTS notif_usuarios JSONB NOT NULL DEFAULT '[]'
                """)
                cur.execute("""
                    ALTER TABLE alarmes_cctv_eventos
                    ALTER COLUMN contagem_id DROP NOT NULL
                """)
            conn.commit()
            conn.close()
        except Exception as exc:
            log.debug("[ALARM-CCTV] Migrate: %s", exc)


# ── Singleton / factory ───────────────────────────────────────────────────────

_service: Optional[AlarmCCTVService] = None


def start_service() -> AlarmCCTVService:
    global _service
    if _service is None:
        _service = AlarmCCTVService()
        _service.start()
    return _service
