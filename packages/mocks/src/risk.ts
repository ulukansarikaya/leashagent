import type { Dec, EpochSec, Hex, InstrumentInfo } from "@bekci/shared";
import { BTC_USDT } from "./instruments";

// Structurally matches @bekci/gateway AccountState / RiskProvider / MarketDataProvider.
// Defined here without importing gateway so mocks stay dependency-free.

export type MockAccountState = {
  fetchedAt: EpochSec;
  dailyPnlUsdt: Dec;
  openNotionalUsdt: Dec;
  pendingOrdersNotionalUsdt: Dec;
  baseBalances: Record<string, Dec>;
  lockedBySellOrders: Record<string, Dec>;
};

/** Stand-in for the OKX read-key account queries. Mutate `state` from tests. */
export class MockRiskProvider {
  state: Omit<MockAccountState, "fetchedAt">;
  failing = false;
  /** Optional artificial latency (ms) to interleave concurrent callers in race tests. */
  latencyMs: () => number = () => 0;

  constructor(private readonly clock: () => EpochSec, init: Partial<Omit<MockAccountState, "fetchedAt">> = {}) {
    this.state = {
      dailyPnlUsdt: "0",
      openNotionalUsdt: "0",
      pendingOrdersNotionalUsdt: "0",
      baseBalances: { BTC: "0", USDT: "10000" },
      lockedBySellOrders: {},
      ...init,
    };
  }

  /** Age the returned data by this many seconds (stale-data tests). */
  staleBySec = 0;

  async getAccountState(_policyId: Hex): Promise<MockAccountState> {
    const ms = this.latencyMs();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (this.failing) throw new Error("okx read unavailable");
    return {
      ...this.state,
      baseBalances: { ...this.state.baseBalances },
      lockedBySellOrders: { ...this.state.lockedBySellOrders },
      fetchedAt: this.clock() - this.staleBySec,
    };
  }
}

/** Stand-in for the OKX read-key "is this my open order?" query. */
export class MockOrderOwnership {
  readonly open = new Set<string>();
  failing = false;
  staleBySec = 0;

  constructor(private readonly clock: () => EpochSec) {}

  async isOwnOpenOrder(_policyId: Hex, instId: string, ref: { ordId?: string; clOrdId?: string }) {
    if (this.failing) throw new Error("okx read unavailable");
    const key = `${instId}:${ref.ordId ?? ref.clOrdId}`;
    return { open: this.open.has(key), fetchedAt: this.clock() - this.staleBySec };
  }
}

/** Stand-in for ATK `market` (ticker + instruments). */
export class MockMarketData {
  failing = false;
  staleBySec = 0;
  quotes = new Map<string, { bid: Dec; ask: Dec; last: Dec }>([["BTC-USDT", { bid: "59990", ask: "60010", last: "60000" }]]);
  private readonly instruments: Map<string, InstrumentInfo>;

  constructor(private readonly clock: () => EpochSec, list: InstrumentInfo[] = [BTC_USDT]) {
    this.instruments = new Map(list.map((i) => [i.instId, i]));
  }

  async getInstrument(instId: string): Promise<InstrumentInfo | null> {
    if (this.failing) throw new Error("market data unavailable");
    return this.instruments.get(instId) ?? null;
  }

  async getTicker(instId: string) {
    if (this.failing) throw new Error("market data unavailable");
    const q = this.quotes.get(instId);
    if (!q) throw new Error(`no ticker for ${instId}`);
    return { instId, ...q, ts: this.clock() - this.staleBySec };
  }
}
