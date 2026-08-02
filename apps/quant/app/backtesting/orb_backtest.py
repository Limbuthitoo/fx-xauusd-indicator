import pandas as pd
from ..importers.csv_importer import validate_candles
from ..metrics.performance import performance_metrics


def run_orb_backtest(payload):
    candles = [dict(candle) for candle in payload["candles"]]
    validation = validate_candles(candles)
    if validation["status"] != "VALID":
        return {"status": "INVALID_DATA", "validation": validation}

    frame = pd.DataFrame(candles)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    frame = frame.sort_values("timestamp")
    frame["ny_date"] = frame["timestamp"].dt.tz_convert("America/New_York").dt.date
    frame["ny_time"] = frame["timestamp"].dt.tz_convert("America/New_York").dt.strftime("%H:%M")

    trades = []
    for session_date, group in frame.groupby("ny_date"):
        group = group.copy()
        range_candles = group[
            (group["ny_time"] >= payload["session_start"])
            & (group["ny_time"] < _add_minutes(payload["session_start"], payload["opening_range_minutes"]))
        ]
        if len(range_candles) == 0:
            continue

        orb_high = float(range_candles["high"].max())
        orb_low = float(range_candles["low"].min())
        orb_width = orb_high - orb_low
        signal_candles = group[
            (group["ny_time"] >= _add_minutes(payload["session_start"], payload["opening_range_minutes"]))
            & (group["ny_time"] <= payload["trade_window_end"])
        ]

        for _, candle in signal_candles.iterrows():
            direction = None
            if candle["close"] > orb_high:
                direction = "LONG"
                entry = float(candle["close"])
                stop = orb_low
                target = entry + (entry - stop) * 2
            elif candle["close"] < orb_low:
                direction = "SHORT"
                entry = float(candle["close"])
                stop = orb_high
                target = entry - (stop - entry) * 2
            else:
                continue

            result = _simulate(signal_candles[signal_candles["timestamp"] > candle["timestamp"]], direction, stop, target)
            trades.append({
                "session_date": str(session_date),
                "scenario": "CLEAN_BREAKOUT_CONTINUATION",
                "direction": direction,
                "entry_price": entry,
                "stop_price": stop,
                "target_price": target,
                "orb_width": orb_width,
                **result,
            })
            break

    return {
        "status": "COMPLETED",
        "trades": trades,
        "metrics": performance_metrics([trade["result_r"] for trade in trades]),
        "note": "Sequential replay uses conservative same-candle ambiguity handling and does not use future range data.",
    }


def _simulate(future, direction, stop, target):
    for _, candle in future.iterrows():
        hit_stop = candle["low"] <= stop if direction == "LONG" else candle["high"] >= stop
        hit_target = candle["high"] >= target if direction == "LONG" else candle["low"] <= target
        if hit_stop and hit_target:
            return {"outcome": "LOSS", "result_r": -1.0, "ambiguous": True}
        if hit_stop:
            return {"outcome": "LOSS", "result_r": -1.0, "ambiguous": False}
        if hit_target:
            return {"outcome": "WIN", "result_r": 2.0, "ambiguous": False}
    return {"outcome": "BREAKEVEN", "result_r": 0.0, "ambiguous": False}


def _add_minutes(hhmm, minutes):
    stamp = pd.Timestamp(f"2000-01-01 {hhmm}") + pd.Timedelta(minutes=minutes)
    return stamp.strftime("%H:%M")
