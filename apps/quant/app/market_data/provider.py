from abc import ABC, abstractmethod
from typing import List
from .models import Candle, Price, SymbolInfo


class MarketDataProvider(ABC):
    @abstractmethod
    def connect(self) -> dict:
        raise NotImplementedError

    @abstractmethod
    def get_current_price(self, symbol: str) -> Price:
        raise NotImplementedError

    @abstractmethod
    def get_candles(self, symbol: str, timeframe_minutes: int, count: int) -> List[Candle]:
        raise NotImplementedError

    @abstractmethod
    def get_symbol_info(self, symbol: str) -> SymbolInfo:
        raise NotImplementedError
