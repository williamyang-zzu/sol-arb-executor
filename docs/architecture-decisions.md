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

## Decision update rule

When a decision changes, mark the old entry as superseded and add a replacement.
Do not silently rewrite prior rationale or represent simulation as deployment.
