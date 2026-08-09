use anchor_lang::prelude::*;

use crate::errors::ArbError;

pub fn validate_args(wsol_amount_in: u64, min_profit_lamports: u64) -> Result<()> {
    require!(wsol_amount_in > 0, ArbError::InvalidAmount);
    require!(min_profit_lamports > 0, ArbError::InvalidAmount);
    Ok(())
}

pub fn required_second_leg_out(
    initial_wsol: u64,
    wsol_before_second_leg: u64,
    min_profit_lamports: u64,
) -> Result<u64> {
    let required_final_wsol = initial_wsol
        .checked_add(min_profit_lamports)
        .ok_or(error!(ArbError::ArithmeticOverflow))?;
    Ok(required_final_wsol
        .saturating_sub(wsol_before_second_leg)
        .max(1))
}

pub fn enforce(
    initial_wsol: u64,
    final_wsol: u64,
    min_profit_lamports: u64,
    initial_target: u64,
    final_target: u64,
) -> Result<()> {
    let required_final_wsol = initial_wsol
        .checked_add(min_profit_lamports)
        .ok_or(error!(ArbError::ArithmeticOverflow))?;
    require!(final_wsol >= required_final_wsol, ArbError::ProfitTooLow);
    require!(
        final_target == initial_target,
        ArbError::TargetBalanceNotRestored
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_dynamic_inputs() {
        assert!(validate_args(10_000_000, 10_000).is_ok());
        assert!(validate_args(0, 10_000).is_err());
        assert!(validate_args(10_000_000, 0).is_err());
    }

    #[test]
    fn derives_second_leg_output_from_required_profit() {
        assert_eq!(
            required_second_leg_out(20_000_000, 10_000_000, 10_000).unwrap(),
            10_010_000
        );
    }

    #[test]
    fn enforces_profit_and_target_restoration() {
        assert!(enforce(10_000, 10_100, 100, 50, 50).is_ok());
        assert!(enforce(10_000, 10_099, 100, 50, 50).is_err());
        assert!(enforce(10_000, 10_100, 100, 50, 51).is_err());
    }
}
