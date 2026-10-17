import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUJI_DEPLOYMENT, type Deployment } from "@leashagent/chain";

/**
 * The Fuji deployment manifest to use: `LEASH_DEPLOYMENT` (path to another manifest, e.g. a separate
 * deployment with its own DecisionLog logger and demo policy) or the team's packages/chain/deployments/fuji.json.
 */
export function manifestPath(): string {
  return resolve(process.env.LEASH_DEPLOYMENT ?? "packages/chain/deployments/fuji.json");
}

export function activeDeployment(): Deployment {
  return process.env.LEASH_DEPLOYMENT ? (JSON.parse(readFileSync(manifestPath(), "utf8")) as Deployment) : FUJI_DEPLOYMENT;
}
