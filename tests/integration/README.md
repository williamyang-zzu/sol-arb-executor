# Integration tests

Run `npm run test:integration` to build the executor and mock DEX SBF programs,
start an isolated local validator, and execute both route instructions through
real CPI boundaries. The deterministic suite verifies both success directions,
inner program invocations, token balances, compute-unit reporting, and atomic
rollback when the second CPI fails.

The fixture programs model only the token movement and failure behavior needed
to test this executor. Real deployed-program compatibility is covered separately
with Surfpool, which lazily clones the supplied mainnet accounts into an isolated
surfnet and deploys the local executor SBF there:

```bash
SURFPOOL_PUMP_POOL=<pump-pool> \
SURFPOOL_PUMP_GLOBAL_CONFIG=<pump-global-config> \
SURFPOOL_METEORA_POOL=<meteora-lb-pair> \
SURFPOOL_TARGET_MINT=<optional-explicit-mint> \
npm run test:surfpool-real
```

Use a PumpSwap/WSOL and Meteora/WSOL pair whose target mint is owned by the
legacy SPL Token program. The test derives protocol PDAs and token accounts from
the cloned state, creates a v0 transaction with an ALT, and asserts that both
real protocol program IDs appear in inner CPI logs. Pool-specific addresses are
intentionally supplied only through environment variables and are not committed.
`SURFPOOL_MAINNET_RPC_URL` can override the default public mainnet endpoint.
