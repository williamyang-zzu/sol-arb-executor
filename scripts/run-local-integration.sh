#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

rpc_port="${INTEGRATION_RPC_PORT:-18899}"
rpc_url="http://127.0.0.1:${rpc_port}"
mock_so="target/test-programs/mock_dex.so"
executor_so="target/deploy/sol_arb_executor.so"
ledger_dir="target/integration-ledger"
validator_log="target/integration-validator.log"

anchor build
cargo build-sbf --manifest-path test-programs/mock-dex/Cargo.toml --sbf-out-dir target/test-programs

solana-test-validator \
  --reset \
  --quiet \
  --ledger "$ledger_dir" \
  --rpc-port "$rpc_port" \
  --bpf-program RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51 "$executor_so" \
  --bpf-program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA "$mock_so" \
  --bpf-program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ "$mock_so" \
  --bpf-program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo "$mock_so" \
  --bpf-program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr "$mock_so" \
  >"$validator_log" 2>&1 &
validator_pid=$!

cleanup() {
  kill "$validator_pid" 2>/dev/null || true
  wait "$validator_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if solana cluster-version --url "$rpc_url" >/dev/null 2>&1; then
    INTEGRATION_RPC_URL="$rpc_url" npm run test:integration:client
    exit $?
  fi
  sleep 1
done

echo "local validator did not become ready; see $validator_log" >&2
exit 1
