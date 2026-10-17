import type { ExecStatus } from "./types.js";

/**
 * Allowed execution status transitions — mirrors DecisionLog.isExecTransitionAllowed.
 * `null` = no event logged yet. Terminal: filled, cancelled, rejected_by_okx, expired, revoked.
 * L6 should check this before emitting an ExecutionEvent so the chain write cannot revert.
 */
export const EXEC_TRANSITIONS: Record<"none" | ExecStatus, readonly ExecStatus[]> = {
  none: ["submitted", "acknowledged", "rejected_by_okx", "unknown", "expired", "revoked"],
  submitted: ["acknowledged", "filled", "partially_filled", "cancelled", "rejected_by_okx", "unknown"],
  unknown: ["acknowledged", "filled", "partially_filled", "cancelled", "rejected_by_okx"],
  acknowledged: ["filled", "partially_filled", "cancelled"],
  partially_filled: ["partially_filled", "filled", "cancelled"],
  filled: [],
  cancelled: [],
  rejected_by_okx: [],
  expired: [],
  revoked: [],
};

export function isExecTransitionAllowed(prev: ExecStatus | null, next: ExecStatus): boolean {
  return EXEC_TRANSITIONS[prev ?? "none"].includes(next);
}
