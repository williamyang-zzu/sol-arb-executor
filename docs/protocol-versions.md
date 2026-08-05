# Protocol versions

Verified on 2026-08-05. Only official protocol repositories and documentation
were used.

## PumpSwap AMM

- Program ID: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- Fee Program ID: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
- IDL: [`pump_amm.json`](https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/idl/pump_amm.json)
- Commit: `9c82f61cb711b044a17f770ab8ce9f9bdf78f333` (2026-07-16)
- IDL metadata: `pump_amm` 0.1.0, Anchor IDL spec 0.1.0
- Rust integration: no third-party crate; CPI data and accounts are encoded from
  the pinned official IDL.

The buy leg uses `buy_exact_quote_in(spendable_quote_in,
min_base_amount_out, OptionBool(false))`, discriminator
`[198,46,21,82,180,217,232,112]`. This is exact quote input. The sell leg uses
`sell(base_amount_in, min_quote_amount_out)`, discriminator
`[51,230,133,164,1,127,131,173]`, and is exact base input.

The current official interface includes protocol fee recipient accounts,
creator-vault accounts, a separate fee program/config, user/global volume
accumulators for buys, a conditional `pool_v2` PDA, buyback fee accounts, and
optional cashback remaining accounts. This MVP does not pass the optional
cashback account and sets `track_volume=false`, but all fixed accounts and the
current non-cashback remaining-account tail are present.

The July 2026 documentation also records `virtual_quote_reserves` appended to
the Pool account. The local validation parser reads the stable prefix through
`coin_creator`, which is needed to determine whether `pool_v2` is required, and
remains compatible with fields appended after that prefix.

## Meteora DLMM

- Mainnet Program ID: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
- Official repository: [`MeteoraAg/dlmm-sdk`](https://github.com/MeteoraAg/dlmm-sdk/tree/fb02e51ae677bbd18e76543f702dae40632426db)
- Commit: `fb02e51ae677bbd18e76543f702dae40632426db` (2026-07-23)
- Official npm SDK: `@meteora-ag/dlmm` 1.9.14
- IDL metadata: `lb_clmm` 0.12.0, Anchor IDL spec 0.1.0

The current SDK builds `swap2(amount_in, min_amount_out,
RemainingAccountsInfo)` even for ordinary swaps. This project follows that
implementation rather than the older `swap` instruction. The discriminator is
`[65,75,63,76,235,91,91,136]`. For legacy SPL tokens, two zero-length remaining
account slices (`TransferHookX`, `TransferHookY`) are encoded, followed only by
the writable bin-array accounts.

The IDL supports independent token X/Y programs and Token-2022 transfer hook
slices. The MVP intentionally rejects Token-2022 and fixes both token program
accounts to the legacy SPL Token program, avoiding unvalidated transfer-hook
forwarding.

## Framework compatibility

- `anchor-lang` / `anchor-spl`: exactly 0.31.1
- Anchor CLI: 0.31.1
- Rust host toolchain: 1.88.0
- Agave/Solana CLI observed locally: 2.2.21
- `@coral-xyz/anchor`: exactly 0.31.1
- `@solana/web3.js`: exactly 1.98.4
- `@solana/spl-token`: exactly 0.4.13
- Cargo resolves `solana-program` to 2.2.1 in `Cargo.lock`, aligned with the
  installed Agave 2.2.21 tool suite.

Meteora SDK 1.9.14 declares Anchor 0.31.0 and web3.js 1.x dependencies. Anchor
0.31.1 was selected instead of 0.32.x to keep the on-chain and TypeScript stack
within that supported minor line while matching the installed CLI.

The lockfile also holds older compatible releases of several transitive build
dependencies. This is required because Agave 2.2.21 platform-tools v1.48 ships
SBF Cargo/rustc 1.84, while newer transitive releases require edition 2024 or
Rust 1.85+. Do not run an unreviewed blanket `cargo update`.

## Build-tool warning and runtime verification

`anchor build` succeeds and emits the SBF, IDL, and TypeScript types, but the
installed `solana-cargo-build-sbf 2.2.21` post-link checker reports standard
Solana symbols such as `sol_log_` and `sol_invoke_signed_rust` as "undefined and
not known syscalls". The installed platform-tools reports v1.48/rustc 1.84.1.

The emitted executor and mock fixture SBF binaries were subsequently loaded by
Agave 2.2.21 `solana-test-validator`. Both route entrypoints, nested SPL Token
CPIs, and a failed-second-leg rollback executed successfully. The warning is
therefore a false positive for these exercised paths, rather than a runtime
loader failure. A clean-toolchain build remains advisable before production,
but the warning no longer blocks local integration testing.

The PumpSwap-to-Meteora direction was also executed successfully under Surfpool
1.5.0 using cloned mainnet protocol accounts. The test asserted successful
entry into both deployed protocol program IDs and final transaction success;
pool-specific addresses remain environment-only.
