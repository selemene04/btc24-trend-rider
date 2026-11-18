// Selemene Trend Rider, second build: a cbBTC rider for one-minute
// bars on the agent-fun/bars-replay/v1 protocol.
//
// The whole idea fits in one paragraph. The bot keeps its money in
// cash while the tape is ambiguous, and commits almost all of it only
// when a real uptrend is in charge: the fast exponential average must
// sit clearly above the slow one, the latest close must hold above
// the fast average, and the last ten bars must not have lost ground
// overall. Once in, a trailing stop is the only ordinary way out —
// the position is sold when the close falls 0.7 percent (70 bps)
// under the best close seen since entry. A separate brake watches the
// account itself: if equity ever sinks eight percent below its peak,
// everything is sold and the bot parks for two hours of bars.
//
// The program is a pure function of the lines it reads. It consults
// no clock, rolls no dice, opens no files and touches no network, so
// the same input stream always earns the same orders back.

import { createInterface } from "node:readline";

// ---- strategy constants --------------------------------------------------
const FAST_LEN = 30;      // fast EMA length, in bars
const SLOW_LEN = 90;      // slow EMA length, in bars
const GAP_BPS = 5;        // fast EMA must lead the slow one by this
const LOOKBACK = 10;      // bars in the no-loss momentum check
const COMMIT_BPS = 9500;  // share of equity committed on an entry
const TRAIL_BPS = 70;     // trailing stop distance (0.7 percent)
const BRAKE_BPS = 800;    // equity drawdown that trips the brake (8%)
const PARK_BARS = 120;    // bars sat out once the brake has tripped
const REST_BARS = 5;      // bars sat out after an ordinary exit
const BUY_SLIP_BPS = 400; // slippage tolerance on entries
const SELL_SLIP_BPS = 500; // slippage tolerance on exits

// ---- the bot ---------------------------------------------------------------
class TrendRider {
  constructor() {
    this.symbol = null;        // trading symbol, learned from hello
    this.warmupBars = 0;       // harness warmup: no orders count there
    this.minNotional = 1000000n; // smallest order the venue accepts
    this.barCount = 0;         // bars of our symbol seen so far
    this.closes = [];          // recent closes, newest last, capped
    this.emaFast = null;       // EMA(FAST_LEN) of the close
    this.emaSlow = null;       // EMA(SLOW_LEN) of the close
    this.cash = 0n;            // quote units, as last reported
    this.qty = 0n;             // asset units held, as last reported
    this.qtyText = "0";        // the same quantity, as a raw string
    this.equity = 0n;          // quote units, as last reported
    this.peakEquity = 0n;      // best equity ever reported
    this.bestClose = 0;        // best close since the current entry
    this.pending = null;       // null, "buy" or "sell": order in flight
    this.exitKind = null;      // for a sell in flight: "trail"/"brake"
    this.park = 0;             // brake sit-out bars remaining
    this.rest = 0;             // post-exit rest bars remaining
    this.orderSeq = 0;         // counter for unique client ids
  }

  onHello(msg) {
    const first = (msg.symbols || [])[0] || {};
    this.symbol = String(first.symbol || "CBBTC");
    this.warmupBars = Number(msg.warmup_bars || 0);
    const fees = msg.fees || {};
    if (fees.min_notional_quote_units !== undefined) {
      this.minNotional = BigInt(fees.min_notional_quote_units);
    }
    const cap = msg.capital || {};
    if (cap.quote_units !== undefined) {
      this.cash = BigInt(cap.quote_units);
      this.equity = this.cash;
      this.peakEquity = this.cash;
    }
  }

  // Fold one batch's account report into local state.
  syncAccount(account) {
    if (!account) return;
    this.cash = BigInt(account.cash_quote_units || "0");
    this.equity = BigInt(account.equity_quote_units || "0");
    this.qty = 0n;
    this.qtyText = "0";
    for (const pos of account.positions || []) {
      if (pos.symbol === this.symbol) {
        this.qty = BigInt(pos.qty || "0");
        this.qtyText = String(pos.qty || "0");
      }
    }
    if (this.equity > this.peakEquity) this.peakEquity = this.equity;
  }

