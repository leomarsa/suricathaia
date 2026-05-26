"""
/app/core/priority_queue.py
SuricathaIA — Scheduler de Prioridade por Analítico

Arquitetura:
  ┌─────────────────────────────────────────────────────────────┐
  │                    PriorityScheduler                        │
  │                                                             │
  │  PriorityQueue (heap)                                       │
  │  ┌──────────────────────────────────────────────────────┐   │
  │  │ P1 · LPR      → ProcessPoolExecutor (spawn)         │   │
  │  │ P2 · Pessoas  → ThreadPoolExecutor                  │   │
  │  │ P3 · EPI      → ThreadPoolExecutor                  │   │
  │  └──────────────────────────────────────────────────────┘   │
  │                                                             │
  │  Dispatcher thread lê o heap e despacha para o pool certo   │
  └─────────────────────────────────────────────────────────────┘

Prioridades:
  1 — LPR   crítico  (watchlist, tempo real)
  2 — Pessoas        (segurança, importante)
  3 — EPI            (conformidade, tolerável atraso)

PaddleOCR não é fork-safe → ProcessPool (spawn).
YOLOv8 é thread-safe → ThreadPool (mais leve, sem overhead de spawn).
"""

import os
import time
import heapq
import logging
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, Future
from dataclasses import dataclass, field
from typing import Callable, Any, Optional

log = logging.getLogger("suricatha.priority_queue")

# ── Configuração via .env ─────────────────────────────────────────────────────
LPR_WORKERS       = int(os.getenv("LPR_WORKERS",       "2"))
ANALYTICS_WORKERS = int(os.getenv("ANALYTICS_WORKERS", "2"))
QUEUE_MAXSIZE     = int(os.getenv("QUEUE_MAXSIZE",      "500"))


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ── Prioridades ───────────────────────────────────────────────────────────────
class Priority:
    LPR     = 1   # crítico — watchlist em tempo real
    PESSOAS = 2   # importante — segurança
    EPI     = 3   # normal — conformidade


PRIORITY_LABELS = {
    Priority.LPR    : "LPR",
    Priority.PESSOAS: "PESSOAS",
    Priority.EPI    : "EPI",
}


# ── Task ──────────────────────────────────────────────────────────────────────
@dataclass(order=True)
class Task:
    """
    Tarefa na fila de prioridade.
    Ordenação: (priority ASC, enqueued_at ASC) → FIFO dentro da mesma prioridade.
    """
    priority:    int
    enqueued_at: float
    # Campos não comparados
    fn:          Callable = field(compare=False)
    args:        tuple    = field(compare=False, default_factory=tuple)
    kwargs:      dict     = field(compare=False, default_factory=dict)
    callback:    Optional[Callable] = field(compare=False, default=None)
    image_path:  str      = field(compare=False, default="")
    camera_id:   int      = field(compare=False, default=0)


# ── Estatísticas ──────────────────────────────────────────────────────────────
class QueueStats:
    """Métricas em tempo real da fila."""

    def __init__(self):
        self._lock    = threading.Lock()
        self.enqueued = {1: 0, 2: 0, 3: 0}
        self.done     = {1: 0, 2: 0, 3: 0}
        self.errors   = {1: 0, 2: 0, 3: 0}
        self.tempos   = {1: [], 2: [], 3: []}   # últimos 50 tempos por prioridade
        self.dropped  = 0

    def record_enqueue(self, priority: int):
        with self._lock:
            self.enqueued[priority] = self.enqueued.get(priority, 0) + 1

    def record_done(self, priority: int, elapsed_ms: int):
        with self._lock:
            self.done[priority] = self.done.get(priority, 0) + 1
            lst = self.tempos.setdefault(priority, [])
            lst.append(elapsed_ms)
            if len(lst) > 50:
                lst.pop(0)

    def record_error(self, priority: int):
        with self._lock:
            self.errors[priority] = self.errors.get(priority, 0) + 1

    def record_dropped(self):
        with self._lock:
            self.dropped += 1

    def snapshot(self) -> dict:
        with self._lock:
            out = {}
            for p in (1, 2, 3):
                label = PRIORITY_LABELS.get(p, str(p))
                tempos = self.tempos.get(p, [])
                out[label] = {
                    "enqueued"      : self.enqueued.get(p, 0),
                    "done"          : self.done.get(p, 0),
                    "errors"        : self.errors.get(p, 0),
                    "tempo_medio_ms": int(sum(tempos) / len(tempos)) if tempos else 0,
                    "tempo_max_ms"  : max(tempos) if tempos else 0,
                }
            out["dropped"]    = self.dropped
            out["queue_size"] = self._queue_size   # preenchido externamente
            return out

    # Atualizado pelo scheduler
    _queue_size: int = 0


