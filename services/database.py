"""
/app/services/database.py
SuricathaIA — Persistência 100% local em PostgreSQL.
"""

import os
import time
import logging
import threading
from typing import Optional

log = logging.getLogger("suricatha.services.database")


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


class PostgresPool:
    """Pool thread-safe mínimo sobre psycopg2."""

    def __init__(self, dsn: str, minconn: int = 2, maxconn: int = 10):
        import psycopg2
        from psycopg2 import pool as pgpool
        self._pool = pgpool.ThreadedConnectionPool(minconn, maxconn, dsn=dsn)
        log.info("[SURICATHA-LOG] %s - PostgreSQL pool iniciado (min=%d max=%d)",
                 _ts(), minconn, maxconn)

    def getconn(self):
        return self._pool.getconn()

    def putconn(self, conn, close=False):
        self._pool.putconn(conn, close=close)

    def closeall(self):
        self._pool.closeall()


class DatabaseService:
    """
    Gerencia persistência local em PostgreSQL.
    Thread-safe. 100% on-premise — sem dependências externas.
    """

    _INSERT_SQL = """
        INSERT INTO deteccoes (
            camera_id,
            placa_raw_1, confianca_1,
            placa_raw_2, confianca_2,
            placa, confianca_final,
            validado, divergencia,
            arquivo_original, caminho_storage,
            raw_texts, tempo_processo_ms,
            detectado_em, erro, fonte, sincronizado
        ) VALUES (
            %(camera_id)s,
            %(placa_raw_1)s, %(confianca_1)s,
            %(placa_raw_2)s, %(confianca_2)s,
            %(placa)s, %(confianca_final)s,
            %(validado)s, %(divergencia)s,
            %(arquivo_original)s, %(caminho_storage)s,
            %(raw_texts)s, %(tempo_processo_ms)s,
            NOW(), %(erro)s, %(fonte)s, TRUE
        )
        RETURNING id, watchlist_hit, watchlist_id;
    """

    def __init__(self):
        dsn = os.getenv(
            "POSTGRES_DSN",
            "postgresql://suricatha:suricatha_secure_2024@localhost:5432/suricatha_db"
        )
        self._pool    = PostgresPool(dsn)
        self._pg_lock = threading.Lock()

    def resolve_camera_id(self, filename: str) -> int:
        """
        Resolve camera_id pelo nome do arquivo.
        1. prefixo_arquivo configurado na câmera
        2. prefixo do nome (parte antes do primeiro '_')
        3. fallback: id=1
        """
        name_upper = filename.upper()
        prefix     = filename.split("_")[0].upper()
        conn = self._pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id FROM cameras
                    WHERE prefixo_arquivo IS NOT NULL
                      AND %s LIKE UPPER(prefixo_arquivo) || '%%'
                      AND ativa
                    LIMIT 1
                """, (name_upper,))
                row = cur.fetchone()
                if row:
                    return row[0]
                cur.execute(
                    "SELECT id FROM cameras WHERE UPPER(nome) LIKE %s AND ativa LIMIT 1",
                    (f"{prefix}%",)
                )
                row = cur.fetchone()
                return row[0] if row else 1
        except Exception:
            return 1
        finally:
            self._pool.putconn(conn)

    def insert_detection(self, payload: dict) -> Optional[int]:
        """
        Grava detecção no PostgreSQL local. Retorna id gerado ou None.
        O trigger fn_check_watchlist() dispara automaticamente no DB.
        """
        conn = self._pool.getconn()
        try:
            with self._pg_lock, conn.cursor() as cur:
                cur.execute(self._INSERT_SQL, payload)
                row    = cur.fetchone()
                det_id = row[0]
                wl_hit = row[1]
                conn.commit()

            log.info("[SURICATHA-LOG] %s - INSERT OK id=%d placa=%s wl_hit=%s",
                     _ts(), det_id, payload.get("placa") or "N/D", wl_hit)

            if wl_hit:
                log.warning("[SURICATHA-LOG] %s - ⚠ WATCHLIST HIT placa=%s id=%d",
                            _ts(), payload.get("placa"), det_id)
                self._save_alerta_watchlist(conn, det_id, payload)

            return det_id

        except Exception as exc:
            log.error("[SURICATHA-LOG] %s - INSERT FALHOU: %s", _ts(), exc)
            try:
                conn.rollback()
            except Exception:
                pass
            return None
        finally:
            self._pool.putconn(conn)

    def _save_alerta_watchlist(self, conn, deteccao_id: int, payload: dict) -> None:
        """Registra hit de watchlist na tabela dedicada alertas_watchlist."""
        try:
            camera_id = payload.get("camera_id")
            placa     = payload.get("placa") or ""
            confianca = payload.get("confianca_final") or payload.get("confianca_2") or 0
            with conn.cursor() as cur:
                camera_nome = None
                if camera_id:
                    cur.execute("SELECT nome FROM cameras WHERE id=%s", (camera_id,))
                    row = cur.fetchone()
                    camera_nome = row[0] if row else None
                cur.execute("""
                    SELECT w.tipo, w.prioridade
                    FROM deteccoes d
                    LEFT JOIN watchlist w ON w.id = d.watchlist_id
                    WHERE d.id = %s
                """, (deteccao_id,))
                wrow = cur.fetchone()
                tipo      = wrow[0] if wrow else "suspeito"
                prioridade = wrow[1] if wrow else 1
                cur.execute("""
                    INSERT INTO alertas_watchlist
                        (camera_id, deteccao_id, camera_nome, placa,
                         tipo, prioridade, confianca, notificado)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                """, (camera_id, deteccao_id, camera_nome, placa,
                      tipo, prioridade, confianca, False))
                conn.commit()
        except Exception as exc:
            log.warning("[SURICATHA-LOG] %s - Save alerta_watchlist falhou: %s", _ts(), exc)

    def update_camera_sftp_activity(self, camera_id: int) -> None:
        """Registra timestamp e incrementa contador de imagens SFTP recebidas."""
        if not camera_id:
            return
        conn = self._pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE cameras
                    SET ultima_imagem_sftp = NOW(),
                        total_imagens_sftp = COALESCE(total_imagens_sftp, 0) + 1
                    WHERE id = %s
                """, (camera_id,))
                conn.commit()
        except Exception as exc:
            log.warning("[SURICATHA-LOG] %s - Falha ao atualizar atividade SFTP cam=%d: %s",
                        _ts(), camera_id, exc)
            try:
                conn.rollback()
            except Exception:
                pass
        finally:
            self._pool.putconn(conn)

    def shutdown(self):
        self._pool.closeall()
        log.info("[SURICATHA-LOG] %s - DatabaseService encerrado", _ts())
