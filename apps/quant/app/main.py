from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional
from .backtesting.orb_backtest import run_orb_backtest
from .importers.csv_importer import validate_candles

app = FastAPI(title="XAUUSD ORB Quant Service", version="0.1.0")


class Candle(BaseModel):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: Optional[float] = None
    spread: Optional[float] = None


class BacktestRequest(BaseModel):
    candles: List[Candle]
    session_start: str = "09:30"
    opening_range_minutes: int = 15
    trade_window_end: str = "16:00"
    minimum_reward_to_risk: float = 1.5


@app.get("/health")
def health():
    return {"status": "ok", "service": "xauusd-orb-quant"}


@app.post("/validate-csv")
def validate_csv(candles: List[Candle]):
    return validate_candles([candle.model_dump() for candle in candles])


@app.post("/backtest/orb")
def backtest_orb(payload: BacktestRequest):
    return run_orb_backtest(payload.model_dump())
