import { randomBytes, randomUUID } from "node:crypto";
import type { Account } from "viem";
import { signAgentIntent, type Hex, type OrderIntent, type SignedIntentRequest, type UUID } from "@bekci/shared";

export class IntentBuilder {
  constructor(private account: Account, private policyId: Hex, private agentId: string) {}

  async build(intent: OrderIntent, agentReason: string, referencedReadIds: UUID[]): Promise<SignedIntentRequest> {
    const unsigned = {
      requestId: randomUUID(),
      policyId: this.policyId,
      agentId: this.agentId,
      issuedAt: Math.floor(Date.now() / 1000),
      authNonce: `0x${randomBytes(16).toString("hex")}` as Hex,
      intent,
      agentReason: agentReason.slice(0, 1000),
      referencedReadIds,
    };
    return signAgentIntent(this.account, unsigned);
  }
}
