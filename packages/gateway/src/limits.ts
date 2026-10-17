import { ReasonCodes } from "@leashagent/shared";

/** Gateway-local request limits (§6.3 step 1, §6.3 step 4). */
export const LIMITS = {
  maxRequestBytes: 16 * 1024,
  clockSkewSec: 60,
} as const;

/** Sell exceeding fresh available base inventory (§6.4 → REJECTED_POLICY). Now in shared `ReasonCodes` (108). */
export const SELL_INVENTORY_REASON = ReasonCodes.SELL_INVENTORY;
