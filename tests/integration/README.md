# Integration tests

Run `npm run test:integration` to build the executor and mock DEX SBF programs,
start an isolated local validator, and execute both route instructions through
real CPI boundaries. The deterministic suite verifies both success directions,
inner program invocations, token balances, compute-unit reporting, and atomic
rollback when the second CPI fails.

The fixture programs model only the token movement and failure behavior needed
to test this executor. They do not prove compatibility with a particular live
PumpSwap or Meteora deployment. The two simulation scripts under `scripts/`
remain the opt-in live-account compatibility smoke tests and never broadcast
unless `SEND_REAL_TRANSACTION=true`.
