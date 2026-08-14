#!/usr/bin/env python3
"""Build the training set for a Kronos fine-tune from Binance klines.

WHAT THIS IS FOR. Fine-tuning Kronos on OUR markets is the shortest honest path
to "our own model": the training script already ships (GitHub/Kronos/finetune/
train_predictor.py), the card is enough (RTX 5080, ~13 GB free), and the
comparison already exists — ours vs Kronos-base vs a random walk, on the
scoreboard scripts/kronos/forecast.py already keeps.

WHAT IT IS NOT. It does not train anything. Training is hours of GPU time and it
belongs in a run you start deliberately, not in a data-prep script.

THE CONTRACT, read off the Kronos repo rather than guessed:
  finetune/dataset.py loads   {dataset_path}/train_data.pkl | val_data.pkl | test_data.pkl
  each pickle is             {symbol: DataFrame}
  each DataFrame has         a DatetimeIndex named "datetime"
  and the columns            open, high, low, close, vol, amt   (config.feature_list)
  time features (minute/hour/weekday/day/month) are derived by the loader, not stored.

`amt` is turnover in the quote currency — Binance gives it directly as the kline's
quote asset volume, so nothing has to be reconstructed from price × size.

The upstream pipeline goes through Qlib and the CSI 300. Binance is not Qlib and
crypto is not the CSI 300, so this replaces qlib_data_preprocess.py entirely and
writes the same three pickles. Point finetune/config.py's `dataset_path` at the
output and the trainer needs no other change.

WHY THE SPLITS ARE WHAT THEY ARE. Train / validation / test are contiguous and in
chronological order, and the validation and test windows START BEFORE the previous
window ends by exactly `lookback_window` bars — the same overlap the upstream
config uses, because a sample needs its lookback to exist. That overlap is history
the model may LOOK at, never a label it may learn from. Any other arrangement
(shuffling, random splits) leaks the future into the past and would make every
number that follows meaningless.

Usage:
    python scripts/kronos/prepare_binance.py --out ../Kronos/finetune/data/mmmxcix
    python scripts/kronos/prepare_binance.py --interval 1h --years 4 --symbols BTCUSDT,ETHUSDT
    python scripts/kronos/prepare_binance.py --dry     # fetch a little, print, write nothing
"""

from __future__ import annotations

import argparse
import os
import pickle
import sys
import time
from datetime import datetime, timezone

import pandas as pd
import requests

# The Windows console is cp1252 and cannot encode the characters this script
# prints; without this, a successful fetch dies on its own progress line.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BINANCE = "https://api.binance.com/api/v3/klines"
MAX_LIMIT = 1000  # Binance's hard cap per request

# The venues Argus and the arena actually trade, so the model is trained on the
# markets it will be judged on. Anything wider is a different experiment.
DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT", "LTCUSDT"]

INTERVAL_MS = {
    "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
}

# Matches finetune/config.py. Kept here so the split maths can honour the
# lookback overlap without importing the trainer's config.
LOOKBACK_WINDOW = 90


def fetch_klines(symbol: str, interval: str, start_ms: int, end_ms: int, pause: float = 0.25) -> pd.DataFrame:
    """Page forward through Binance klines. Public endpoint, no key needed."""
    step = INTERVAL_MS[interval]
    rows: list[list] = []
    cursor = start_ms
    while cursor < end_ms:
        r = requests.get(
            BINANCE,
            params={"symbol": symbol, "interval": interval, "startTime": cursor, "limit": MAX_LIMIT},
            timeout=30,
            headers={"user-agent": "mmmxcix-quant/kronos-prep"},
        )
        if r.status_code == 429:
            # Binance asks for a pause rather than a retry storm.
            time.sleep(5)
            continue
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        last_open = batch[-1][0]
        cursor = last_open + step
        if len(batch) < MAX_LIMIT:
            break
        time.sleep(pause)

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows, columns=[
        "open_time", "open", "high", "low", "close", "volume", "close_time",
        "quote_volume", "trades", "taker_base", "taker_quote", "ignore",
    ])
    out = pd.DataFrame({
        "open": df["open"].astype(float),
        "high": df["high"].astype(float),
        "low": df["low"].astype(float),
        "close": df["close"].astype(float),
        # config.feature_list names them vol and amt: base volume and quote turnover.
        "vol": df["volume"].astype(float),
        "amt": df["quote_volume"].astype(float),
    })
    out.index = pd.to_datetime(df["open_time"], unit="ms", utc=True).dt.tz_localize(None)
    out.index.name = "datetime"
    # Binance can repeat a boundary candle across pages; the last write wins and
    # the index must be strictly increasing for the sliding window to mean anything.
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out


