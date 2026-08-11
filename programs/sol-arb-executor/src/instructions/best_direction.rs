use anchor_lang::prelude::*;

use crate::{
    constants::{PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID},
    errors::ArbError,
    instructions::{meteora_to_pump, post_trade_checks, pump_to_meteora, ExecuteRoute},
    quote::{
        bin_array_index, default_bitmap_contains, dlmm_fee_parameters, dlmm_quote_exact_in_partial,
        extension_bitmap_contains, fee_on_input, parse_bin_array_index, parse_bin_for_id,
        parse_lb_pair, parse_pump_global_fees, parse_pump_pool, pump_buy_exact_quote_in,
        pump_sell_base_in, select_pump_fees_from_data, supports_limit_orders, token_amount,
        update_reference, update_volatility_accumulator, LbPairState,
        MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION, MAX_QUOTE_VISITED_BINS_PER_DIRECTION,
    },
    utils::account_validation::validate_bin_arrays,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Eq, PartialEq)]
pub struct BestDirectionArgs {
    pub wsol_amount_in: u64,
    pub min_profit_lamports: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SelectedDirection {
    PumpToMeteora,
    MeteoraToPump,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AccountDataQuote {
    amount_out: u64,
    used_indices: [i64; MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION],
    used_len: usize,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
    args: BestDirectionArgs,
) -> Result<()> {
    post_trade_checks::validate_args(args.wsol_amount_in, args.min_profit_lamports)?;
    ctx.accounts.validate_route_mints()?;
    validate_quote_accounts(ctx.accounts, ctx.remaining_accounts)?;

    let timestamp = Clock::get()?.unix_timestamp;
    let (direction, used_array_indices) = select_direction(
        ctx.accounts,
        ctx.remaining_accounts,
        args.wsol_amount_in,
        args.min_profit_lamports,
        timestamp,
    )?;
    let selected_bin_arrays = ordered_bin_arrays(ctx.remaining_accounts, &used_array_indices)?;

    match direction {
        SelectedDirection::PumpToMeteora => pump_to_meteora::execute(
            ctx.accounts,
            &selected_bin_arrays,
            args.wsol_amount_in,
            args.min_profit_lamports,
        ),
        SelectedDirection::MeteoraToPump => meteora_to_pump::execute(
            ctx.accounts,
            &selected_bin_arrays,
            args.wsol_amount_in,
            args.min_profit_lamports,
        ),
    }
}

fn validate_quote_accounts(
    accounts: &ExecuteRoute<'_>,
    bin_arrays: &[AccountInfo<'_>],
) -> Result<()> {
    require!(
        bin_arrays.len() <= crate::constants::MAX_BEST_DIRECTION_BIN_ARRAYS,
        ArbError::InvalidRemainingAccounts
    );
    require_keys_eq!(
        *accounts.pump_global_config.owner,
        PUMP_SWAP_PROGRAM_ID,
        ArbError::InvalidPool
    );
    require_keys_eq!(
        *accounts.pump_fee_config.owner,
        PUMP_FEE_PROGRAM_ID,
        ArbError::InvalidPool
    );
    let expected_global =
        Pubkey::find_program_address(&[b"global_config"], &PUMP_SWAP_PROGRAM_ID).0;
    require_keys_eq!(
        accounts.pump_global_config.key(),
        expected_global,
        ArbError::InvalidPool
    );
    let expected_fee = Pubkey::find_program_address(
        &[b"fee_config", PUMP_SWAP_PROGRAM_ID.as_ref()],
        &PUMP_FEE_PROGRAM_ID,
    )
    .0;
    require_keys_eq!(
        accounts.pump_fee_config.key(),
        expected_fee,
        ArbError::InvalidPool
    );
    if accounts.meteora_bin_array_bitmap_extension.key()
        != crate::constants::METEORA_DLMM_PROGRAM_ID
    {
        require_keys_eq!(
            *accounts.meteora_bin_array_bitmap_extension.owner,
            crate::constants::METEORA_DLMM_PROGRAM_ID,
            ArbError::InvalidPool
        );
        let expected_bitmap = Pubkey::find_program_address(
            &[b"bitmap", accounts.meteora_lb_pair.key().as_ref()],
            &crate::constants::METEORA_DLMM_PROGRAM_ID,
        )
        .0;
        require_keys_eq!(
            accounts.meteora_bin_array_bitmap_extension.key(),
            expected_bitmap,
            ArbError::InvalidPool
        );
    }
    validate_bin_arrays(bin_arrays, &accounts.meteora_lb_pair.key())
}

fn select_direction(
    accounts: &ExecuteRoute<'_>,
    bin_array_accounts: &[AccountInfo<'_>],
    amount_in: u64,
    min_profit: u64,
    timestamp: i64,
) -> Result<(SelectedDirection, Vec<i64>)> {
    let pool_data = accounts.pump_pool.try_borrow_data()?;
    let global_data = accounts.pump_global_config.try_borrow_data()?;
    let fee_config_data = accounts.pump_fee_config.try_borrow_data()?;
    let base_vault_data = accounts.pump_pool_base_token_account.try_borrow_data()?;
    let quote_vault_data = accounts.pump_pool_quote_token_account.try_borrow_data()?;
    let pair_data = accounts.meteora_lb_pair.try_borrow_data()?;
    let bitmap_extension_data = if accounts.meteora_bin_array_bitmap_extension.key()
        == crate::constants::METEORA_DLMM_PROGRAM_ID
    {
        None
    } else {
        Some(
            accounts
                .meteora_bin_array_bitmap_extension
                .try_borrow_data()?,
        )
    };
    let bitmap_extension = bitmap_extension_data.as_ref().map(|data| &data[..]);

    let pool = parse_pump_pool(&pool_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let base_reserve =
        token_amount(&base_vault_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let quote_reserve =
        token_amount(&quote_vault_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let supply = accounts.target_mint.supply;
    let effective_quote_reserve = quote_reserve
        .checked_add(pool.virtual_quote_reserves)
        .ok_or_else(|| error!(ArbError::ArithmeticOverflow))?;

    let creator = Pubkey::new_from_array(pool.creator);
    let expected_pump_creator = Pubkey::find_program_address(
        &[b"pool-authority", accounts.target_mint.key().as_ref()],
        &PUMP_PROGRAM_ID,
    )
    .0;
    let mut fees = select_pump_fees_from_data(
        &fee_config_data,
        parse_pump_global_fees(&global_data).map_err(|_| error!(ArbError::InvalidAccountData))?,
        creator == expected_pump_creator,
        supply,
        base_reserve,
        effective_quote_reserve,
    )
    .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    if pool.coin_creator == [0; 32] {
        fees.creator_fee_bps = 0;
    }

    let pair = parse_lb_pair(&pair_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let target_is_x = crate::utils::account_validation::parse_meteora_pair(&pair_data)?
        .token_x_mint
        == accounts.target_mint.key();

    let pump_buy = pump_buy_exact_quote_in(
        amount_in,
        base_reserve,
        quote_reserve,
        pool.virtual_quote_reserves,
        fees.lp_fee_bps,
        fees.protocol_fee_bps,
        fees.creator_fee_bps,
    )
    .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    let forward = quote_dlmm_from_accounts(
        pump_buy.amount_out,
        &pair,
        bin_array_accounts,
        bitmap_extension,
        target_is_x,
        timestamp,
    )
    .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;

    let reverse = quote_dlmm_from_accounts(
        amount_in,
        &pair,
        bin_array_accounts,
        bitmap_extension,
        !target_is_x,
        timestamp,
    )
    .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    let reverse_final = pump_sell_base_in(
        reverse.amount_out,
        base_reserve,
        quote_reserve,
        pool.virtual_quote_reserves,
        fees.lp_fee_bps,
        fees.protocol_fee_bps,
        fees.creator_fee_bps,
    )
    .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;

    let required_out = amount_in
        .checked_add(min_profit)
        .ok_or_else(|| error!(ArbError::ArithmeticOverflow))?;
    let forward_out = forward.amount_out;
    let reverse_out = reverse_final.amount_out;
    let direction = choose_direction(forward_out, reverse_out, required_out)?;
    if direction == SelectedDirection::PumpToMeteora {
        Ok((
            SelectedDirection::PumpToMeteora,
            forward.used_indices[..forward.used_len].to_vec(),
        ))
    } else {
        Ok((
            SelectedDirection::MeteoraToPump,
            reverse.used_indices[..reverse.used_len].to_vec(),
        ))
    }
}

fn choose_direction(
    forward_out: u64,
    reverse_out: u64,
    required_out: u64,
) -> Result<SelectedDirection> {
    require!(
        forward_out >= required_out || reverse_out >= required_out,
        ArbError::NoProfitableDirection
    );
    Ok(if forward_out >= reverse_out {
        SelectedDirection::PumpToMeteora
    } else {
        SelectedDirection::MeteoraToPump
    })
}

fn quote_dlmm_from_accounts(
    amount_in: u64,
    pair: &LbPairState,
    arrays: &[AccountInfo<'_>],
    bitmap_extension: Option<&[u8]>,
    swap_for_y: bool,
    timestamp: i64,
) -> Result<AccountDataQuote> {
    let mut variable = pair.variable_parameters;
    update_reference(
        pair.active_id,
        &mut variable,
        pair.static_parameters,
        timestamp,
    );
    let mut active_id = pair.active_id;
    let mut remaining = amount_in;
    let mut amount_out = 0_u64;
    let fee_on_input = fee_on_input(pair, swap_for_y)
        .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    let supports_limit_orders =
        supports_limit_orders(pair).map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    let mut used_indices = [0_i64; MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION];
    let mut used_len = 0_usize;

    for _ in 0..MAX_QUOTE_VISITED_BINS_PER_DIRECTION {
        if remaining == 0 {
            break;
        }
        let array_index = bin_array_index(active_id);
        let initialized = if (-512..=511).contains(&array_index) {
            default_bitmap_contains(&pair.bitmap, array_index)
        } else {
            bitmap_extension
                .map(|data| extension_bitmap_contains(data, array_index))
                .transpose()
                .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?
                .unwrap_or(false)
        };
        if !initialized {
            active_id = next_bin(active_id, swap_for_y);
            continue;
        }
        let account = arrays
            .iter()
            .find(|account| {
                account
                    .try_borrow_data()
                    .ok()
                    .and_then(|data| parse_bin_array_index(&data).ok())
                    == Some(array_index)
            })
            .ok_or_else(|| error!(ArbError::BestDirectionQuoteIncomplete))?;
        if used_len == 0 || used_indices[used_len - 1] != array_index {
            require!(
                used_len < MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION,
                ArbError::BestDirectionQuoteIncomplete
            );
            used_indices[used_len] = array_index;
            used_len += 1;
        }
        let mut bin = parse_bin_for_id(&account.try_borrow_data()?, active_id, array_index)
            .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
        if !supports_limit_orders {
            bin.open_order_amount = 0;
            bin.processed_order_remaining_amount = 0;
        }
        update_volatility_accumulator(active_id, &mut variable, pair.static_parameters);
        let partial = dlmm_quote_exact_in_partial(
            remaining,
            core::slice::from_ref(&bin),
            swap_for_y,
            fee_on_input,
            dlmm_fee_parameters(pair, variable),
        )
        .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
        remaining = remaining
            .checked_sub(partial.amount_in)
            .ok_or_else(|| error!(ArbError::ArithmeticOverflow))?;
        amount_out = amount_out
            .checked_add(partial.amount_out)
            .ok_or_else(|| error!(ArbError::ArithmeticOverflow))?;
        if remaining != 0 {
            active_id = next_bin(active_id, swap_for_y);
        }
    }
    require!(remaining == 0, ArbError::BestDirectionQuoteIncomplete);
    Ok(AccountDataQuote {
        amount_out,
        used_indices,
        used_len,
    })
}

fn next_bin(active_id: i32, swap_for_y: bool) -> i32 {
    if swap_for_y {
        active_id.saturating_sub(1)
    } else {
        active_id.saturating_add(1)
    }
}

fn ordered_bin_arrays<'info>(
    accounts: &[AccountInfo<'info>],
    indices: &[i64],
) -> Result<Vec<AccountInfo<'info>>> {
    indices
        .iter()
        .map(|wanted| {
            accounts
                .iter()
                .find(|account| {
                    account
                        .try_borrow_data()
                        .ok()
                        .and_then(|data| parse_bin_array_index(&data).ok())
                        .map(|index| index == *wanted)
                        .unwrap_or(false)
                })
                .cloned()
                .ok_or_else(|| error!(ArbError::BestDirectionQuoteIncomplete))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_larger_profitable_route_and_breaks_ties_forward() {
        assert_eq!(
            choose_direction(1_020, 1_010, 1_001).unwrap(),
            SelectedDirection::PumpToMeteora
        );
        assert_eq!(
            choose_direction(1_010, 1_020, 1_001).unwrap(),
            SelectedDirection::MeteoraToPump
        );
        assert_eq!(
            choose_direction(1_010, 1_010, 1_001).unwrap(),
            SelectedDirection::PumpToMeteora
        );
    }

    #[test]
    fn rejects_when_neither_route_meets_profit_floor() {
        assert!(choose_direction(1_000, 1_001, 1_002).is_err());
    }
}
