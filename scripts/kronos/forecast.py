#!/usr/bin/env python3
"""Kronos forecasting service.

Kronos is a foundation model for candlestick sequences (NeoQuasar/Kronos on
Hugging Face). It runs on the PC, not in the browser: it is a PyTorch
transformer with a learned K-line tokenizer, and Cloudflare Pages cannot host
that. This script fetches candles, forecasts, and pushes the result to
/api/kronos, exactly the way scripts/argus-agent.mjs feeds /api/argus.

WHAT IS ACTUALLY SHIPPED HERE is a scoreboard, not a picture of a forecast.
Every prediction is written down with the horizon it claims, and once that
horizon has passed it is scored against what happened AND against a random walk
— the naive "tomorrow looks like today" baseline that most price models quietly
fail to beat. A forecast nobody grades is decoration, and a foundation model
with a good paper is not evidence about these markets.

Setup (one time):
    pip install -r scripts/kronos/requirements.txt
    # weights download automatically on first run (~500MB for base)

Run:
    LAB_TOKEN=... python scripts/kronos/forecast.py
    python scripts/kronos/forecast.py --dry          # no push, prints instead
    python scripts/kronos/forecast.py --model small  # mini | small | base

An RTX 5080 runs `base` comfortably; `mini` exists for CPU-only machines and is
markedly weaker, so it is not the default here.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import pathlib
import urllib.request
from datetime import datetime, timezone

# Windows consoles default to cp1252, which cannot encode an arrow or an
# ellipsis — a forecast that worked would die on the line printing it, and the
# daemon writes this output to a log file where the same applies.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

API = os.environ.get("KRONOS_API", "https://quant.mmmxcix.com/api/kronos")
# LAB_TOKEN is the fleet-wide name for this secret; DEV_ACCESS_TOKEN is what the
# Cloudflare binding calls it. Accept either.
TOKEN = os.environ.get("LAB_TOKEN") or os.environ.get("DEV_ACCESS_TOKEN", "")

# Model sizes as published. The tokenizer is shared; -2k pairs with the larger
# context window and is only worth it if you feed more than 512 bars.
MODELS = {
    "mini": ("NeoQuasar/Kronos-mini", "NeoQuasar/Kronos-Tokenizer-2k", 2048),
    "small": ("NeoQuasar/Kronos-small", "NeoQuasar/Kronos-Tokenizer-base", 512),
    "base": ("NeoQuasar/Kronos-base", "NeoQuasar/Kronos-Tokenizer-base", 512),
}

# What we forecast. Crypto only for the first pass: Binance klines need no key,
# no entitlement and no market hours, so the scoreboard fills continuously.
UNIVERSE = [
    {"symbol": "BTCUSDT", "interval": "1h"},
    {"symbol": "ETHUSDT", "interval": "1h"},
]
LOOKBACK = 400          # bars of context fed to the model
PRED_LEN = 24           # bars forecast ahead (24h on the 1h interval)


def fetch_klines(symbol: str, interval: str, limit: int) -> list[dict]:
    url = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}"
    with urllib.request.urlopen(url, timeout=30) as r:
        raw = json.load(r)
    return [
        {
            "time": int(k[0]) // 1000,
            "open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
            "close": float(k[4]), "volume": float(k[5]),
        }
        for k in raw
    ]


# The Kronos package (MIT) is a checkout, not a PyPI wheel — its `model` package
# has to be on the path. Looked up next to this repo by default so a fresh clone
# needs no configuration; override with KRONOS_HOME.
def _add_kronos_to_path() -> None:
    here = pathlib.Path(__file__).resolve()
    candidates = [os.environ.get("KRONOS_HOME"), str(here.parents[2].parent / "Kronos")]
    for c in candidates:
        if c and (pathlib.Path(c) / "model" / "__init__.py").exists():
            if c not in sys.path:
                sys.path.insert(0, c)
            return
    sys.exit(
        "Kronos package not found. Clone it next to this repo:\n"
        "  git clone --depth 1 https://github.com/shiyu-coder/Kronos.git\n"
        "…or point KRONOS_HOME at an existing checkout."
    )


def load_predictor(size: str):
    """Import lazily so --score-only works on a machine without torch."""
    _add_kronos_to_path()
    try:
        import pandas as pd  # noqa: F401
        import torch
        from model import Kronos, KronosPredictor, KronosTokenizer
    except ImportError as e:
        sys.exit(
            f"missing dependency: {e}\n"
            "Install with:  pip install -r scripts/kronos/requirements.txt\n"
            "The Kronos package itself is `pip install kronos-forecast` or a checkout of\n"
            "github.com/shiyu-coder/Kronos on PYTHONPATH."
        )
    name, tok_name, max_ctx = MODELS[size]
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    if device == "cpu" and size != "mini":
        print(f"warning: no CUDA found — {size} on CPU will be slow", file=sys.stderr)
    tokenizer = KronosTokenizer.from_pretrained(tok_name)
    model = Kronos.from_pretrained(name)
    return KronosPredictor(model, tokenizer, device=device, max_context=max_ctx), device


def forecast_one(predictor, candles: list[dict], pred_len: int) -> list[dict]:
    import pandas as pd

    df = pd.DataFrame(candles)[["open", "high", "low", "close", "volume"]]
    ts = pd.to_datetime([c["time"] for c in candles], unit="s")
    step = ts[-1] - ts[-2]
    future = pd.Series([ts[-1] + step * (i + 1) for i in range(pred_len)])

    out = predictor.predict(
        df=df, x_timestamp=pd.Series(ts), y_timestamp=future,
        pred_len=pred_len, T=1.0, top_p=0.9, sample_count=1, verbose=False,
    )
    return [
        {
            "time": int(future[i].timestamp()),
            "open": float(out["open"].iloc[i]), "high": float(out["high"].iloc[i]),
            "low": float(out["low"].iloc[i]), "close": float(out["close"].iloc[i]),
        }
        for i in range(len(out))
    ]


# ── The paper account ───────────────────────────────────────────────────────
# Kronos does not just publish forecasts, it has to LIVE off them, the same way
# Argus and Cortex do. It starts with a fixed budget and every decision it makes
# is written into a journal — including the decisions NOT to trade, which are
# the ones a track record normally loses.
#
# Why a budget at all: forecast error alone cannot tell you whether a model is
# useful. A model can beat a random walk on average and still lose money, because
# being slightly closer on the quiet days does not pay for being wrong on the
# violent ones. The account is what makes that visible.
START_BUDGET = 10_000.0      # USDT, paper
RISK_PCT = 1.0               # of equity, per trade
MIN_EDGE_PCT = 1.0           # a forecast under this is noise next to the fees
STOP_PCT = 1.5               # distance to the stop, in percent of entry
TAKER_FEE = 0.001            # per leg — a directional 24h trade pays both
JOURNAL_CAP = 300


def new_account() -> dict:
    return {
        "budget": START_BUDGET, "equity": START_BUDGET,
        "closed": [], "journal": [], "startedAt": int(time.time()),
    }


def journal(acct: dict, symbol: str, action: str, detail: str) -> None:
    acct["journal"].append({
        "at": int(time.time()), "symbol": symbol, "action": action, "detail": detail,
    })
    acct["journal"] = acct["journal"][-JOURNAL_CAP:]
    print(f"  [{symbol}] {action}: {detail}")


def decide_trade(acct: dict, symbol: str, anchor: float, fc: list[dict],
                 committed: float = 0.0) -> dict | None:
    """Turn a forecast into a position, or into a written reason for passing.

    `committed` is the notional already tied up in open positions. Risking 1%
    behind a 1.5% stop needs ~67% of the account as notional, so two symbols
    firing on the same pass would ask for 133% of a cash account. Sizing each
    trade against equity ALONE is the standard way a paper account quietly ends
    up leveraged; the free-cash cap is what stops it.
    """
    target = fc[-1]["close"]
    edge_pct = (target - anchor) / anchor * 100
    if abs(edge_pct) < MIN_EDGE_PCT:
        journal(acct, symbol, "no trade",
                f"forecast {edge_pct:+.2f}% over {PRED_LEN} bars — under the {MIN_EDGE_PCT}% floor, "
                f"which the {TAKER_FEE * 200:.1f}% round trip would eat")
        return None

    side = "long" if edge_pct > 0 else "short"
    stop = anchor * (1 - STOP_PCT / 100) if side == "long" else anchor * (1 + STOP_PCT / 100)
    risk_amt = acct["equity"] * RISK_PCT / 100
    stake = risk_amt / (STOP_PCT / 100)          # notional that risks exactly RISK_PCT
    free = max(0.0, acct["equity"] - committed)
    if free < stake * 0.25:
        journal(acct, symbol, "no trade",
                f"forecast {edge_pct:+.2f}% is tradeable, but {committed:.0f} of "
                f"{acct['equity']:.0f} USDT is already committed — not enough free cash")
        return None
    if stake > free:
        stake = free
        risk_amt = stake * STOP_PCT / 100        # the risk shrinks with the size
        journal(acct, symbol, "sized down",
                f"only {free:.0f} USDT free — taking a smaller position, risking {risk_amt:.0f}")
    journal(acct, symbol, f"open {side}",
            f"forecast {edge_pct:+.2f}% → {side} {stake:.0f} USDT at {anchor:.2f}, "
            f"stop {stop:.2f} ({STOP_PCT}%), risking {risk_amt:.0f}")
    return {
        "side": side, "entry": anchor, "stop": stop, "target": target,
        "stake": stake, "riskAmt": risk_amt, "openedAt": int(time.time()),
    }


def settle_trade(acct: dict, symbol: str, trade: dict, bars: list[dict]) -> None:
    """Walk the realised bars in order and close the position the way it would
    actually have closed: the stop first, because within a single bar we cannot
    know which came first and assuming the good one is how paper accounts lie."""
    entry, side, stake = trade["entry"], trade["side"], trade["stake"]
    exit_px, reason = bars[-1]["close"], "horizon"
    for b in bars:
        if side == "long":
            if b["low"] <= trade["stop"]:
                exit_px, reason = trade["stop"], "stop"
                break
            if b["high"] >= trade["target"]:
                exit_px, reason = trade["target"], "target"
                break
        else:
            if b["high"] >= trade["stop"]:
                exit_px, reason = trade["stop"], "stop"
                break
            if b["low"] <= trade["target"]:
                exit_px, reason = trade["target"], "target"
                break

    direction = 1 if side == "long" else -1
    gross = stake * direction * (exit_px - entry) / entry
    pnl = gross - stake * TAKER_FEE * 2
    acct["equity"] += pnl
    r = pnl / trade["riskAmt"] if trade["riskAmt"] > 0 else 0.0
    acct["closed"].append({
        **trade, "symbol": symbol, "exit": exit_px, "reason": reason,
        "pnl": pnl, "R": r, "closedAt": int(time.time()),
    })
    journal(acct, symbol, f"close {reason}",
            f"{side} {entry:.2f} → {exit_px:.2f} = {pnl:+.2f} USDT ({r:+.2f}R), "
            f"equity now {acct['equity']:.2f}")


def account_stats(acct: dict) -> dict:
    closed = acct["closed"]
    n = len(closed)
    wins = sum(1 for c in closed if c["pnl"] > 0)
    rs = [c["R"] for c in closed]
    avg_r = sum(rs) / n if n else 0.0
    sd = (sum((r - avg_r) ** 2 for r in rs) / (n - 1)) ** 0.5 if n > 1 else 0.0
    t_stat = avg_r / (sd / (n ** 0.5)) if n > 1 and sd > 0 else 0.0
    # Peak-to-trough on the realised equity path, not just the final number.
    eq, peak, max_dd = acct["budget"], acct["budget"], 0.0
    for c in closed:
        eq += c["pnl"]
        peak = max(peak, eq)
        if peak > 0:
            max_dd = max(max_dd, (peak - eq) / peak * 100)
    return {
        "budget": acct["budget"], "equity": acct["equity"],
        "returnPct": (acct["equity"] - acct["budget"]) / acct["budget"] * 100,
        "n": n, "wins": wins, "winRate": (wins / n * 100) if n else 0.0,
        "avgR": avg_r, "tStat": t_stat, "maxDrawdownPct": max_dd,
        "startedAt": acct.get("startedAt", 0),
    }


def score_due(pending: list[dict], acct: dict) -> tuple[list[dict], list[dict]]:
    """Grade every forecast whose horizon has passed, and settle the position it
    opened.

    Scored two ways, because only the second one means anything:
      - MAE of the forecast against the realised closes;
      - the same MAE for a RANDOM WALK that just repeats the last known close.
    A model that cannot beat the random walk has learned nothing about price,
    however impressive its forecast looks drawn on a chart.
    """
    now = int(time.time())
    still, done = [], []
    for p in pending:
        if p["dueAt"] > now:
            still.append(p)
            continue
        try:
            actual = fetch_klines(p["symbol"], p["interval"], PRED_LEN + 5)
        except Exception as e:                     # network hiccup — try again later
            print(f"score fetch failed for {p['symbol']}: {e}", file=sys.stderr)
            still.append(p)
            continue
        if p.get("trade"):
            window = [c for c in actual if c["time"] >= p["trade"]["openedAt"] - 3600]
            if window:
                settle_trade(acct, p["symbol"], p["trade"], window)
        by_time = {c["time"]: c["close"] for c in actual}
        pairs = [(f["close"], by_time[f["time"]]) for f in p["forecast"] if f["time"] in by_time]
        if len(pairs) < max(3, PRED_LEN // 2):
            still.append(p)                        # not enough realised bars yet
            continue
        anchor = p["lastClose"]
        mae = sum(abs(f - a) for f, a in pairs) / len(pairs)
        naive = sum(abs(anchor - a) for _, a in pairs) / len(pairs)
        # Direction over the whole horizon: did it call up vs down correctly?
        dir_ok = (pairs[-1][0] - anchor) * (pairs[-1][1] - anchor) > 0
        done.append({
            "symbol": p["symbol"], "interval": p["interval"], "at": p["at"],
            "n": len(pairs), "maeKronos": mae, "maeNaive": naive,
            "skill": (naive - mae) / naive if naive > 0 else 0.0,
            "directionOk": bool(dir_ok),
        })
    return still, done


def push(payload: dict, dry: bool) -> None:
    if dry or not TOKEN:
        print(json.dumps(payload, indent=2)[:4000])
        if not TOKEN and not dry:
            print("LAB_TOKEN not set — nothing pushed.", file=sys.stderr)
        return
    body = json.dumps({**payload, "token": TOKEN}).encode()
    # An explicit User-Agent is required, not cosmetic: Cloudflare answers
    # urllib's default "Python-urllib/3.x" with a 403 before the request ever
    # reaches the function, which looks exactly like an auth failure and is not.
    req = urllib.request.Request(API, data=body, headers={
        "content-type": "application/json",
        "user-agent": "mmmxcix-kronos-agent/1.0 (+https://quant.mmmxcix.com)",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print("pushed:", r.read().decode()[:200])
    except Exception as e:
        print(f"push failed: {e}", file=sys.stderr)


def state_path() -> str:
    return os.path.join(os.path.dirname(__file__), ".kronos-pending.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=list(MODELS), default="base")
    ap.add_argument("--dry", action="store_true", help="print instead of pushing")
    ap.add_argument("--score-only", action="store_true", help="grade due forecasts, make no new ones")
    args = ap.parse_args()

    try:
        with open(state_path(), encoding="utf-8") as fh:
            store = json.load(fh)
    except (OSError, ValueError):
        store = {"pending": [], "scored": [], "account": new_account()}

    acct = store.get("account") or new_account()
    store["account"] = acct
    store["pending"], newly = score_due(store.get("pending", []), acct)
    store["scored"] = (store.get("scored", []) + newly)[-200:]
    for s in newly:
        verdict = "beat" if s["skill"] > 0 else "LOST to"
        print(f"scored {s['symbol']}: MAE {s['maeKronos']:.2f} vs naive {s['maeNaive']:.2f} "
              f"— {verdict} the random walk ({s['skill'] * 100:+.1f}%)")

    forecasts = []
    if not args.score_only:
        predictor, device = load_predictor(args.model)
        print(f"kronos-{args.model} on {device}")
        for u in UNIVERSE:
            candles = fetch_klines(u["symbol"], u["interval"], LOOKBACK)
            fc = forecast_one(predictor, candles, PRED_LEN)
            last = candles[-1]
            forecasts.append({
                "symbol": u["symbol"], "interval": u["interval"], "model": args.model,
                "at": int(time.time()), "lastClose": last["close"], "lastTime": last["time"],
                "forecast": fc,
            })
            committed = sum(x["trade"]["stake"] for x in store["pending"] if x.get("trade"))
            trade = decide_trade(acct, u["symbol"], last["close"], fc, committed)
            store["pending"].append({
                "symbol": u["symbol"], "interval": u["interval"], "at": int(time.time()),
                "lastClose": last["close"], "forecast": fc,
                "dueAt": fc[-1]["time"] + 3600, "trade": trade,
            })
            print(f"{u['symbol']}: {last['close']:.2f} → {fc[-1]['close']:.2f} in {PRED_LEN} bars")

    # Aggregate the scoreboard the page leads with.
    agg: dict[str, dict] = {}
    for s in store["scored"]:
        a = agg.setdefault(s["symbol"], {"symbol": s["symbol"], "n": 0, "wins": 0,
                                         "skillSum": 0.0, "dirOk": 0})
        a["n"] += 1
        a["wins"] += 1 if s["skill"] > 0 else 0
        a["skillSum"] += s["skill"]
        a["dirOk"] += 1 if s["directionOk"] else 0
    scoreboard = [
        {"symbol": a["symbol"], "n": a["n"],
         "beatNaivePct": 100 * a["wins"] / a["n"],
         "avgSkillPct": 100 * a["skillSum"] / a["n"],
         "directionPct": 100 * a["dirOk"] / a["n"]}
        for a in agg.values()
    ]

    with open(state_path(), "w", encoding="utf-8") as fh:
        json.dump(store, fh)

    stats = account_stats(acct)
    print(f"account: {stats['equity']:.2f} of {stats['budget']:.0f} USDT "
          f"({stats['returnPct']:+.2f}%), {stats['n']} closed trades")

    push({
        "forecasts": forecasts,
        "scoreboard": scoreboard,
        "scoredCount": len(store["scored"]),
        "account": {
            **stats,
            # The open positions are part of the picture — an account shown only
            # by its closed trades hides whatever is currently going wrong.
            "open": [
                {"symbol": p["symbol"], **p["trade"]}
                for p in store["pending"] if p.get("trade")
            ],
            "closed": acct["closed"][-60:],
            "journal": acct["journal"][-80:],
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }, args.dry)


if __name__ == "__main__":
    main()
