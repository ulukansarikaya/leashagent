import { randomUUID } from "node:crypto";
import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { signAgentIntent, type Hex, type OrderIntent, type SignedIntentRequest } from "@bekci/shared";

/** Mock of Person 2's IntentBuilder: produces EIP-712 signed intent requests. */
export class MockAgent {
  readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex = generatePrivateKey()) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Hex {
    return this.account.address;
  }

  async sign(
    base: { policyId: Hex; agentId: string; intent: OrderIntent | Record<string, unknown> },
    opts: Partial<Omit<SignedIntentRequest, "agentSignature" | "intent">> = {},
  ): Promise<SignedIntentRequest> {
    const unsigned = {
      requestId: randomUUID(),
      issuedAt: Math.floor(Date.now() / 1000),
      authNonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      agentReason: "sma_spread positive; volume filter passed",
      referencedReadIds: [],
      ...opts,
      policyId: base.policyId,
      agentId: base.agentId,
      intent: base.intent as OrderIntent,
    };
    return { ...unsigned, agentSignature: await signAgentIntent(this.account, unsigned) };
  }
}

export const limitBuy = (o: Partial<OrderIntent> = {}): OrderIntent => ({
  tool: "spot_place_order",
  instId: "BTC-USDT",
  side: "buy",
  ordType: "limit",
  sz: "0.001",
  px: "60000",
  ...o,
});
