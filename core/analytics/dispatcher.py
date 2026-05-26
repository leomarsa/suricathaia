"""
/app/core/analytics/dispatcher.py
SuricathaIA — Dispatcher de Analytics
Lê a configuração da câmera e decide quais motores rodar em cada imagem.
Chamado pelo watchdog_service após detecção do arquivo.
"""

import os
import time
import logging
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor

log = logging.getLogger("suricatha.analytics.dispatcher")

PG_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db"
)


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _get_camera_config(camera_id: int) -> Optional[dict]:
    try:
        conn = psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT rec_lpr, rec_contagem_pessoas, rec_epi,
                       zona_interesse, limite_pessoas
                FROM cameras WHERE id = %s
            """, (camera_id,))
            row = cur.fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Config câmera falhou: %s", _ts(), exc)
        return None


def _save_alerta_lotacao(camera_id: int, contagem_id: Optional[int],
                         total: int, limite: Optional[int],
                         confianca: float, snapshot_path: Optional[str],
                         notificado: bool) -> None:
    """Registra um evento de lotação na tabela dedicada alertas_lotacao."""
    try:
        conn = psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("SELECT nome FROM cameras WHERE id=%s", (camera_id,))
            row = cur.fetchone()
            nome = row["nome"] if row else f"CAM-{camera_id}"
            cur.execute("""
                INSERT INTO alertas_lotacao
                    (camera_id, contagem_id, camera_nome, total_pessoas,
                     limite_pessoas, confianca_media, snapshot_path, notificado)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (camera_id, contagem_id, nome, total, limite,
                  confianca, snapshot_path, notificado))
            conn.commit()
        conn.close()
    except Exception as exc:
        log.warning("[SURICATHA-LOG] %s - Save alerta_lotacao falhou: %s", _ts(), exc)


