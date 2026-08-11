#![allow(deprecated)] // Anchor 0.31.1 generated code still calls AccountInfo::realloc.

use anchor_lang::prelude::*;

pub mod adapters;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod quote;
pub mod utils;

pub(crate) use instructions::__client_accounts_execute_route;
pub use instructions::best_direction::BestDirectionArgs;
pub use instructions::meteora_to_pump::MeteoraToPumpArgs;
pub use instructions::pump_to_meteora::PumpToMeteoraArgs;
pub use instructions::ExecuteRoute;

declare_id!("RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51");

#[program]
pub mod sol_arb_executor {
    use super::*;

    pub fn execute_pump_to_meteora<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
        args: PumpToMeteoraArgs,
    ) -> Result<()> {
        instructions::pump_to_meteora::handler(ctx, args)
    }

    pub fn execute_meteora_to_pump<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
        args: MeteoraToPumpArgs,
    ) -> Result<()> {
        instructions::meteora_to_pump::handler(ctx, args)
    }

    pub fn execute_best_direction<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
        args: BestDirectionArgs,
    ) -> Result<()> {
        instructions::best_direction::handler(ctx, args)
    }
}