  // Update the averages and the momentum window with one close.
  absorbClose(close) {
    this.barCount += 1;
    this.closes.push(close);
    if (this.closes.length > LOOKBACK + 1) this.closes.shift();
    if (this.emaFast === null) {
      this.emaFast = close;
      this.emaSlow = close;
    } else {
      const kFast = 2 / (FAST_LEN + 1);
      const kSlow = 2 / (SLOW_LEN + 1);
      this.emaFast += (close - this.emaFast) * kFast;
      this.emaSlow += (close - this.emaSlow) * kSlow;
    }
  }

  warmedUp() {
    return this.barCount >= SLOW_LEN && this.barCount > this.warmupBars;
  }

  uptrend(close) {
    if (this.emaFast === null || this.emaSlow === null) return false;
    if (this.closes.length < LOOKBACK + 1) return false;
    const leadOk = this.emaFast >= this.emaSlow * (1 + GAP_BPS / 10000);
    const aboveOk = close > this.emaFast;
    const past = this.closes[this.closes.length - 1 - LOOKBACK];
    const momentumOk = past > 0 && close / past - 1 >= 0;
    return leadOk && aboveOk && momentumOk;
  }

  brakeTripped() {
    if (this.peakEquity <= 0n) return false;
    const floor = this.peakEquity * BigInt(10000 - BRAKE_BPS);
    return this.equity * 10000n <= floor;
  }

  makeOrder(side, extra) {
    this.orderSeq += 1;
    return Object.assign(
      { side: side, client_id: "rider-" + this.orderSeq, symbol: this.symbol },
      extra
    );
  }

  sellEverything(kind) {
    this.pending = "sell";
    this.exitKind = kind;
    return this.makeOrder("sell", {
      qty: this.qtyText,
      max_slippage_bps: SELL_SLIP_BPS,
    });
  }

  onBatch(msg) {
    const orders = [];
    // Work through every bar of our symbol, in order, then decide once.
    let close = null;
    for (const bar of msg.bars || []) {
      if (bar.symbol !== this.symbol) continue;
      close = Number(bar.c);
      this.absorbClose(close);
    }
    this.syncAccount(msg.account);
    if (close === null) return orders;

    // Settle an order that was in flight when this batch arrived: the
    // fills behind it are already reflected in the account report.
    if (this.pending === "buy") {
      if (this.qty > 0n) this.bestClose = close;
      this.pending = null;
    } else if (this.pending === "sell") {
      if (this.qty === 0n) {
        if (this.exitKind === "brake") this.park = PARK_BARS;
        else this.rest = REST_BARS;
        this.bestClose = 0;
      }
      this.pending = null;
      this.exitKind = null;
    }

    // Sit-out timers tick once per batch.
    if (this.park > 0) this.park -= 1;
    if (this.rest > 0) this.rest -= 1;

    const holding = this.qty > 0n;

    // The brake outranks everything: a deep equity drawdown flattens
    // the position and starts the long sit-out once the sale lands.
    if (!this.pending && holding && this.brakeTripped()) {
      orders.push(this.sellEverything("brake"));
      return orders;
    }

    // Ordinary exit: the trailing stop, measured on closes against
    // the best close since the entry filled.
    if (!this.pending && holding) {
      if (close > this.bestClose) this.bestClose = close;
      const stopLine = this.bestClose * (1 - TRAIL_BPS / 10000);
      if (this.bestClose > 0 && close <= stopLine) {
        orders.push(this.sellEverything("trail"));
        return orders;
      }
    }

    // Entry: flat, rested, warmed up, and a confirmed uptrend.
    if (
      !this.pending &&
      !holding &&
      this.park === 0 &&
      this.rest === 0 &&
      this.warmedUp() &&
      this.uptrend(close)
    ) {
      let notional = (this.equity * BigInt(COMMIT_BPS)) / 10000n;
      if (notional > this.cash) notional = this.cash;
      if (notional >= this.minNotional) {
        this.pending = "buy";
        orders.push(
          this.makeOrder("buy", {
            notional_quote_units: notional.toString(),
            max_slippage_bps: BUY_SLIP_BPS,
          })
        );
      }
    }
    return orders;
  }
}

// ---- wire loop ---------------------------------------------------------------
const rider = new TrendRider();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    rider.onHello(msg);
  } else if (msg.type === "batch") {
    const orders = rider.onBatch(msg);
    const reply = { type: "reply", seq: msg.seq, orders: orders };
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
  // A "done" message needs no answer; closing stdin ends the process.
});
