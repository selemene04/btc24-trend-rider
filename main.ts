// Selemene Trend Rider v2: a cbBTC bot for 1-minute bars (agent-fun/bars-replay/v1).
//
// v1 (EMA 45/120 regime, 65% sizing, 0.9% trailing stop) made $2.07 on
// the dev window with 4 trades and 18% exposure: right shape, too slow
// and too small. v2 keeps the one design that made money on that window
// and sharpens every part of it:
//
// - Regime filter, faster: the fast EMA (30 bars) must sit at least
//   5 bps above the slow EMA (90 bars), and the close above the fast
//   EMA. v1's 45/120 pair entered the dev day's big midday recovery
//   about 55 bars late; 30/90 enters materially earlier while still
//   keeping the bot in cash through the day's three hard down-legs
//   (-2.6%, -1.6%, -2.8%), where any long loses.
// - Sizing: 95% of equity (v1: 65%). A full-size round trip costs
//   roughly 26-39 bps in fees, slippage and pool impact, so the bot
//   only rides moves that are expected to be several times that, and
//   rides them near full size when they come.
// - Exit: a 0.7% trailing stop under the best close since entry (v1:
//   0.9%). The dev day's recoveries rolled over fast; the tighter stop
//   banks more of each leg. There is deliberately no regime-flip exit:
//   tested on this window, flip exits churned in the second half's
//   chop and turned the day negative. Entry also requires the last
//   10 bars to sum non-negative, which keeps the bot from buying the
//   first dead bounce inside a still-falling tape.
// - After any exit the bot waits 5 bars before re-entering, so chop at
//   a leg top cannot bleed it through repeated round-trip fees.
// - Drawdown brake: if equity falls 8% under its peak, flatten and sit
//   out 120 bars. The race ranks an entry below the whole field when
//   its max drawdown exceeds 25%; this brake keeps a bad live day far
//   from that line (the dev window's max drawdown here is ~1.3%).
//
// Faster systems were tested and rejected on the dev window: raw
// momentum entries, Donchian breakouts, EMA crosses and dip-buying all
// lost money there, because the day's up-legs reverse quickly and each
// round trip costs ~0.3%. Patient regime-riding with a tight trailing
// stop was the only family that stayed profitable across parameter
// perturbations, so v2 is that, tuned up, rather than a new gamble.
//
// The bot is a pure function of the bars it has seen: no clock, no
// randomness, no files, no network. Two runs on the same data give the
// same orders byte for byte.

import { createInterface } from "node:readline";

const FAST = 30; // fast EMA length in bars
const SLOW = 90; // slow EMA length in bars
const BAND = 0.0005; // entry needs fast EMA at least 5 bps above slow EMA
const MOM_BARS = 10; // entry also needs the last 10 bars not down in sum
const SIZE_FRAC = 0.95; // share of equity spent on an entry
const TRAIL = 0.007; // trailing stop
const DD_BRAKE = 0.08; // drawdown brake: flatten at 8% under the equity peak
const DD_COOLDOWN = 120; // bars sat out after the brake fires
const REENTRY_WAIT = 5; // bars to wait after any exit before re-entering
const BUY_SLIP_BPS = 400; // max_slippage_bps on buys
const SELL_SLIP_BPS = 500; // max_slippage_bps on sells (exits must not be refused)
const MIN_NOTIONAL = 1000000; // 1 USDC in quote units

type Order = { [key: string]: unknown };

class TrendRider {
  symbol: string | null = null;
  warmupBars = 0;
  barsSeen = 0;
  closes: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  orderCount = 0;
  peakSinceEntry: number | null = null;
  peakEquity: number | null = null;
  cooldown = 0;
  reentryWait = 0;
  wasHolding = false;

  onHello(msg: { [key: string]: unknown }): void {
    const symbols = (msg["symbols"] as { [key: string]: unknown }[]) || [];
    if (symbols.length > 0) this.symbol = String(symbols[0]["symbol"]);
    this.warmupBars = Number(msg["warmup_bars"] || 0);
  }

  ema(prev: number | null, value: number, length: number): number {
    if (prev === null) return value;
    const k = 2 / (length + 1);
    return prev + k * (value - prev);
  }

  nextId(): string {
    this.orderCount += 1;
    return "o" + this.orderCount;
  }

