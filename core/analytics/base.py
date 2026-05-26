"""
/app/core/analytics/base.py
SuricathaIA — Base abstrata para motores de analytics.
Todo motor (LPR, Pessoas, EPI) herda desta classe.
"""

import time
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger("suricatha.analytics")


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


@dataclass
class AnalyticsResult:
    """Resultado base retornado por qualquer motor."""
    motor:      str                  # "lpr" | "pessoas" | "epi"
    success:    bool
    tempo_ms:   int
    error:      Optional[str] = None
    dados:      dict           = field(default_factory=dict)


class AnalyticsEngine(ABC):
    """
    Classe base para todos os motores de analytics.
    Implementa pattern Template Method: subclasses implementam _process().
    """

    @property
    @abstractmethod
    def nome(self) -> str:
        """Identificador do motor. Ex: 'pessoas'"""

    @abstractmethod
    def _load_model(self):
        """Carrega o modelo de IA (chamado uma vez no __init__)."""

    @abstractmethod
    def _process(self, image_path: str) -> dict:
        """
        Processa a imagem e retorna dict com resultados específicos do motor.
        Não lança exceções — captura internamente e retorna {"error": msg}.
        """

    def process(self, image_path: str) -> AnalyticsResult:
        """Entry point público. Mede tempo e padroniza o retorno."""
        t0 = time.perf_counter()
        try:
            dados = self._process(image_path)
            ms    = int((time.perf_counter() - t0) * 1000)
            error = dados.pop("_error", None)
            log.info(
                "[SURICATHA-LOG] %s - [%s] %s tempo=%dms",
                _ts(), self.nome.upper(), image_path.split("/")[-1], ms
            )
            return AnalyticsResult(
                motor=self.nome, success=error is None,
                tempo_ms=ms, error=error, dados=dados
            )
        except Exception as exc:
            ms = int((time.perf_counter() - t0) * 1000)
            log.error("[SURICATHA-LOG] %s - [%s] ERRO: %s", _ts(), self.nome, exc)
            return AnalyticsResult(
                motor=self.nome, success=False,
                tempo_ms=ms, error=str(exc)
            )
