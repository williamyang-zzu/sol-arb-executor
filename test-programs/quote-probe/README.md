# Quote Probe (feasibility only)

This isolated SBF program measures the compute cost and rounding parity of a
possible on-chain quote engine. It is not part of the production Anchor
workspace and is never deployed by `anchor build`.

Validated scope:

- Pump exact-quote-in constant-product math with LP, protocol, and creator fee
  rounding.
- Meteora exact-in per-bin math in both directions.
- Meteora input-side/output-side fee handling and dynamic fee-rate math.
- Meteora default bitmap lookup and processed/open limit-order liquidity.
- Bounded multi-bin traversal up to 140 synthetic bins for CU measurement.
- Raw Pump Pool/GlobalConfig/FeeConfig/vault/mint and Meteora LbPair/BinArray
  parsing against one frozen public mainnet snapshot.
- Full quote replay in both directions against the pinned official SDK output.

Not yet implemented:

- Production owner/discriminator/PDA validation and Pump-pool classification
  across all probe entrypoints.
- A bitmap-extension CU scenario outside the default 1024-array bitmap.
- Token-2022 transfer-fee or transfer-hook extensions.
- A real snapshot that crosses a BinArray boundary; multi-bin traversal is
  currently covered with deterministic SDK vectors and synthetic CU samples.
- CPI execution or changes to the production program instructions/IDL.

Run parity tests with `npm run test:quote-parity`. Run the isolated local SBF
measurement with `npm run test:quote-cu`.

## Amount-search experiment

This program is a local feasibility harness, not a production executor upgrade.
`quote.rs` and `snapshot_accounts.rs` import the production arithmetic and parsers
by path. Opcode 4 parses one market snapshot once, quotes both directions for each
explicit input, and chooses the greatest positive absolute output-minus-input.
Incomplete quotes are excluded independently; a larger failed quote does not
discard an earlier complete result. Ties keep the first input/direction.

## Reproduce the amount-search experiment

From the repository root:

```sh
npm run test:amount-search
```

The runner builds the standalone SBF artifact, starts offline Surfpool with a
local ephemeral payer, injects the checked-in public account fixture, and calls
`simulateTransaction`. It never loads `.env`, wallet files, or a remote RPC.
It stops Surfpool on completion/failure. Production source, ABI, and deployment
artifacts under `target/deploy` are not changed.

The generated `target/amount-search/surfpool-report.json` contains fixture/program
hashes, input/output/profit curves, explicit incomplete results, consumed SBF CU,
probe transaction size, and median local simulation latency over three repeats.

The original snapshot is tested unchanged against its expected round-trip outputs.
Controlled scenarios scale Pump reserves down and shift the effective reserve
ratio to create profitable directions. Additional scenarios remove DLMM liquidity
or leave only a limited active bin. These are **constructed experiments**, not
historical successful trades, SDK parity proofs for modified pools, or live profit
predictions. The controlled scenarios reselect the fee tier from their modified
reserves. Candidate amounts are experimental inputs, not production defaults.

## Interpretation limits

- Best means best among the explicit trials, not a global optimum.
- Amounts and profits use integer units; the minimum chosen positive profit is
  one lamport in this probe, not a production risk setting.
- Production limits remain two arrays and sixteen visited bins per direction.
  This fixture has one BinArray; extension bitmap and full multi-array CU are not
  covered. Missing coverage and insufficient liquidity share the production
  `InsufficientLiquidity` result; it must not be interpreted as zero profit.
- The probe uses the production parsed-snapshot quote helper. The live executor
  quotes raw AccountInfo data and has additional validation/CPI paths. Therefore
  CU deltas are evidence for search cost, not proof of a complete transaction
  fitting a given CU limit. Diagnostic logs are included in the measurement.
- No DEX CPI, wallet balance mutation, cashback readiness validation, ATA setup,
  or actual final-profit check occurs. This is not execution acceptance.
- Local simulation milliseconds exclude remote data ingestion, transport, and
  leader scheduling; they do not predict mainnet landing latency.

## Historical data readiness

For an already stopped Monitor database, optionally run:

```sh
npx ts-node scripts/audit-amount-search-history.ts /path/to/stopped-monitor.sqlite3
```

This reads the database in immutable mode and writes a local, git-ignored audit
under `target/amount-search`. Do not use immutable mode on a running database with
uncheckpointed WAL. Monitor outcome metadata is insufficient to replay account
state at a historical transaction boundary.

An exact historical counterfactual needs account bytes before the specific
transaction index, all relevant arrays/bitmap, fee configuration, Clock, and
protocol/program versions. A capture before broadcast is only a pre-broadcast
snapshot; a slot-end snapshot is not the state before each transaction in that
slot. If exact historical state is unavailable, use clearly timestamped new
snapshots for forward experiments instead of substituting current state.

Before production design, measure bounded search with reusable traversal work,
including incomplete/no-profit cases, then validate complete DEX execution and
profit rollback. A naive repeated full quote is deliberately only a baseline.
