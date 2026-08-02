import pandas as pd


def validate_candles(candles):
    errors = []
    if not candles:
        return {"status": "INVALID", "errors": ["No candles supplied."], "row_count": 0}

    frame = pd.DataFrame(candles)
    required = {"timestamp", "open", "high", "low", "close"}
    missing = required.difference(frame.columns)
    if missing:
        errors.append(f"Missing required columns: {', '.join(sorted(missing))}.")
        return {"status": "INVALID", "errors": errors, "row_count": len(frame)}

    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    if frame["timestamp"].isna().any():
        errors.append("One or more timestamps could not be parsed as UTC-aware datetimes.")
    if frame["timestamp"].duplicated().any():
        errors.append("Duplicate candle timestamps found.")
    if not frame["timestamp"].is_monotonic_increasing:
        errors.append("Candles are not ordered by timestamp.")

    invalid_ohlc = frame[
        (frame["high"] < frame["low"])
        | (frame["high"] < frame["open"])
        | (frame["high"] < frame["close"])
        | (frame["low"] > frame["open"])
        | (frame["low"] > frame["close"])
        | (frame["open"] <= 0)
        | (frame["high"] <= 0)
        | (frame["low"] <= 0)
        | (frame["close"] <= 0)
    ]
    if len(invalid_ohlc):
        errors.append(f"{len(invalid_ohlc)} rows contain invalid OHLC prices.")

    return {
        "status": "INVALID" if errors else "VALID",
        "errors": errors,
        "row_count": len(frame),
        "start": None if frame["timestamp"].isna().all() else frame["timestamp"].min().isoformat(),
        "end": None if frame["timestamp"].isna().all() else frame["timestamp"].max().isoformat(),
    }
