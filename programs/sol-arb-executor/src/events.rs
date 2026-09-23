use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteDirection {
    PumpToMeteora,
    MeteoraToPump,
}

#[event]
pub struct RouteStarted {
    pub direction: RouteDirection,
    pub trader: Pubkey,
    pub target_mint: Pubkey,
    pub initial_wsol_balance: u64,
}

#[event]
pub struct FirstLegCompleted {
    pub direction: RouteDirection,
    pub actual_target_delta: u64,
}

#[event]
pub struct SecondLegCompleted {
    pub direction: RouteDirection,
    pub actual_wsol_delta: u64,
}

#[event]
pub struct RouteCompleted {
    pub direction: RouteDirection,
    pub trader: Pubkey,
    pub target_mint: Pubkey,
    pub initial_wsol_balance: u64,
    pub final_wsol_balance: u64,
    pub first_leg_target_delta: u64,
    pub second_leg_wsol_delta: u64,
}

#[event]
pub struct DynamicAmountSelected {
    pub direction: RouteDirection,
    pub min_wsol_amount_in: u64,
    pub max_wsol_amount_in: u64,
    pub balance_limited_max: u64,
    pub largest_complete_amount: u64,
    pub actual_wsol_amount_in: u64,
    pub expected_wsol_amount_out: u64,
    pub expected_profit_lamports: u64,
    pub visited_bins: u8,
    pub boundary_candidates: u8,
    pub interior_candidates: u8,
    pub early_stop_used: bool,
}

#[cfg(test)]
mod tests {
    use super::RouteDirection;

    #[test]
    fn route_directions_are_distinct() {
        assert_ne!(RouteDirection::PumpToMeteora, RouteDirection::MeteoraToPump);
    }
}
