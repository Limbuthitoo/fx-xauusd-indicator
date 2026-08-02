from datetime import datetime, timezone
from typing import List
from .models import Candle, Price, SymbolInfo
from .provider import MarketDataProvider


class MT5UnavailableError(RuntimeError):
    pass


class MT5Provider(MarketDataProvider):
    def __init__(self):
        try:
            import MetaTrader5 as mt5
        except ImportError as exc:
            raise MT5UnavailableError(
                "The optional Python MT5 adapter is unavailable in this environment. Use the MT5 Bridge EA and WebRequest endpoint for live XAUUSD candles."
            ) from exc
        self.mt5 = mt5

    def connect(self) -> dict:
        if not self.mt5.initialize():
            code, message = self.mt5.last_error()
            raise MT5UnavailableError(f"MT5 initialize failed: {code} {message}")
        account = self.mt5.account_info()
        terminal = self.mt5.terminal_info()
        return {
            "connected": True,
            "account": None if account is None else account._asdict(),
            "terminal": None if terminal is None else terminal._asdict(),
        }

    def get_current_price(self, symbol: str) -> Price:
        self._ensure_symbol(symbol)
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            code, message = self.mt5.last_error()
            raise MT5UnavailableError(f"No MT5 tick for {symbol}: {code} {message}")
        bid = float(tick.bid)
        ask = float(tick.ask)
        return Price(
            symbol=symbol,
            bid=bid,
            ask=ask,
            spread=ask - bid,
            timestamp=datetime.fromtimestamp(tick.time, tz=timezone.utc).isoformat(),
            source="MT5",
        )

    def get_candles(self, symbol: str, timeframe_minutes: int, count: int) -> List[Candle]:
        self._ensure_symbol(symbol)
        timeframe = self._timeframe(timeframe_minutes)
        rates = self.mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
        if rates is None:
            code, message = self.mt5.last_error()
            raise MT5UnavailableError(f"No MT5 candles for {symbol}: {code} {message}")
        candles = []
        current_tick = self.mt5.symbol_info_tick(symbol)
        spread = None if current_tick is None else float(current_tick.ask - current_tick.bid)
        for rate in rates:
            candles.append(
                Candle(
                    timestamp=datetime.fromtimestamp(int(rate["time"]), tz=timezone.utc).isoformat(),
                    open=float(rate["open"]),
                    high=float(rate["high"]),
                    low=float(rate["low"]),
                    close=float(rate["close"]),
                    volume=float(rate["tick_volume"]),
                    spread=spread,
                    source="MT5",
                )
            )
        return candles

    def get_symbol_info(self, symbol: str) -> SymbolInfo:
        self._ensure_symbol(symbol)
        info = self.mt5.symbol_info(symbol)
        if info is None:
            code, message = self.mt5.last_error()
            raise MT5UnavailableError(f"No MT5 symbol info for {symbol}: {code} {message}")
        return SymbolInfo(
            symbol=symbol,
            digits=getattr(info, "digits", None),
            tick_size=getattr(info, "trade_tick_size", None),
            tick_value=getattr(info, "trade_tick_value", None),
            contract_size=getattr(info, "trade_contract_size", None),
            minimum_lot=getattr(info, "volume_min", None),
            maximum_lot=getattr(info, "volume_max", None),
            lot_step=getattr(info, "volume_step", None),
            source="MT5",
        )

    def _ensure_symbol(self, symbol: str) -> None:
        info = self.mt5.symbol_info(symbol)
        if info is None:
            raise MT5UnavailableError(f"Symbol {symbol} is not available in MT5 Market Watch.")
        if not info.visible and not self.mt5.symbol_select(symbol, True):
            raise MT5UnavailableError(f"Could not select symbol {symbol} in MT5 Market Watch.")

    def _timeframe(self, minutes: int):
        mapping = {
            1: self.mt5.TIMEFRAME_M1,
            2: self.mt5.TIMEFRAME_M2,
            3: self.mt5.TIMEFRAME_M3,
            4: self.mt5.TIMEFRAME_M4,
            5: self.mt5.TIMEFRAME_M5,
            15: self.mt5.TIMEFRAME_M15,
            30: self.mt5.TIMEFRAME_M30,
            60: self.mt5.TIMEFRAME_H1,
            240: self.mt5.TIMEFRAME_H4,
            1440: self.mt5.TIMEFRAME_D1,
        }
        if minutes not in mapping:
            raise MT5UnavailableError(f"Unsupported MT5 timeframe: {minutes} minutes")
        return mapping[minutes]
