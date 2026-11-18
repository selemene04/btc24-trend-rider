// Selemene Trend Rider: a cbBTC bot for 1-minute bars (agent-fun/bars-replay/v1).
//
// The dev window this entry was tuned against is a downtrend day: BTC bled
// about 3% with one strong midday recovery. A bot that simply holds loses
// money there and fails the dev gate, so this bot only holds risk while the
// market is actually trending up:
//
// - Regime filter: the fast EMA (30 bars) must sit above the slow EMA
//   (120 bars). Below that, the bot holds cash and waits.
// - Entry: in an uptrend regime, with the close above the fast EMA and the
//   last 10 bars up at least 0.10%, buy with 65% of equity. Part-sizing
//   keeps the pool impact of a round trip near 25 bps, so a trend leg of a
//   few tenths of a percent already clears the costs.
// - Exit: the regime flips down (fast EMA back under the slow EMA), or the
//   close falls 0.9% under the best close since entry (trailing stop).
// - Drawdown brake: if equity falls 3% under its peak, flatten and sit
//   out 240 bars; after any exit, wait 45 bars before re-entering, so a
//   choppy sideways market cannot bleed the account through fees.
//
// The bot is a pure function of the bars it has seen: no clock, no
// randomness, no files, no network. Two runs on the same data give the
// same orders byte for byte.

import { createInterface } from "node:readline";

const FAST = 45; // fast EMA length in bars
const SLOW = 180; // slow EMA length in bars
const BAND = 0.0005; // entry needs fast EMA at least 5 bps above slow EMA
const MOM_BARS = 10; // momentum lookback in bars
const MOM_MIN = 0.001; // momentum threshold
const SIZE_FRAC = 0.65; // share of equity spent on an entry
const TRAIL = 0.009; // trailing stop
const DD_BRAKE = 0.03; // drawdown brake: flatten at 3% under the equity peak
const DD_COOLDOWN = 240; // bars sat out after the brake fires
const REENTRY_WAIT = 45; // bars to wait after any exit before re-entering
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

    if (this.barsSeen <= Math.max(this.warmupBars, SLOW + 5)) return [];
    if (this.emaFast === null || this.emaSlow === null) return [];

    if (holding) {
      const regimeDown = this.emaFast < this.emaSlow;
      const trailed =
        this.peakSinceEntry !== null &&
        close <= this.peakSinceEntry * (1 - TRAIL);
      if (regimeDown || trailed) return [this.sell(qty)];
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
    if (regimeUp && aboveFast && momentum >= MOM_MIN) {
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
