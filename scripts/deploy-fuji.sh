#!/usr/bin/env bash
# One-shot Fuji deploy: funds the logger, deploys PolicyRegistry + DecisionLog, writes addresses into .env.
# Reads keys from .env (gitignored). Never prints private keys.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
CAST=~/.foundry/bin/cast; FORGE=~/.foundry/bin/forge
RPC="${CHAIN_RPC_URL}"

bal=$($CAST balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
[ "$bal" -gt 100000000000000000 ] || { echo "Deployer $DEPLOYER_ADDRESS needs >= 0.1 Fuji AVAX (has $($CAST from-wei "$bal"))"; exit 1; }

lbal=$($CAST balance "$LOGGER_ADDRESS" --rpc-url "$RPC")
if [ "$lbal" -lt 50000000000000000 ]; then
  echo "Funding logger $LOGGER_ADDRESS with 0.1 AVAX…"
  $CAST send "$LOGGER_ADDRESS" --value 0.1ether --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
fi

cd packages/chain
out=$(DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" LOGGER_ADDRESS="$LOGGER_ADDRESS" \
  $FORGE script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1) || { echo "$out" | tail -20; exit 1; }
reg=$(echo "$out" | awk '/POLICY_REGISTRY_ADDRESS/ {print $2}' | tail -1)
log=$(echo "$out" | awk '/DECISION_LOG_ADDRESS/ {print $2}' | tail -1)
cd ../..
sed -i '' "s|^POLICY_REGISTRY_ADDRESS=.*|POLICY_REGISTRY_ADDRESS=$reg|; s|^DECISION_LOG_ADDRESS=.*|DECISION_LOG_ADDRESS=$log|" .env
echo "PolicyRegistry: $reg"
echo "DecisionLog:    $log"
echo "Logger enabled: $($CAST call "$log" 'isLogger(address)(bool)' "$LOGGER_ADDRESS" --rpc-url "$RPC")"
