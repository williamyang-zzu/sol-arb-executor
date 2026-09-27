# Architecture decisions

This file records durable executor decisions. Deployment facts belong in
`mainnet-milestones.md`; protocol pins belong in `protocol-versions.md`.

## ADR-001: Preserve fixed execution while adding bounded dynamic sizing

- Status: accepted
- Date: 2026-09-22
- Decision: retain `execute_pump_to_meteora`, `execute_meteora_to_pump`, and
  `execute_best_direction` unchanged. Add dynamic sizing through the separate
  `execute_best_direction_dynamic(min_wsol_amount_in, max_wsol_amount_in,
  min_profit_lamports)` instruction only.
- Rationale: fixed amount remains the lowest-risk compatibility and fast path.
  A separate discriminator prevents a client configuration change from silently
  altering existing instruction bytes or execution semantics.
- Consequence: clients must select fixed or dynamic mode explicitly. Dynamic
  sizing cannot be combined with a fixed-direction instruction.

## ADR-002: Search bounded piecewise liquidity, not arbitrary trial amounts

- Status: accepted
- Date: 2026-09-22
- Decision: parse market state once per instruction and reuse a bounded Meteora
  piecewise curve. Candidate amounts are the configured minimum, the largest
  amount with a complete quote, Bin liquidity boundaries, and one analytic
  interior estimate plus adjacent integer points per segment. Every candidate
  is finally evaluated by the production integer quote functions.
- Decision: maximize absolute gross WSOL profit. Resolve equal-profit choices
  by lower input amount and then the existing forward-direction tie-break.
- Rationale: this captures boundary and within-bin optima without replaying the
  complete DLMM traversal for many arbitrary sizes. Exact integer re-quotation
  contains rounding error from the analytic estimate.
- Decision: stop materializing each directional curve as soon as its cumulative
  input capacity covers the configured maximum reachable for that direction.
  Build each direction in its own non-inlined frame using one fixed-capacity,
  stack-backed 16-segment buffer. This changes neither the candidate domain nor
  exact quote arithmetic.
- Rationale: SBF uses a bounded bump allocator. Reserving all 16 possible
  segments on the heap left too little memory for subsequent Pump and Meteora
  CPI account vectors, while combining the buffer with Anchor account handling
  in one frame exceeded the 4 KiB SBF frame limit. Separate non-inlined frames
  provide deterministic memory bounds without reducing coverage.
- Consequence: this is a bounded optimizer over supplied execution accounts,
  not a proof of the global optimum across liquidity that was not supplied.

## ADR-003: Keep coverage and post-trade safety authoritative

- Status: accepted
- Date: 2026-09-22
- Decision: effective configured maximum is first capped by the user's current
  WSOL token-account balance, then independently capped per direction by the
  largest amount that can be fully quoted within the supplied accounts.
- Decision: retain the existing quote traversal limits, account validation,
  second-leg minimum-output computation, final WSOL profit check, target-token
  restoration check, and atomic rollback behavior.
- Rationale: dynamic size selection must not convert missing account coverage
  into a partial swap or weaken the final execution invariants.
- Consequence: an incomplete larger amount is discarded while smaller complete
  candidates remain eligible. If no complete candidate meets minimum profit,
  the instruction fails before any DEX CPI.

## ADR-004: Treat 300,000 CU as a release acceptance target

- Status: accepted
- Date: 2026-09-22
- Decision: fixed paths must remain behaviorally unchanged, and controlled
  dynamic forward/reverse success paths must be measured against a 300,000 CU
  transaction limit before production deployment.
- Rationale: dynamic sizing is valuable only if its additional quote work does
  not erase the ordering and inclusion characteristics required by the system.
- Consequence: deterministic unit/build tests are necessary but not sufficient;
  isolated real-protocol Surfpool evidence is a release gate. Failure to obtain
  that evidence blocks a production-readiness claim, not local development.
- Clarification: 300,000 CU is an optimization and acceptance target, not a
  protocol-correctness invariant. A sound implementation may be reviewed with
  a limit up to 350,000 CU rather than weakening coverage, quote accuracy, or
  post-trade safety solely to cross the 300,000-CU line.
- Verification: controlled public-state forward and reverse dynamic executions
  consumed 219,961 CU and 215,963 CU respectively under a 300,000-CU limit.

## ADR-005: Enforce the dynamic minimum after coverage capping

- Status: accepted
- Date: 2026-09-26
- Decision: a direction whose largest completely quotable WSOL input is below
  `min_wsol_amount_in` is incomplete and contributes no candidate. Every
  evaluated and selected amount must remain inside the caller's inclusive
  minimum and balance-capped maximum.
