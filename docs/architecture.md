# Architecture

`sol-arb-executor` is an Anchor-based on-chain executor. It exposes fixed
instruction entrypoints, validates all route accounts, invokes supported
protocols through dedicated CPI adapters, checks resulting account state, and
emits execution lifecycle events.

## Internal layers

1. `lib.rs` exposes explicit fixed-amount and bounded dynamic-amount Anchor
   instruction entrypoints.
2. `instructions/` defines account contexts and coordinates instruction
   execution.
3. `adapters/` isolates protocol account layouts, validation, instruction
   encoding, and CPI invocation.
4. `utils/` contains reusable foreign-account parsing, relationship checks, and
   checked balance arithmetic.
5. `events.rs` and `errors.rs` provide a stable observability and error surface.

All protocol invocations belonging to an instruction execute atomically. A
validation error, state-check error, or failed CPI aborts the instruction and
rolls back its state changes.

## Amount-selection boundary

The original fixed-direction and fixed-amount best-direction instructions are
preserved unchanged. `execute_best_direction_dynamic` is a separate ABI entry
that accepts a minimum and maximum WSOL input. It is the only instruction that
searches an amount range.

The dynamic path parses each market once, walks the same bounded Meteora quote
window used by the production best-direction path, and records a piecewise
integer curve. It evaluates liquidity boundaries plus one analytic interior
estimate and adjacent integer points per segment. Every candidate is re-quoted
with the production Pump and Meteora arithmetic before it can be selected.
Selection maximizes absolute gross WSOL profit, not ROI; equal-profit choices
prefer the smaller input and then the existing forward-direction tie-break.
Curve construction stops once cumulative liquidity covers the maximum amount
reachable in that direction, so later supplied bins cannot consume CU when no
eligible candidate can reach them. Each direction uses a fixed-capacity,
stack-backed curve in its own SBF call frame, preserving the full bounded search
without retaining quote scratch data on the non-reclaiming SBF heap.

The caller's maximum is first capped by the user's WSOL token-account balance.
Each direction then has a separate largest amount that can be quoted completely
inside the supplied BinArray coverage. An incomplete large amount never
invalidates a smaller complete candidate. Once selected, the existing CPI and
post-trade path remains authoritative for second-leg minimum output, final WSOL
profit, and restoration of the target-token balance.

This design deliberately does not add a general-purpose optimizer, floating
point arithmetic, persistent state, or unbounded account traversal. The
production quote cap remains two BinArrays and 16 visited bins per direction;
the direction-neutral client may provide at most four unique BinArrays.

## Extension model

A supported protocol should have its own adapter with a fixed program ID and
explicit account validation. New execution paths should be exposed as explicit
Anchor instructions instead of accepting arbitrary CPI targets. Shared
post-execution invariants belong in `instructions/post_trade_checks.rs`.
