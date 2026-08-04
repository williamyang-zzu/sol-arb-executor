use anchor_lang::prelude::*;

use crate::{
    adapters::{meteora_dlmm, pump_swap},
    events::{FirstLegCompleted, RouteCompleted, RouteDirection, RouteStarted, SecondLegCompleted},
    instructions::{post_trade_checks, ExecuteRoute},
    utils::balance::checked_increase,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Eq, PartialEq)]
pub struct MeteoraToPumpArgs {
    pub meteora_wsol_in: u64,
    pub meteora_min_target_out: u64,
    pub pump_min_wsol_out: u64,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
    args: MeteoraToPumpArgs,
) -> Result<()> {
    ctx.accounts.validate_route_mints()?;
    let initial_wsol = ctx.accounts.user_wsol.amount;
    let initial_target = ctx.accounts.user_target.amount;
    emit!(RouteStarted {
        direction: RouteDirection::MeteoraToPump,
        trader: ctx.accounts.trader.key(),
        target_mint: ctx.accounts.target_mint.key(),
        initial_wsol_balance: initial_wsol,
    });

    let meteora_accounts = ctx.accounts.meteora_accounts(
        ctx.accounts.user_wsol.to_account_info(),
        ctx.accounts.user_target.to_account_info(),
    );
    meteora_dlmm::swap2(
        &meteora_accounts,
        ctx.remaining_accounts,
        args.meteora_wsol_in,
        args.meteora_min_target_out,
    )?;
    ctx.accounts.user_target.reload()?;
    let actual_target_delta = checked_increase(initial_target, ctx.accounts.user_target.amount)?;
    emit!(FirstLegCompleted {
        direction: RouteDirection::MeteoraToPump,
        actual_target_delta,
    });

    ctx.accounts.user_wsol.reload()?;
    let wsol_before_second_leg = ctx.accounts.user_wsol.amount;
    pump_swap::sell(
        &ctx.accounts.pump_accounts(),
        actual_target_delta,
        args.pump_min_wsol_out,
    )?;
    ctx.accounts.user_wsol.reload()?;
    let second_leg_wsol_delta =
        checked_increase(wsol_before_second_leg, ctx.accounts.user_wsol.amount)?;
    emit!(SecondLegCompleted {
        direction: RouteDirection::MeteoraToPump,
        actual_wsol_delta: second_leg_wsol_delta,
    });

    let final_wsol = ctx.accounts.user_wsol.amount;
    post_trade_checks::observe(initial_wsol, final_wsol)?;
    emit!(RouteCompleted {
        direction: RouteDirection::MeteoraToPump,
        trader: ctx.accounts.trader.key(),
        target_mint: ctx.accounts.target_mint.key(),
        initial_wsol_balance: initial_wsol,
        final_wsol_balance: final_wsol,
        first_leg_target_delta: actual_target_delta,
        second_leg_wsol_delta,
    });
    Ok(())
}
