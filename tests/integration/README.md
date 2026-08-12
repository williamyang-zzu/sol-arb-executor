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
SURFPOOL_PUMP_GLOBAL_CONFIG=<optional-pump-global-config-override> \
SURFPOOL_METEORA_POOL=<meteora-lb-pair> \
SURFPOOL_TARGET_MINT=<optional-explicit-mint> \
npm run test:surfpool-real
```

To run only the four controlled successful routes with the same `300,000 CU`
limit and `300 micro-lamports/CU` price used by the mainnet smoke sender:

```bash
npm run test:surfpool-cu-budget
```

Use a PumpSwap/WSOL and Meteora/WSOL pair whose target mint is either owned by
the legacy SPL Token program or is a supported basic Token-2022 mint. The tests
read the mint owner, derive/fund the ATA with the matching token program, create
v0 transactions with ALTs, and execute both route directions. Each direction
asserts that both real protocol program IDs appear in inner CPI logs.
Pool-specific addresses are intentionally supplied only through environment
variables and are not committed.
The Pump global config defaults to the official SDK PDA; the override is kept
only for compatibility testing.
`SURFPOOL_MAINNET_RPC_URL` can override the default public mainnet endpoint.

## Historical mainnet milestone evidence

Surfpool lazily clones the current value of every remote account it encounters.
`timeTravelToSlot` changes the local clock but does not restore historical pool
account data, so a past profitable pool state must not be represented as a
Surfpool historical replay.

The three successful mainnet executions and one profit-condition rollback are
instead pinned as transaction-evidence fixtures. The regression verifies their
slot, executor invocation, status, compute units, fee, trader WSOL delta, and
atomic restoration of the trader's non-WSOL token balances:

```bash
MAINNET_ARCHIVE_RPC_URL=<historical-rpc-url> \
npm run test:mainnet-milestones
```

`SURFPOOL_MAINNET_RPC_URL` or `RPC_URL` is used as a fallback. The selected RPC
must retain `getTransaction` history for the pinned slots. This evidence suite
does not execute a new trade; the Surfpool suite above remains responsible for
executing the locally built Program against real protocol accounts at their
current remote state.