def _save_alerta_epi(camera_id: int, evento_epi_id: Optional[int],
                     total: int, sem_capacete: int, sem_colete: int,
                     pct_conf: float, snapshot_path: Optional[str],
                     notificado: bool) -> None:
    """Registra uma violação EPI na tabela dedicada alertas_epi."""
    try:
        conn = psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("SELECT nome FROM cameras WHERE id=%s", (camera_id,))
            row = cur.fetchone()
            nome = row["nome"] if row else f"CAM-{camera_id}"
            cur.execute("""
                INSERT INTO alertas_epi
                    (camera_id, evento_epi_id, camera_nome, total_pessoas,
                     sem_capacete, sem_colete, percentual_conformidade,
                     snapshot_path, notificado)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (camera_id, evento_epi_id, nome, total,
                  sem_capacete, sem_colete, pct_conf, snapshot_path, notificado))
            conn.commit()
        conn.close()
    except Exception as exc:
        log.warning("[SURICATHA-LOG] %s - Save alerta_epi falhou: %s", _ts(), exc)


def _save_contagem(camera_id: int, arquivo: str,
                   storage: Optional[str], result) -> Optional[int]:
    """Persiste resultado de contagem no banco."""
    import json
    try:
        conn = psycopg2.connect(PG_DSN)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO contagens_pessoas (
                    camera_id, arquivo_original, caminho_storage,
                    total_pessoas, confianca_media, detalhes,
                    alerta_lotacao, tempo_processo_ms
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                camera_id, arquivo, storage,
                result.dados.get("total_pessoas", 0),
                result.dados.get("confianca_media", 0),
                json.dumps(result.dados.get("detalhes", [])),
                result.dados.get("alerta_lotacao", False),
                result.tempo_ms,
            ))
            row_id = cur.fetchone()[0]
            conn.commit()
        conn.close()
        return row_id
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Save contagem falhou: %s", _ts(), exc)
        return None


def _save_epi(camera_id: int, arquivo: str,
              storage: Optional[str], result) -> Optional[int]:
    """Persiste resultado de EPI no banco."""
    import json
    try:
        conn = psycopg2.connect(PG_DSN)
        d = result.dados
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO eventos_epi (
                    camera_id, arquivo_original, caminho_storage,
                    total_pessoas,
                    com_capacete, sem_capacete,
                    com_colete, sem_colete,
                    conformidade, percentual_conformidade,
                    detalhes, tempo_processo_ms
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                camera_id, arquivo, storage,
                d.get("total_pessoas", 0),
                d.get("com_capacete", 0), d.get("sem_capacete", 0),
                d.get("com_colete", 0),   d.get("sem_colete", 0),
                d.get("conformidade", True),
                d.get("percentual_conformidade", 100.0),
                json.dumps(d.get("detalhes", [])),
                result.tempo_ms,
            ))
            row_id = cur.fetchone()[0]
            conn.commit()
        conn.close()
        return row_id
    except Exception as exc:
        log.error("[SURICATHA-LOG] %s - Save EPI falhou: %s", _ts(), exc)
        return None


def dispatch(image_path: str, camera_id: int,
             storage_path: Optional[str] = None) -> dict:
    """
    Ponto de entrada do dispatcher.
    Chamado pelo watchdog_service após processar o LPR.

    Retorna dict com resultados de cada motor rodado.
    """
    config = _get_camera_config(camera_id)
    if not config:
        return {}

    arquivo = image_path.split("/")[-1]
    results = {}

    # ── Contagem de pessoas ───────────────────────────────────────────────────
    if config.get("rec_contagem_pessoas"):
        log.info("[SURICATHA-LOG] %s - [DISPATCH] Pessoas: %s", _ts(), arquivo)
        try:
            from .people_counter import PeopleCounter
            counter = PeopleCounter()
            res = counter.process_with_config(
                image_path,
                roi_json=config.get("zona_interesse"),
                limite=config.get("limite_pessoas"),
            )
            results["pessoas"] = res
            contagem_id = _save_contagem(camera_id, arquivo, storage_path, res)

            # Alerta se lotação excedida
            if res.dados.get("alerta_lotacao"):
                _trigger_alert("pessoas", camera_id, arquivo, res.dados)
                _save_alerta_lotacao(
                    camera_id=camera_id,
                    contagem_id=contagem_id,
                    total=res.dados.get("total_pessoas", 0),
                    limite=config.get("limite_pessoas"),
                    confianca=res.dados.get("confianca_media", 0),
                    snapshot_path=None,
                    notificado=True,
                )

        except Exception as exc:
            log.error("[SURICATHA-LOG] %s - [DISPATCH] Pessoas erro: %s", _ts(), exc)

    # ── Detecção de EPI ───────────────────────────────────────────────────────
    if config.get("rec_epi"):
        log.info("[SURICATHA-LOG] %s - [DISPATCH] EPI: %s", _ts(), arquivo)
        try:
            from .ppe_detector import PPEDetector
            detector = PPEDetector()
            res = detector.process(image_path)
            results["epi"] = res
            epi_id = _save_epi(camera_id, arquivo, storage_path, res)

            # Alerta se não conformidade
            if not res.dados.get("conformidade", True):
                _trigger_alert("epi", camera_id, arquivo, res.dados)
                _save_alerta_epi(
                    camera_id=camera_id,
                    evento_epi_id=epi_id,
                    total=res.dados.get("total_pessoas", 0),
                    sem_capacete=res.dados.get("sem_capacete", 0),
                    sem_colete=res.dados.get("sem_colete", 0),
                    pct_conf=res.dados.get("percentual_conformidade", 0.0),
                    snapshot_path=None,
                    notificado=True,
                )

        except Exception as exc:
            log.error("[SURICATHA-LOG] %s - [DISPATCH] EPI erro: %s", _ts(), exc)

    return results


def _trigger_alert(tipo: str, camera_id: int, arquivo: str, dados: dict):
    """Dispara alerta via AlertService para eventos críticos."""
    try:
        from services.alerts import AlertService, AlertEvent
        from dataclasses import dataclass

        msg_map = {
            "pessoas": f"Lotação excedida: {dados.get('total_pessoas')} pessoas detectadas",
            "epi"    : f"EPI não conformidade: {dados.get('percentual_conformidade', 0):.0f}% "
                       f"| Sem capacete: {dados.get('sem_capacete', 0)} "
                       f"| Sem colete: {dados.get('sem_colete', 0)}",
        }

        # Busca nome da câmera
        conn = psycopg2.connect(PG_DSN, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("SELECT nome FROM cameras WHERE id=%s", (camera_id,))
            row   = cur.fetchone()
            nome  = row["nome"] if row else f"CAM-{camera_id}"
        conn.close()

        event = AlertEvent(
            placa        = tipo.upper(),
            tipo         = "monitorado",
            prioridade   = 4 if tipo == "epi" else 3,
            camera_nome  = nome,
            confianca    = 1.0,
            det_id       = 0,
            detectado_em = time.strftime("%Y-%m-%d %H:%M:%S"),
            crop_url     = None,
        )
        # Personaliza a mensagem
        event.__dict__["_mensagem_extra"] = msg_map.get(tipo, "")
        AlertService().send(event)

    except Exception as exc:
        log.warning("[SURICATHA-LOG] %s - Alert dispatch falhou: %s", _ts(), exc)
