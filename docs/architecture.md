# Architecture

`sol-arb-executor` is an Anchor-based on-chain executor. It exposes fixed
instruction entrypoints, validates all route accounts, invokes supported
protocols through dedicated CPI adapters, checks resulting account state, and
emits execution lifecycle events.

## Internal layers

1. `lib.rs` exposes the program's fixed Anchor instruction entrypoints.
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

## Extension model

A supported protocol should have its own adapter with a fixed program ID and
explicit account validation. New execution paths should be exposed as explicit
Anchor instructions instead of accepting arbitrary CPI targets. Shared
post-execution invariants belong in `instructions/post_trade_checks.rs`.
