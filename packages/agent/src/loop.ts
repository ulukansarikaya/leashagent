import type { IntentResponse, ReadSummary, Signal } from "@bekci/shared";
import type { BekciClient } from "./bekciClient.js";
import type { IntentBuilder } from "./intentBuilder.js";
import type { MarketObserver } from "./market.js";
import type { Review, Reviewer } from "./reviewer.js";
import { generateSignal, type SignalParams } from "./signal.js";

export type AgentConfig = {
  instId: string;
  mandate: string;
  orderSizeBase: string;
  readQueries: { source: "news" | "web" | "social"; query: string }[];
  signal?: SignalParams;
};

export type TickResult = {
  signal: Signal;
  reads: ReadSummary[];
  review?: Review;
  response?: IntentResponse;
};

/** Memory is off (§6.2): every tick starts from scratch. */
export class TradingAgent {
  constructor(
    private cfg: AgentConfig,
    private market: MarketObserver,
    private reviewer: Reviewer,
    private builder: IntentBuilder,
    private bekci: BekciClient,
  ) {}

  async tick(): Promise<TickResult> {
    const view = await this.market.observe(this.cfg.instId);
    const signal = generateSignal(view, this.cfg.signal);
    if (signal.direction === "flat") return { signal, reads: [] };

    // External text reaches the agent only as ReadSummary via L1.
    const reads: ReadSummary[] = [];
    for (const q of this.cfg.readQueries) {
      try { reads.push(await this.bekci.read(q.source, q.query)); } catch { /* reads are optional context */ }
    }

    const review = await this.reviewer.review({
      signal, reads, mandate: this.cfg.mandate, orderSizeBase: this.cfg.orderSizeBase,
      market: { instId: view.instId, last: view.last, bid: view.bid, ask: view.ask },
    });
    if (!review.proceed || !review.proposedIntent) return { signal, reads, review };

    const req = await this.builder.build(review.proposedIntent, review.rationale, reads.map((r) => r.readId));
    const response = await this.bekci.submitIntent(req);
    return { signal, reads, review, response };
  }
}
