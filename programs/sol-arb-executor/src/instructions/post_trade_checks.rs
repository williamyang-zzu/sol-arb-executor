use anchor_lang::prelude::*;

/// MVP observation hook. It intentionally does not enforce profitability.
///
/// Future extension:
/// `require!(final_wsol >= initial_wsol.checked_add(min_profit)?, ProfitTooLow)`.
pub fn observe(_initial_wsol: u64, _final_wsol: u64) -> Result<()> {
    Ok(())
}
