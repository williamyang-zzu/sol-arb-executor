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

#[cfg(test)]
mod tests {
    use super::RouteDirection;

    #[test]
    fn route_directions_are_distinct() {
        assert_ne!(RouteDirection::PumpToMeteora, RouteDirection::MeteoraToPump);
    }
}
