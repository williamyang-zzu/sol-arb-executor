use anchor_lang::prelude::*;

use crate::{
    adapters::{meteora_dlmm, pump_swap},
    events::{FirstLegCompleted, RouteCompleted, RouteDirection, RouteStarted, SecondLegCompleted},
    instructions::{post_trade_checks, ExecuteRoute},
    utils::balance::checked_increase,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Eq, PartialEq)]
pub struct MeteoraToPumpArgs {
    pub wsol_amount_in: u64,
    pub min_profit_lamports: u64,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
    args: MeteoraToPumpArgs,
) -> Result<()> {
    post_trade_checks::validate_args(args.wsol_amount_in, args.min_profit_lamports)?;
    ctx.accounts.validate_route_mints()?;
    execute(
        ctx.accounts,
        ctx.remaining_accounts,
        args.wsol_amount_in,
        args.min_profit_lamports,
    )
}

pub(crate) fn execute<'info>(
    accounts: &mut ExecuteRoute<'info>,
    bin_arrays: &[AccountInfo<'info>],
    wsol_amount_in: u64,
    min_profit_lamports: u64,
) -> Result<()> {
    let initial_wsol = accounts.user_wsol.amount;
    let initial_target = accounts.user_target.amount;
    emit!(RouteStarted {
        direction: RouteDirection::MeteoraToPump,
        trader: accounts.trader.key(),
        target_mint: accounts.target_mint.key(),
        initial_wsol_balance: initial_wsol,
    });

    let meteora_accounts = accounts.meteora_accounts(
        accounts.user_wsol.to_account_info(),
        accounts.user_target.to_account_info(),
    );
    meteora_dlmm::swap2(&meteora_accounts, bin_arrays, wsol_amount_in, 1)?;
    accounts.user_target.reload()?;
    let actual_target_delta = checked_increase(initial_target, accounts.user_target.amount)?;
    emit!(FirstLegCompleted {
        direction: RouteDirection::MeteoraToPump,
        actual_target_delta,
    });

    accounts.user_wsol.reload()?;
    let wsol_before_second_leg = accounts.user_wsol.amount;
    let required_second_leg_out = post_trade_checks::required_second_leg_out(
        initial_wsol,
        wsol_before_second_leg,
        min_profit_lamports,
    )?;
    pump_swap::sell(
        &accounts.pump_accounts(),
        actual_target_delta,
        required_second_leg_out,
    )?;
    accounts.user_wsol.reload()?;
    let second_leg_wsol_delta =
        checked_increase(wsol_before_second_leg, accounts.user_wsol.amount)?;
    emit!(SecondLegCompleted {
        direction: RouteDirection::MeteoraToPump,
        actual_wsol_delta: second_leg_wsol_delta,
    });

    let final_wsol = accounts.user_wsol.amount;
    accounts.user_target.reload()?;
    post_trade_checks::enforce(
        initial_wsol,
        final_wsol,
        min_profit_lamports,
        initial_target,
        accounts.user_target.amount,
    )?;
    emit!(RouteCompleted {
        direction: RouteDirection::MeteoraToPump,
        trader: accounts.trader.key(),
        target_mint: accounts.target_mint.key(),
        initial_wsol_balance: initial_wsol,
        final_wsol_balance: final_wsol,
        first_leg_target_delta: actual_target_delta,
        second_leg_wsol_delta,
    });
    Ok(())
}
