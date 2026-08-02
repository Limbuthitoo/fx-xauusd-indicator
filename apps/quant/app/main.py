from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional
from .backtesting.orb_backtest import run_orb_backtest
from .importers.csv_importer import validate_candles
from .market_data.mt5_provider import MT5Provider, MT5UnavailableError

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


@app.get("/market-data/mt5/status")
def mt5_status():
    try:
        provider = MT5Provider()
        return provider.connect()
    except MT5UnavailableError as error:
        return {"connected": False, "error": str(error)}


@app.get("/market-data/mt5/price/{symbol}")
def mt5_price(symbol: str):
    try:
        provider = MT5Provider()
        provider.connect()
        return provider.get_current_price(symbol)
    except MT5UnavailableError as error:
        return {"connected": False, "error": str(error)}


@app.get("/market-data/mt5/candles/{symbol}")
def mt5_candles(symbol: str, timeframe_minutes: int = 5, count: int = 300):
    try:
        provider = MT5Provider()
        provider.connect()
        return {
            "connected": True,
            "symbol": symbol,
            "timeframeMinutes": timeframe_minutes,
            "candles": provider.get_candles(symbol, timeframe_minutes, count),
        }
    except MT5UnavailableError as error:
        return {"connected": False, "error": str(error), "candles": []}


@app.get("/market-data/mt5/symbol-info/{symbol}")
def mt5_symbol_info(symbol: str):
    try:
        provider = MT5Provider()
        provider.connect()
        return provider.get_symbol_info(symbol)
    except MT5UnavailableError as error:
        return {"connected": False, "error": str(error)}
