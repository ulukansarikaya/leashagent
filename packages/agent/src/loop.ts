import type { IntentResponse, ReadSummary, Signal } from "@leashagent/shared";
import type { CreditPurchase, LeashClient, X402Mode } from "./leashClient.js";
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
  /** Buy service credits via x402 when the gateway answers REJECTED_PAYMENT (004). Off when unset. */
  x402?: X402Mode;
};

export type TickResult = {
  signal: Signal;
  reads: ReadSummary[];
  review?: Review;
  response?: IntentResponse;
  /** Set when the tick had to buy credits first. */
  payment?: CreditPurchase;
};

/** Memory is off (§6.2): every tick starts from scratch. */
export class TradingAgent {
  constructor(
    private cfg: AgentConfig,
    private market: MarketObserver,
    private reviewer: Reviewer,
    private builder: IntentBuilder,
    private leash: LeashClient,
  ) {}

  async tick(): Promise<TickResult> {
    const view = await this.market.observe(this.cfg.instId);
    const signal = generateSignal(view, this.cfg.signal);
    if (signal.direction === "flat") return { signal, reads: [] };

    // External text reaches the agent only as ReadSummary via L1.
    const reads: ReadSummary[] = [];
    for (const q of this.cfg.readQueries) {
      try { reads.push(await this.leash.read(q.source, q.query)); } catch { /* reads are optional context */ }
    }

    const review = await this.reviewer.review({
      signal, reads, mandate: this.cfg.mandate, orderSizeBase: this.cfg.orderSizeBase,
      market: { instId: view.instId, last: view.last, bid: view.bid, ask: view.ask },
    });
    if (!review.proceed || !review.proposedIntent) return { signal, reads, review };

    const readIds = reads.map((r) => r.readId);
    let response = await this.leash.submitIntent(await this.builder.build(review.proposedIntent, review.rationale, readIds));
    if (response.status !== "REJECTED_PAYMENT" || !this.cfg.x402) return { signal, reads, review, response };

    // No service credit (402 / reason 004): pay once, then send a NEW signed intent (a retry of the same
    // requestId would only read back the rejected state).
    const payment = await this.leash.buyCredits(this.builder.agentId, this.cfg.x402);
    if (payment.ok) response = await this.leash.submitIntent(await this.builder.build(review.proposedIntent, review.rationale, readIds));
    return { signal, reads, review, response, payment };
  }
}
