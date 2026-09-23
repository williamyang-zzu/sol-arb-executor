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
- complete-coverage fallback when the requested maximum is too large;
- balance-capped maximum input;
- production quote revalidation and deterministic tie-breaking;
- reuse of existing Pump/Meteora execution and post-trade safety checks;
- `DynamicAmountSelected` event for selected amount/direction and bounded-search
  diagnostics, including whether a future proof-safe early stop was used (V1
  always reports `false` and completes the bounded traversal);
- instruction serialization, unit, TypeScript, and isolated integration tests.

## Compatibility

The account layout is unchanged. Existing instruction discriminators and fixed
argument layouts are unchanged. Dynamic mode is opt-in and restricted to
on-chain best-direction selection.

The caller still supplies a direction-neutral BinArray superset. The Program
selects only the ordered subset required by the chosen current-state quote.
The existing per-direction limits of two BinArrays and 16 visited bins remain.

## Verification boundary

Local unit, ABI-construction, build, lint, and TypeScript results are recorded in
the change handoff. Controlled public-state Surfpool executions selected bounded
amounts in both directions and completed at 219,961 CU (Pump to Meteora) and
215,963 CU (Meteora to Pump), below the 300,000-CU acceptance target. The
repository-owned Searcher-to-Executor harness independently completed at
218,263 CU and 214,248 CU. No entry in this document asserts a mainnet deployment
or profitable production result.
