from pydantic import BaseModel
from typing import Optional


class Price(BaseModel):
    symbol: str
    bid: float
    ask: float
    spread: float
    timestamp: str
    source: str


class Candle(BaseModel):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: Optional[float] = None
    spread: Optional[float] = None
    source: str = "MT5"


class SymbolInfo(BaseModel):
    symbol: str
    digits: Optional[int] = None
    tick_size: Optional[float] = None
    tick_value: Optional[float] = None
    contract_size: Optional[float] = None
    minimum_lot: Optional[float] = None
    maximum_lot: Optional[float] = None
    lot_step: Optional[float] = None
    source: str
