use anchor_lang::prelude::*;

use crate::{
    adapters::{meteora_dlmm, pump_swap},
    events::{FirstLegCompleted, RouteCompleted, RouteDirection, RouteStarted, SecondLegCompleted},
    instructions::{post_trade_checks, ExecuteRoute},
    utils::balance::checked_increase,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Eq, PartialEq)]
pub struct PumpToMeteoraArgs {
    pub wsol_amount_in: u64,
    pub min_profit_lamports: u64,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
    args: PumpToMeteoraArgs,
) -> Result<()> {
    post_trade_checks::validate_args(args.wsol_amount_in, args.min_profit_lamports)?;
    ctx.accounts.validate_route_mints()?;
    let initial_wsol = ctx.accounts.user_wsol.amount;
    let initial_target = ctx.accounts.user_target.amount;
    emit!(RouteStarted {
        direction: RouteDirection::PumpToMeteora,
        trader: ctx.accounts.trader.key(),
        target_mint: ctx.accounts.target_mint.key(),
        initial_wsol_balance: initial_wsol,
    });

    pump_swap::buy_exact_quote_in(&ctx.accounts.pump_accounts(), args.wsol_amount_in, 1)?;
    ctx.accounts.user_target.reload()?;
    let actual_target_delta = checked_increase(initial_target, ctx.accounts.user_target.amount)?;
    emit!(FirstLegCompleted {
        direction: RouteDirection::PumpToMeteora,
        actual_target_delta,
    });

    ctx.accounts.user_wsol.reload()?;
    let wsol_before_second_leg = ctx.accounts.user_wsol.amount;
    let required_second_leg_out = post_trade_checks::required_second_leg_out(
        initial_wsol,
        wsol_before_second_leg,
        args.min_profit_lamports,
    )?;
    let meteora_accounts = ctx.accounts.meteora_accounts(
        ctx.accounts.user_target.to_account_info(),
        ctx.accounts.user_wsol.to_account_info(),
    );
    meteora_dlmm::swap2(
        &meteora_accounts,
        ctx.remaining_accounts,
        actual_target_delta,
        required_second_leg_out,
    )?;
    ctx.accounts.user_wsol.reload()?;
    let second_leg_wsol_delta =
        checked_increase(wsol_before_second_leg, ctx.accounts.user_wsol.amount)?;
    emit!(SecondLegCompleted {
        direction: RouteDirection::PumpToMeteora,
        actual_wsol_delta: second_leg_wsol_delta,
    });

    let final_wsol = ctx.accounts.user_wsol.amount;
    ctx.accounts.user_target.reload()?;
    post_trade_checks::enforce(
        initial_wsol,
        final_wsol,
        args.min_profit_lamports,
        initial_target,
        ctx.accounts.user_target.amount,
    )?;
    emit!(RouteCompleted {
        direction: RouteDirection::PumpToMeteora,
        trader: ctx.accounts.trader.key(),
        target_mint: ctx.accounts.target_mint.key(),
        initial_wsol_balance: initial_wsol,
        final_wsol_balance: final_wsol,
        first_leg_target_delta: actual_target_delta,
        second_leg_wsol_delta,
    });
    Ok(())
}