- Decision: keep the existing `BestDirectionQuoteIncomplete` ABI error. Emit
  one compact failure-only diagnostic containing each direction's curve stop
  code, largest complete amount and visited-Bin count so account coverage,
  traversal limits and empty liquidity can be distinguished during controlled
  validation without logging every Bin.
- Rationale: coverage capping must preserve a smaller legal candidate, but it
  must never silently turn the configured minimum into a suggestion. The prior
  candidate list admitted a non-zero coverage boundary below the minimum.
- Consequence: no fixed instruction, account layout, discriminator or public
  error code changes. Searcher coverage policy remains independent and the
  Program remains the execution-time amount and quote authority.

## ADR-006: Preserve exact boundary candidates with monotonic inversion

- Status: superseded by ADR-007
- Date: 2026-09-26
- Decision: retain the same conservative Pump inverse-quote rounding window,
  but find its first satisfying input by monotonic binary search. Reuse each
  forward segment's already-computed end input as the next segment's start.
- Rationale: linearly replaying a full Pump quote for every lamport in the
  rounding window, twice for adjacent segment boundaries, consumed enough CU
  for an active Token-2022 fixture to exhaust even 350,000 CU. Pump output is
  monotonic in quote input, so binary search preserves the exact minimum input
  and all existing boundary/interior candidates without reducing coverage.
- Verification: the same isolated dynamic-forward fixture failed at both
  300,000 and 350,000 CU before this change, then completed at 298,860 CU.
  Dynamic reverse completed at 260,051 CU; fixed forward/reverse completed at
  181,724 and 169,910 CU. All retained the 300,000-CU production target.

## ADR-007: Sample Pump boundaries conservatively without per-boundary search

- Status: accepted; multi-pool CU release gate remains open
- Date: 2026-09-27
- Decision: map each forward DLMM Token boundary to a closed-form Pump WSOL
  input that is provably below the first crossing input after fee rounding.
  Validate that sample with one production Pump quote and keep exact integer
  re-quotation for every admitted candidate. Do not replay a binary search for
  every Bin boundary.
- Decision: retain the single monotonic search that caps the direction's
  largest completely covered input. It is coverage-critical and runs once per
  direction rather than once per segment.
- Rationale: exact per-boundary inversion repeated Pump quotes for every usable
  DLMM segment. Boundary sampling does not need exact inversion because the
  optimizer is already bounded/approximate and every candidate, CPI minimum
  output and final profit condition remain exact. Sampling immediately below
  the boundary also cannot extend beyond the supplied DLMM coverage.
- Consequence: a boundary candidate may be a few lamports below the exact first
  crossing input. Unit vectors across multiple reserves and fee schedules keep
  the gap within eight lamports. This can trade negligible boundary precision
  for bounded CU without weakening execution or profit safety.
- Verification: on the A13 controlled route, dynamic forward/reverse fell from
  298,649/260,708 CU to 281,858/250,867 CU. On a denser DD3A pressure route,
  they fell from 698,977/387,108 CU to 575,138/366,230 CU. The latter remains
  above even the reviewed 350,000-CU ceiling, so this decision is retained as
  a useful optimization but does not close the multi-pool production gate.

## ADR-008: Require complete minimum quotes before declaring no profit

- Status: accepted
- Date: 2026-09-27
- Decision: a dynamic search may execute a profitable, completely quoted
  direction even when the other direction is incomplete. If neither direction
  has a profitable candidate, however, `NoProfitableDirection` is returned only
  when both directions completed an exact quote at `min_wsol_amount_in`.
  Otherwise the existing `BestDirectionQuoteIncomplete` error is returned.
- Decision: failure-only diagnostics record, for both directions, minimum-quote
  completeness/output, coverage cap, curve stop reason and visited-Bin count.
  Successful transactions do not pay this logging cost.
- Rationale: an incomplete direction may contain the profitable route. Calling
  that state "no profit" makes coverage failures indistinguishable from a real
  complete two-direction no-profit result.
- Verification: unit tests cover complete no-profit, one-sided incomplete and
  one-sided profitable fallback. On one immutable A13 real-protocol Surfpool
  snapshot, fixed `0.005 SOL`, dynamic `min=max=0.005 SOL`, and dynamic
  `0.005..0.02 SOL` were simulated without committing state in both directions.
  Fixed and exact-dynamic direction/profit matched exactly; all six simulations
  stayed below the `300,000 CU` target.

## Decision update rule

When a decision changes, mark the old entry as superseded and add a replacement.
Do not silently rewrite prior rationale or represent simulation as deployment.
