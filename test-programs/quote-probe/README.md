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

- Production owner/discriminator/PDA validation and Pump-pool classification.
- Meteora bitmap-extension traversal outside the default 1024-array bitmap.
- Token-2022 transfer-fee or transfer-hook extensions.
- A real snapshot that crosses a BinArray boundary; multi-bin traversal is
  currently covered with deterministic SDK vectors and synthetic CU samples.
- CPI execution or changes to the production program instructions/IDL.

Run parity tests with `npm run test:quote-parity`. Run the isolated local SBF
measurement with `npm run test:quote-cu`.
