#!/usr/bin/env bash
set -euo pipefail

PROBE_OUT_DIR="target/quote-probe"
PROBE_LEDGER_DIR="/private/tmp/sol-arb-quote-probe-ledger"
PROBE_RPC_PORT="18900"
PROBE_FAUCET_PORT="18999"
PROBE_ACCOUNT_DIR="target/quote-probe-accounts"

cargo build-sbf \
  --manifest-path test-programs/quote-probe/Cargo.toml \
  --sbf-out-dir "$PROBE_OUT_DIR"

PROBE_PROGRAM_ID="$(solana-keygen pubkey "$PROBE_OUT_DIR/quote_probe-keypair.json")"
npx ts-node scripts/prepare-quote-probe-fixture.ts

VALIDATOR_ACCOUNT_ARGS=()
for account_file in "$PROBE_ACCOUNT_DIR"/*.json; do
  account_address="$(basename "$account_file" .json)"
  VALIDATOR_ACCOUNT_ARGS+=(--account "$account_address" "$account_file")
done

solana-test-validator \
  --quiet \
  --reset \
  --ledger "$PROBE_LEDGER_DIR" \
  --rpc-port "$PROBE_RPC_PORT" \
  --faucet-port "$PROBE_FAUCET_PORT" \
  "${VALIDATOR_ACCOUNT_ARGS[@]}" \
  --bpf-program "$PROBE_PROGRAM_ID" "$PROBE_OUT_DIR/quote_probe.so" &
VALIDATOR_PID=$!

cleanup() {
  kill "$VALIDATOR_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if solana cluster-version --url "http://127.0.0.1:$PROBE_RPC_PORT" >/dev/null 2>&1; then
    QUOTE_PROBE_RPC_URL="http://127.0.0.1:$PROBE_RPC_PORT" \
      QUOTE_PROBE_PROGRAM_ID="$PROBE_PROGRAM_ID" \
      npx ts-node scripts/measure-quote-probe-cu.ts
    exit 0
  fi
  sleep 1
done

echo "quote-probe validator did not become ready" >&2
exit 1
