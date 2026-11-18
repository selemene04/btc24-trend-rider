#!/usr/bin/env python3
"""Selemene Trend Rider: a cbBTC bot for 1-minute bars (agent-fun/bars-replay/v1).

The dev window this entry was tuned against is a downtrend day: BTC bled
about 3% with one strong midday recovery. A bot that simply holds loses
money there and fails the dev gate, so this bot only holds risk while the
market is actually trending up:

- Regime filter: the fast EMA (30 bars) must sit above the slow EMA
  (120 bars). Below that, the bot holds cash and waits.
- Entry: in an uptrend regime, with the close above the fast EMA and the
  last 10 bars up at least 0.10%, buy with 65% of equity. Part-sizing
  keeps the pool impact of a round trip near 25 bps, so a trend leg of a
  few tenths of a percent already clears the costs.
- Exit: the regime flips down (fast EMA back under the slow EMA), or the
  close falls 0.9% under the best close since entry (trailing stop).
- Drawdown brake: if equity falls 3% under its peak, flatten and sit
  out 240 bars; after any exit, wait 45 bars before re-entering, so a
  choppy sideways market cannot bleed the account through fees.

The bot is a pure function of the bars it has seen: no clock, no
randomness, no files, no network. Two runs on the same data give the
same orders byte for byte.
"""

import json
import sys

FAST = 30            # fast EMA length in bars
SLOW = 120           # slow EMA length in bars
BAND = 0.0005        # entry needs fast EMA at least 5 bps above slow EMA
MOM_BARS = 10        # momentum lookback in bars
MOM_MIN = 0.0010     # +0.10% over the lookback to enter
SIZE_FRAC = 0.65     # share of equity spent on an entry
TRAIL = 0.009        # trailing stop: 0.9% under the best close since entry
DD_BRAKE = 0.03      # drawdown brake: flatten at 3% under the equity peak
DD_COOLDOWN = 240    # bars sat out after the brake fires
REENTRY_WAIT = 45    # bars to wait after any exit before re-entering
BUY_SLIP_BPS = 400   # max_slippage_bps on buys
SELL_SLIP_BPS = 500  # max_slippage_bps on sells (exits must not be refused)
MIN_NOTIONAL = 1_000_000  # 1 USDC in quote units


class TrendRider:
    def __init__(self):
        self.symbol = None
        self.warmup_bars = 0
        self.bars_seen = 0
        self.closes = []
        self.ema_fast = None
        self.ema_slow = None
        self.order_count = 0
        self.peak_since_entry = None
        self.peak_equity = None
        self.cooldown = 0
        self.reentry_wait = 0
        self.was_holding = False

    def on_hello(self, msg):
        symbols = msg.get("symbols") or []
        if symbols:
            self.symbol = symbols[0]["symbol"]
        self.warmup_bars = int(msg.get("warmup_bars") or 0)

    def _ema(self, prev, value, length):
        if prev is None:
            return float(value)
        k = 2.0 / (length + 1.0)
        return prev + k * (value - prev)

    def _next_id(self):
        self.order_count += 1
        return "o%d" % self.order_count

    def on_batch(self, msg):
        account = msg.get("account") or {}
        cash = int(account.get("cash_quote_units") or 0)
        equity = int(account.get("equity_quote_units") or 0)
        qty = 0
        for pos in account.get("positions") or []:
            if pos.get("symbol") == self.symbol:
                qty = int(pos.get("qty") or 0)

        bar = None
        for b in msg.get("bars") or []:
            if b.get("symbol") == self.symbol:
                bar = b
                break

        orders = []
        if bar is not None:
            close = int(bar["c"])
            self.bars_seen += 1
            self.closes.append(close)
            self.ema_fast = self._ema(self.ema_fast, close, FAST)
            self.ema_slow = self._ema(self.ema_slow, close, SLOW)
            orders = self._decide(close, cash, equity, qty)

        return {"type": "reply", "seq": msg["seq"], "orders": orders}

    def _decide(self, close, cash, equity, qty):
        holding = qty > 0

        # Track the best close since the position appeared.
        if holding:
            if not self.was_holding or self.peak_since_entry is None:
                self.peak_since_entry = close
            elif close > self.peak_since_entry:
                self.peak_since_entry = close
        else:
            if self.was_holding:
                self.reentry_wait = REENTRY_WAIT
            self.peak_since_entry = None
        self.was_holding = holding

        # Drawdown brake bookkeeping.
        if self.peak_equity is None or equity > self.peak_equity:
            self.peak_equity = equity
        brake = (
            self.cooldown == 0
            and self.peak_equity
            and equity <= self.peak_equity * (1.0 - DD_BRAKE)
        )
        if brake:
            self.cooldown = DD_COOLDOWN
            self.peak_equity = equity
            if holding:
                return [self._sell(qty)]
            return []
        if self.cooldown > 0:
            self.cooldown -= 1
            if holding:
                return [self._sell(qty)]
            return []
        if self.reentry_wait > 0:
            self.reentry_wait -= 1

        if self.bars_seen <= max(self.warmup_bars, SLOW + 5):
            return []
        if self.ema_fast is None or self.ema_slow is None:
            return []

        if holding:
            regime_down = self.ema_fast < self.ema_slow
            trailed = (
                self.peak_since_entry is not None
                and close <= self.peak_since_entry * (1.0 - TRAIL)
            )
            if regime_down or trailed:
                return [self._sell(qty)]
            return []

        # Flat: look for an entry.
        if self.reentry_wait > 0:
            return []
        if len(self.closes) <= MOM_BARS:
            return []
        regime_up = self.ema_fast > self.ema_slow * (1.0 + BAND)
        above_fast = close > self.ema_fast
        momentum = self.closes[-1] / self.closes[-1 - MOM_BARS] - 1.0
        if regime_up and above_fast and momentum >= MOM_MIN:
            notional = int(equity * SIZE_FRAC)
            if notional > cash:
                notional = cash
            if notional >= MIN_NOTIONAL:
                return [self._buy(notional)]
        return []

    def _buy(self, notional):
        return {
            "side": "buy",
            "client_id": self._next_id(),
            "symbol": self.symbol,
            "notional_quote_units": str(notional),
            "max_slippage_bps": BUY_SLIP_BPS,
        }

    def _sell(self, qty):
        return {
            "side": "sell",
            "client_id": self._next_id(),
            "symbol": self.symbol,
            "qty": str(qty),
            "max_slippage_bps": SELL_SLIP_BPS,
        }


def main():
    bot = TrendRider()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        kind = msg.get("type")
        if kind == "hello":
            bot.on_hello(msg)
        elif kind == "batch":
            reply = bot.on_batch(msg)
            out.write(json.dumps(reply) + "\n")
            out.flush()
        elif kind == "done":
            break


if __name__ == "__main__":
    main()