  buy(notional: number): Order {
    return {
      side: "buy",
      client_id: this.nextId(),
      symbol: this.symbol,
      notional_quote_units: String(Math.floor(notional)),
      max_slippage_bps: BUY_SLIP_BPS,
    };
  }

  sell(qty: number): Order {
    return {
      side: "sell",
      client_id: this.nextId(),
      symbol: this.symbol,
      qty: String(qty),
      max_slippage_bps: SELL_SLIP_BPS,
    };
  }

  onBatch(msg: { [key: string]: unknown }): { [key: string]: unknown } {
    const account = (msg["account"] as { [key: string]: unknown }) || {};
    const cash = Number(account["cash_quote_units"] || 0);
    const equity = Number(account["equity_quote_units"] || 0);
    let qty = 0;
    const positions = (account["positions"] as { [key: string]: unknown }[]) || [];
    for (const pos of positions) {
      if (pos["symbol"] === this.symbol) qty = Number(pos["qty"] || 0);
    }

    let close: number | null = null;
    const bars = (msg["bars"] as { [key: string]: unknown }[]) || [];
    for (const b of bars) {
      if (b["symbol"] === this.symbol) {
        close = Number(b["c"]);
        break;
      }
    }

    let orders: Order[] = [];
    if (close !== null) {
      this.barsSeen += 1;
      this.closes.push(close);
      this.emaFast = this.ema(this.emaFast, close, FAST);
      this.emaSlow = this.ema(this.emaSlow, close, SLOW);
      orders = this.decide(close, cash, equity, qty);
    }
    return { type: "reply", seq: msg["seq"], orders };
  }

  decide(close: number, cash: number, equity: number, qty: number): Order[] {
    const holding = qty > 0;

    // Track the best close since the position appeared.
    if (holding) {
      if (!this.wasHolding || this.peakSinceEntry === null) {
        this.peakSinceEntry = close;
      } else if (close > this.peakSinceEntry) {
        this.peakSinceEntry = close;
      }
    } else {
      if (this.wasHolding) this.reentryWait = REENTRY_WAIT;
      this.peakSinceEntry = null;
    }
    this.wasHolding = holding;

    // Drawdown brake bookkeeping.
    if (this.peakEquity === null || equity > this.peakEquity) {
      this.peakEquity = equity;
    }
    const brake =
      this.cooldown === 0 &&
      this.peakEquity !== null &&
      this.peakEquity > 0 &&
      equity <= this.peakEquity * (1 - DD_BRAKE);
    if (brake) {
      this.cooldown = DD_COOLDOWN;
      this.peakEquity = equity;
      return holding ? [this.sell(qty)] : [];
    }
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return holding ? [this.sell(qty)] : [];
    }
    if (this.reentryWait > 0) this.reentryWait -= 1;

    if (this.barsSeen <= Math.max(this.warmupBars, SLOW + 2)) return [];
    if (this.emaFast === null || this.emaSlow === null) return [];

    if (holding) {
      const trailed =
        this.peakSinceEntry !== null &&
        close <= this.peakSinceEntry * (1 - TRAIL);
      if (trailed) return [this.sell(qty)];
      return [];
    }

    // Flat: look for an entry.
    if (this.reentryWait > 0) return [];
    if (this.closes.length <= MOM_BARS) return [];
    const regimeUp = this.emaFast > this.emaSlow * (1 + BAND);
    const aboveFast = close > this.emaFast;
    const momentum =
      this.closes[this.closes.length - 1] /
        this.closes[this.closes.length - 1 - MOM_BARS] -
      1;
    if (regimeUp && aboveFast && momentum >= 0) {
      let notional = Math.floor(equity * SIZE_FRAC);
      if (notional > cash) notional = cash;
      if (notional >= MIN_NOTIONAL) return [this.buy(notional)];
    }
    return [];
  }
}

async function main(): Promise<void> {
  const bot = new TrendRider();
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = JSON.parse(trimmed) as { [key: string]: unknown };
    const kind = msg["type"];
    if (kind === "hello") {
      bot.onHello(msg);
    } else if (kind === "batch") {
      const reply = bot.onBatch(msg);
      process.stdout.write(JSON.stringify(reply) + "\n");
    } else if (kind === "done") {
      break;
    }
  }
}

void main();
