#![allow(unexpected_cfgs)]

use snapshot_accounts::{
    mint_supply, parse_bin_array, parse_lb_pair, parse_pump_fee_config, parse_pump_global_fees,
    parse_pump_pool, quote_dlmm_snapshot, select_pump_fees, token_amount,
};
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, log::sol_log_compute_units,
    msg, program_error::ProgramError, pubkey::Pubkey,
};

pub mod quote;
pub mod snapshot_accounts;

entrypoint!(process_instruction);

fn read_u64(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    let bytes = data
        .get(offset..offset + 8)
        .ok_or(ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first().copied() {
        Some(0) => {
            if data.len() != 39 {
                return Err(ProgramError::InvalidInstructionData);
            }
            sol_log_compute_units();
            let result = quote::pump_buy_exact_quote_in(
                read_u64(data, 1)?,
                read_u64(data, 9)?,
                read_u64(data, 17)?,
                read_u64(data, 25)?,
                u16::from_le_bytes(data[33..35].try_into().unwrap()),
                u16::from_le_bytes(data[35..37].try_into().unwrap()),
                u16::from_le_bytes(data[37..39].try_into().unwrap()),
            )
            .map_err(|_| ProgramError::InvalidArgument)?;
            msg!(
                "probe:pump in={} out={} fee={}",
                result.amount_in,
                result.amount_out,
                result.fee
            );
            sol_log_compute_units();
            Ok(())
        }
        Some(1) => {
            if data.len() < 25 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let amount_in = read_u64(data, 1)?;
            let bin_count = usize::from(data[9]);
            if bin_count == 0 || bin_count > 140 || data.len() != 25 + bin_count * 32 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let parameters = quote::DlmmFeeParameters {
                bin_step: u16::from_le_bytes(data[12..14].try_into().unwrap()),
                base_factor: u16::from_le_bytes(data[14..16].try_into().unwrap()),
                base_fee_power_factor: data[16],
                variable_fee_control: u32::from_le_bytes(data[17..21].try_into().unwrap()),
                volatility_accumulator: u32::from_le_bytes(data[21..25].try_into().unwrap()),
            };
            let mut bins = Vec::with_capacity(bin_count);
            for index in 0..bin_count {
                let offset = 25 + index * 32;
                bins.push(quote::Bin {
                    price_q64: u128::from_le_bytes(data[offset..offset + 16].try_into().unwrap()),
                    amount_x: read_u64(data, offset + 16)?,
                    amount_y: read_u64(data, offset + 24)?,
                    open_order_amount: 0,
                    processed_order_remaining_amount: 0,
                    limit_order_ask_side: false,
                });
            }
            sol_log_compute_units();
            let result = quote::dlmm_quote_exact_in(
                amount_in,
                &bins,
                data[10] != 0,
                data[11] != 0,
                parameters,
            )
            .map_err(|_| ProgramError::InvalidArgument)?;
            msg!(
                "probe:dlmm in={} out={} fee={} bins={}",
                result.amount_in,
                result.amount_out,
                result.fee,
                bin_count
            );
            sol_log_compute_units();
            Ok(())
        }
        Some(2) => {
            let bin_count = usize::from(*data.get(1).ok_or(ProgramError::InvalidInstructionData)?);
            if bin_count == 0 || bin_count > 140 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let mut bins = Vec::with_capacity(bin_count);
            let q64 = 1_u128 << 64;
            for index in 0..bin_count {
                bins.push(quote::Bin {
                    price_q64: q64 * u128::from(10_000_u16.saturating_sub(index as u16)) / 10_000,
                    amount_x: 0,
                    amount_y: if index + 1 == bin_count {
                        10_000_000
                    } else {
                        1
                    },
                    open_order_amount: 0,
                    processed_order_remaining_amount: 0,
                    limit_order_ask_side: false,
                });
            }
            let result = quote::dlmm_quote_exact_in(
                5_000_000,
                &bins,
                true,
                true,
                quote::DlmmFeeParameters {
                    bin_step: 10,
                    base_factor: 200,
                    base_fee_power_factor: 0,
                    variable_fee_control: 100,
                    volatility_accumulator: 1_000,
                },
            )
            .map_err(|_| ProgramError::InvalidArgument)?;
            msg!(
                "probe:dlmm-synthetic out={} bins={}",
                result.amount_out,
                bin_count
            );
            Ok(())
        }
        Some(255) => Ok(()),
        Some(3) => {
            if data.len() != 17 || _accounts.len() < 8 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let timestamp = i64::from_le_bytes(data[1..9].try_into().unwrap());
            let input = read_u64(data, 9)?;
            sol_log_compute_units();
            let pool_data = _accounts[0].try_borrow_data()?;
            let global_data = _accounts[1].try_borrow_data()?;
            let fee_config_data = _accounts[2].try_borrow_data()?;
            let mint_data = _accounts[3].try_borrow_data()?;
            let base_vault_data = _accounts[4].try_borrow_data()?;
            let quote_vault_data = _accounts[5].try_borrow_data()?;
            let pair_data = _accounts[6].try_borrow_data()?;
            let bin_array_data = _accounts[7].try_borrow_data()?;
            let pool = parse_pump_pool(&pool_data).map_err(|_| ProgramError::InvalidAccountData)?;
            let base_reserve =
                token_amount(&base_vault_data).map_err(|_| ProgramError::InvalidAccountData)?;
            let quote_reserve =
                token_amount(&quote_vault_data).map_err(|_| ProgramError::InvalidAccountData)?;
            let fees = select_pump_fees(
                Some(
                    &parse_pump_fee_config(&fee_config_data)
                        .map_err(|_| ProgramError::InvalidAccountData)?,
                ),
                parse_pump_global_fees(&global_data)
                    .map_err(|_| ProgramError::InvalidAccountData)?,
                true,
                mint_supply(&mint_data).map_err(|_| ProgramError::InvalidAccountData)?,
                base_reserve,
                quote_reserve
                    .checked_add(pool.virtual_quote_reserves)
                    .ok_or(ProgramError::ArithmeticOverflow)?,
            )
            .map_err(|_| ProgramError::InvalidAccountData)?;
            let pair = parse_lb_pair(&pair_data).map_err(|_| ProgramError::InvalidAccountData)?;
            let arrays = [
                parse_bin_array(&bin_array_data).map_err(|_| ProgramError::InvalidAccountData)?
            ];
            let pump_buy = quote::pump_buy_exact_quote_in(
                input,
                base_reserve,
                quote_reserve,
                pool.virtual_quote_reserves,
                fees.lp_fee_bps,
                fees.protocol_fee_bps,
                fees.creator_fee_bps,
            )
            .map_err(|_| ProgramError::InvalidArgument)?;
            let forward = quote_dlmm_snapshot(pump_buy.amount_out, &pair, &arrays, true, timestamp)
                .map_err(|_| ProgramError::InvalidArgument)?;
            let reverse = quote_dlmm_snapshot(input, &pair, &arrays, false, timestamp)
                .map_err(|_| ProgramError::InvalidArgument)?;
            let reverse_final = quote::pump_sell_base_in(
                reverse.amount_out,
                base_reserve,
                quote_reserve,
                pool.virtual_quote_reserves,
                fees.lp_fee_bps,
                fees.protocol_fee_bps,
                fees.creator_fee_bps,
            )
            .map_err(|_| ProgramError::InvalidArgument)?;
            msg!(
                "probe:real forward={} reverse={}",
                forward.amount_out,
                reverse_final.amount_out
            );
            sol_log_compute_units();
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
