import numpy as np


def performance_metrics(results_r):
    values = np.array(results_r, dtype=float)
    if len(values) == 0:
        return {
            "total_trades": 0,
            "total_r": 0,
            "expectancy": 0,
            "profit_factor": 0,
            "maximum_drawdown": 0,
        }

    wins = values[values > 0]
    losses = values[values < 0]
    equity = values.cumsum()
    running_high = np.maximum.accumulate(equity)
    drawdown = equity - running_high
    gross_win = wins.sum()
    gross_loss = abs(losses.sum())
    return {
        "total_trades": int(len(values)),
        "total_r": float(values.sum()),
        "expectancy": float(values.mean()),
        "profit_factor": float(gross_win / gross_loss) if gross_loss else float("inf"),
        "maximum_drawdown": float(drawdown.min()) if len(drawdown) else 0,
        "wins": int(len(wins)),
        "losses": int(len(losses)),
    }
