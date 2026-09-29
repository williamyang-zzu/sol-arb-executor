# Dynamic amount implementation update

Date: 2026-09-22

## Scope

This update adds a bounded dynamic amount-selection instruction while preserving
all existing fixed-amount entrypoints and their serialized ABI.

Implemented components:

- new `execute_best_direction_dynamic` Anchor instruction and IDL entry;
- integer-only per-direction piecewise DLMM curve construction;
- amount-cap-aware traversal that stops after the searchable range has complete
  coverage and uses a fixed-capacity, stack-backed curve in a separate SBF call
  frame for each direction;
- candidate generation at range endpoints, Bin boundaries, and analytic
  within-segment estimates;
- conservative closed-form Pump inversion for forward segment boundaries,
  followed by one exact production quote validation instead of a per-boundary
  binary search; the single coverage-cap binary search remains;
- complete-coverage fallback when the requested maximum is too large;
- strict rejection of per-direction coverage below the configured minimum;
- balance-capped maximum input;
- production quote revalidation and deterministic tie-breaking;
- reuse of existing Pump/Meteora execution and post-trade safety checks;
- `DynamicAmountSelected` event for selected amount/direction and bounded-search
  diagnostics, including whether a future proof-safe early stop was used (V1
  always reports `false` and completes the bounded traversal);
- instruction serialization, unit, TypeScript, and isolated integration tests.

When neither direction can completely quote the configured minimum, the
instruction retains the existing `BestDirectionQuoteIncomplete` ABI error and
emits one compact diagnostic line. Its numeric stop codes are:

```text
0 = configured directional input limit reached
1 = required runtime BinArray account missing
2 = per-direction BinArray traversal limit reached
3 = visited-Bin traversal limit reached
4 = no usable liquidity segment observed
```

The diagnostic is emitted only on the final failure path. It does not add a
per-Bin production log or move quote authority off-chain.

The failure classification was subsequently tightened: when neither direction
is profitable, `NoProfitableDirection` now requires both directions to have
completed the exact configured minimum quote. If either minimum quote is
incomplete, the result is `BestDirectionQuoteIncomplete` even when the other
direction completed but was unprofitable. A profitable complete direction is
still allowed to execute when the opposite direction is incomplete.

## Compatibility

The account layout is unchanged. Existing instruction discriminators and fixed
argument layouts are unchanged. Dynamic mode is opt-in and restricted to
on-chain best-direction selection.

The caller still supplies a direction-neutral BinArray superset. The Program
selects only the ordered subset required by the chosen current-state quote.
The existing per-direction limits of two BinArrays and 16 visited bins remain.

## Verification boundary

Local unit, ABI-construction, build, lint, and TypeScript results are recorded in
the change handoff. The hash-pinned repository-owned Searcher-to-Executor
Surfpool harness selected bounded amounts and completed the A13 Token-2022
fixture at 281,858 CU (Pump to Meteora) and 250,867 CU (Meteora to Pump), below
the 300,000-CU acceptance target. A denser DD3A pressure fixture improved to
575,138/366,230 CU but still exceeded the reviewed 350,000-CU ceiling. Dynamic
sizing therefore retains an open multi-pool CU release gate. No entry in this
document asserts a mainnet deployment or profitable production result.

The fixed/dynamic minimum parity harness uses three non-committing simulations
against one immutable Surfpool bank state: fixed `0.005 SOL`, dynamic
`min=max=0.005 SOL`, and dynamic `0.005..0.02 SOL`. On the controlled A13 route,
the fixed and exact-dynamic variants selected the same direction and produced
identical realized profit in both directions. The ranged dynamic variant kept
the minimum candidate eligible and all variants remained below `300,000 CU`.

## Staged-search update

The production dynamic path now performs exact minimum-amount probes in both
directions before expanding the bounded search. Only a direction whose minimum
quote has positive gross WSOL spread is searched through the configured maximum.
This is an on-chain execution-time decision; Searcher still does not quote or
choose the direction or amount.

Minimum probes evaluate one exact amount without generating boundary/interior
candidates. Full searches retain all previous candidate and safety semantics.
Multi-segment candidate lookup is bounded binary search, and analytic interior
roots use a conservative squared interval prefilter so roots that are clearly
outside a segment do not pay for an integer square root. Near a segment boundary
the original root and exact candidate quote are still used.

Real-protocol Surfpool regression after this update measured the established
A13 forward/reverse paths at 258,926/221,307 CU under 300,000. A denser route
measured 321,796/281,947 CU under 350,000. The test CU limit is configurable via
`SURFPOOL_COMPUTE_UNIT_LIMIT`; its default remains 300,000.
