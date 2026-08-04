use anchor_lang::prelude::*;

use crate::errors::ArbError;

pub fn checked_increase(before: u64, after: u64) -> Result<u64> {
    let delta = after
        .checked_sub(before)
        .ok_or(error!(ArbError::BalanceDidNotIncreaseAsExpected))?;
    require!(delta > 0, ArbError::BalanceDidNotIncreaseAsExpected);
    Ok(delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_positive_delta() {
        assert_eq!(checked_increase(10, 17).unwrap(), 7);
    }

    #[test]
    fn rejects_equal_or_lower_balance() {
        assert!(checked_increase(10, 10).is_err());
        assert!(checked_increase(10, 9).is_err());
    }

    #[test]
    fn handles_u64_boundary_without_overflow() {
        assert_eq!(checked_increase(u64::MAX - 1, u64::MAX).unwrap(), 1);
    }
}
