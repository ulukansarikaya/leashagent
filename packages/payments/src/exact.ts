import { getAddress, toHex, type Account } from "viem";
import type { Hex } from "@bekci/shared";
import type { PaymentPayload, PaymentRequirements } from "./x402.js";

// x402 v1 "exact" scheme on EVM = EIP-3009 transferWithAuthorization, signed by the payer, settled by the facilitator.

/** Circle USDC on Avalanche Fuji (EIP-3009, name "USD Coin", version "2", 6 decimals) — verified on-chain. */
export const FUJI_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65" as const;

/** PayAI facilitator — lists `avalanche-fuji` (x402 v1, exact) in GET /supported. */
export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";

export function fujiUsdcRequirements(opts: {
  payTo: Hex;
  /** Price in USDC atomic units (6 decimals): "100000" = 0.10 USDC. */
  maxAmountRequired: string;
  resource: string;
  description?: string;
}): PaymentRequirements {
  if (!/^[1-9]\d*$/.test(opts.maxAmountRequired)) throw new Error("maxAmountRequired must be a positive integer string");
  return {
    scheme: "exact",
    network: "avalanche-fuji",
    maxAmountRequired: opts.maxAmountRequired,
    resource: opts.resource,
    description: opts.description ?? "Bekci: 5 risk-increasing intent checks",
    mimeType: "application/json",
    payTo: getAddress(opts.payTo),
    maxTimeoutSeconds: 120,
    asset: FUJI_USDC,
    extra: { name: "USD Coin", version: "2" },
  };
}

const CHAIN_IDS: Record<string, number> = { "avalanche-fuji": 43113, avalanche: 43114 };

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Agent side: sign an x402 exact payment for `req` (pays exactly maxAmountRequired). */
export async function createExactPayment(
  account: Account,
  req: PaymentRequirements,
  opts: { now?: number; nonce?: Hex } = {},
): Promise<PaymentPayload> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  const chainId = CHAIN_IDS[req.network];
  if (!chainId) throw new Error(`unsupported network ${req.network}`);
  const extra = (req.extra ?? {}) as { name?: string; version?: string };
  if (!extra.name || !extra.version) throw new Error("requirements.extra must carry the token EIP-712 name/version");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const authorization = {
    from: getAddress(account.address),
    to: getAddress(req.payTo),
    value: req.maxAmountRequired,
    validAfter: String(now - 60),
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce: opts.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: { name: extra.name, version: extra.version, chainId, verifyingContract: getAddress(req.asset) },
    types: TRANSFER_WITH_AUTHORIZATION,
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as Hex,
    },
  });
  return { x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } };
}
