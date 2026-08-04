# Mainnet simulation smoke tests

The two scripts under `scripts/` are the opt-in integration smoke tests. They
require live pool-specific accounts and simulate by default. They are not part
of the deterministic test suite and never broadcast unless
`SEND_REAL_TRANSACTION=true`.