# ── Priority Scheduler ────────────────────────────────────────────────────────
class PriorityScheduler:
    """
    Scheduler central com fila de prioridade e dois pools separados:
      - lpr_pool   : ProcessPoolExecutor (PaddleOCR precisa de processo isolado)
      - yolo_pool  : ThreadPoolExecutor  (YOLOv8 é thread-safe)

    Uso:
        scheduler = PriorityScheduler()
        scheduler.start()
        scheduler.submit_lpr(image_path, camera_id, fn, *args, callback=cb)
        scheduler.submit_analytics(Priority.PESSOAS, image_path, camera_id, fn, *args)
        scheduler.shutdown()
    """

    def __init__(self):
        self._heap:    list        = []          # heap de Task
        self._heap_lock            = threading.Lock()
        self._heap_event           = threading.Event()

        self.stats                 = QueueStats()
        self._running              = False

        # Dois pools separados
        import multiprocessing as mp
        self._lpr_pool  = ProcessPoolExecutor(
            max_workers=LPR_WORKERS,
            mp_context=mp.get_context("spawn"),
        )
        self._yolo_pool = ThreadPoolExecutor(
            max_workers=ANALYTICS_WORKERS,
            thread_name_prefix="yolo-worker",
        )

        self._dispatcher_thread = threading.Thread(
            target=self._dispatcher_loop,
            daemon=True,
            name="priority-dispatcher",
        )

    # ── Ciclo de vida ─────────────────────────────────────────────────────────
    def start(self):
        self._running = True
        self._dispatcher_thread.start()
        log.info(
            "[SURICATHA-LOG] %s - PriorityScheduler iniciado "
            "lpr_workers=%d yolo_workers=%d queue_max=%d",
            _ts(), LPR_WORKERS, ANALYTICS_WORKERS, QUEUE_MAXSIZE
        )

    def shutdown(self, wait: bool = True):
        self._running = False
        self._heap_event.set()
        self._lpr_pool.shutdown(wait=wait)
        self._yolo_pool.shutdown(wait=wait)
        log.info("[SURICATHA-LOG] %s - PriorityScheduler encerrado", _ts())

    # ── Submissão pública ─────────────────────────────────────────────────────
    def submit_lpr(self, image_path: str, camera_id: int,
                   fn: Callable, *args,
                   callback: Optional[Callable] = None, **kwargs) -> bool:
        return self._enqueue(Task(
            priority=Priority.LPR,
            enqueued_at=time.monotonic(),
            fn=fn, args=args, kwargs=kwargs,
            callback=callback,
            image_path=image_path,
            camera_id=camera_id,
        ))

    def submit_analytics(self, priority: int,
                         image_path: str, camera_id: int,
                         fn: Callable, *args,
                         callback: Optional[Callable] = None, **kwargs) -> bool:
        assert priority in (Priority.PESSOAS, Priority.EPI), \
            f"Prioridade inválida para analytics: {priority}"
        return self._enqueue(Task(
            priority=priority,
            enqueued_at=time.monotonic(),
            fn=fn, args=args, kwargs=kwargs,
            callback=callback,
            image_path=image_path,
            camera_id=camera_id,
        ))

    # ── Internos ──────────────────────────────────────────────────────────────
    def _enqueue(self, task: Task) -> bool:
        with self._heap_lock:
            if len(self._heap) >= QUEUE_MAXSIZE:
                self.stats.record_dropped()
                log.warning(
                    "[SURICATHA-LOG] %s - Fila cheia (%d) — descartando %s P%d",
                    _ts(), QUEUE_MAXSIZE, task.image_path.split("/")[-1], task.priority
                )
                return False
            heapq.heappush(self._heap, task)
            self.stats.record_enqueue(task.priority)

        self._heap_event.set()
        return True

    def _pop(self) -> Optional[Task]:
        with self._heap_lock:
            if self._heap:
                return heapq.heappop(self._heap)
        return None

    def _dispatcher_loop(self):
        """
        Thread central: consome o heap em ordem de prioridade
        e despacha cada task para o pool correto.
        """
        log.info("[SURICATHA-LOG] %s - Dispatcher loop iniciado", _ts())
        while self._running:
            self._heap_event.wait(timeout=1.0)
            self._heap_event.clear()

            while True:
                task = self._pop()
                if task is None:
                    break

                label = PRIORITY_LABELS.get(task.priority, "?")
                log.debug(
                    "[SURICATHA-LOG] %s - Despachando P%d[%s] %s",
                    _ts(), task.priority, label, task.image_path.split("/")[-1]
                )

                # Escolhe o pool
                if task.priority == Priority.LPR:
                    pool = self._lpr_pool
                else:
                    pool = self._yolo_pool

                t_enqueued = task.enqueued_at
                t_priority = task.priority

                try:
                    future: Future = pool.submit(task.fn, *task.args, **task.kwargs)
                    future.add_done_callback(
                        self._make_callback(task, t_enqueued, t_priority)
                    )
                except Exception as exc:
                    log.error(
                        "[SURICATHA-LOG] %s - Submit falhou P%d[%s]: %s",
                        _ts(), task.priority, label, exc
                    )
                    self.stats.record_error(task.priority)

            # Atualiza tamanho para stats
            with self._heap_lock:
                self.stats._queue_size = len(self._heap)

    def _make_callback(self, task: Task, t_enqueued: float,
                       priority: int) -> Callable:
        """Gera callback que mede tempo e chama o callback do usuário."""
        def _cb(future: Future):
            elapsed_ms = int((time.monotonic() - t_enqueued) * 1000)
            label      = PRIORITY_LABELS.get(priority, "?")

            try:
                result = future.result(timeout=300)
                self.stats.record_done(priority, elapsed_ms)
                log.debug(
                    "[SURICATHA-LOG] %s - ✔ P%d[%s] concluído em %dms",
                    _ts(), priority, label, elapsed_ms
                )
                if task.callback:
                    task.callback(result, task)

            except Exception as exc:
                self.stats.record_error(priority)
                log.error(
                    "[SURICATHA-LOG] %s - ✘ P%d[%s] erro após %dms: %s",
                    _ts(), priority, label, elapsed_ms, exc
                )
                if task.callback:
                    task.callback({"ok": False, "error": str(exc)}, task)

        return _cb

    # ── Stats públicas ────────────────────────────────────────────────────────
    def get_stats(self) -> dict:
        snap = self.stats.snapshot()
        snap["pools"] = {
            "lpr_workers"       : LPR_WORKERS,
            "analytics_workers" : ANALYTICS_WORKERS,
        }
        return snap


# ── Singleton global ──────────────────────────────────────────────────────────
_scheduler: Optional[PriorityScheduler] = None
_sched_lock = threading.Lock()


def get_scheduler() -> PriorityScheduler:
    """Retorna o scheduler singleton, iniciando se necessário."""
    global _scheduler
    with _sched_lock:
        if _scheduler is None:
            _scheduler = PriorityScheduler()
            _scheduler.start()
    return _scheduler