def split_ranges(index: pd.DatetimeIndex, interval: str, train=0.7, val=0.15):
    """
    Chronological train/val/test boundaries, with the val and test windows
    reaching back `LOOKBACK_WINDOW` bars so the first sample of each has its
    history. The overlap is context, never a label — see the module docstring.
    """
    n = len(index)
    i_train_end = int(n * train)
    i_val_end = int(n * (train + val))
    back = LOOKBACK_WINDOW
    return {
        "train": (index[0], index[i_train_end - 1]),
        "val": (index[max(0, i_train_end - back)], index[i_val_end - 1]),
        "test": (index[max(0, i_val_end - back)], index[n - 1]),
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default="./data/kronos_binance", help="directory for the three pickles")
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    p.add_argument("--interval", default="1h", choices=sorted(INTERVAL_MS))
    p.add_argument("--years", type=float, default=4.0)
    p.add_argument("--dry", action="store_true", help="fetch a short window, print the shape, write nothing")
    a = p.parse_args()

    symbols = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
    now_ms = int(time.time() * 1000)
    span_ms = int(a.years * 365.25 * 86_400_000)
    start_ms = now_ms - (INTERVAL_MS[a.interval] * 400 if a.dry else span_ms)

    frames: dict[str, pd.DataFrame] = {}
    for sym in symbols:
        print(f"  {sym} {a.interval} …", end="", flush=True)
        df = fetch_klines(sym, a.interval, start_ms, now_ms)
        if df.empty:
            print(" NO DATA — skipped")
            continue
        frames[sym] = df
        print(f" {len(df):,} bars  {df.index[0].date()} -> {df.index[-1].date()}")

    if not frames:
        print("Nothing fetched.", file=sys.stderr)
        return 1

    # One shared calendar for the splits: per-symbol boundaries would give each
    # symbol a different test period, and the scoreboard could not compare them.
    all_index = sorted(set().union(*(set(df.index) for df in frames.values())))
    ranges = split_ranges(pd.DatetimeIndex(all_index), a.interval)

    print("\nsplits (chronological, val/test reach back one lookback for context):")
    for name, (lo, hi) in ranges.items():
        print(f"  {name:5} {lo} -> {hi}")

    parts = {name: {} for name in ranges}
    for sym, df in frames.items():
        for name, (lo, hi) in ranges.items():
            part = df[(df.index >= lo) & (df.index <= hi)]
            if len(part) > LOOKBACK_WINDOW:
                parts[name][sym] = part

    print("\nrows per split:")
    for name in ranges:
        total = sum(len(d) for d in parts[name].values())
        print(f"  {name:5} {len(parts[name])} symbols, {total:,} rows")

    if a.dry:
        sym = next(iter(frames))
        print(f"\nDRY RUN — nothing written. Sample of {sym}:")
        print(frames[sym].head(3))
        print(f"columns: {list(frames[sym].columns)}  (config.feature_list expects open/high/low/close/vol/amt)")
        return 0

    os.makedirs(a.out, exist_ok=True)
    for name in ranges:
        path = os.path.join(a.out, f"{name}_data.pkl")
        with open(path, "wb") as f:
            pickle.dump(parts[name], f)
        print(f"wrote {path}")

    print(f"""
Next, in the Kronos checkout:
  1. finetune/config.py → dataset_path = "{os.path.abspath(a.out)}"
  2. finetune/config.py → use_comet = False   (unless you want the tracker)
  3. python finetune/train_tokenizer.py       (optional; skip to reuse base's tokenizer)
  4. python finetune/train_predictor.py

Then grade it the same way as everything else: scripts/kronos/forecast.py
scores every forecast against what happened AND against a random walk. Ours vs
Kronos-base vs random walk, on the board that already exists. Generated at {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z.
""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
