//! Integer-only Pump AMM and Meteora DLMM quote arithmetic.
//!
//! This module deliberately has no Anchor dependencies so the exact same
//! implementation can be exercised by the standalone SBF CU probe.

pub const FEE_PRECISION: u128 = 1_000_000_000;
pub const MAX_FEE_RATE: u128 = 100_000_000;
pub const Q64: u32 = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuoteError {
    InvalidInput,
    MathOverflow,
    InsufficientLiquidity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QuoteResult {
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DlmmFeeParameters {
    pub bin_step: u16,
    pub base_factor: u16,
    pub base_fee_power_factor: u8,
    pub variable_fee_control: u32,
    pub volatility_accumulator: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Bin {
    pub price_q64: u128,
    pub amount_x: u64,
    pub amount_y: u64,
    pub open_order_amount: u64,
    pub processed_order_remaining_amount: u64,
    pub limit_order_ask_side: bool,
}

fn ceil_div(numerator: u128, denominator: u128) -> Result<u128, QuoteError> {
    if denominator == 0 {
        return Err(QuoteError::InvalidInput);
    }
    numerator
        .checked_add(denominator - 1)
        .ok_or(QuoteError::MathOverflow)
        .map(|value| value / denominator)
}

fn to_u64(value: u128) -> Result<u64, QuoteError> {
    value.try_into().map_err(|_| QuoteError::MathOverflow)
}

pub fn pump_buy_exact_quote_in(
    quote_in: u64,
    base_reserve: u64,
    quote_reserve: u64,
    virtual_quote_reserves: u64,
    lp_fee_bps: u16,
    protocol_fee_bps: u16,
    creator_fee_bps: u16,
) -> Result<QuoteResult, QuoteError> {
    if quote_in == 0 || base_reserve == 0 || quote_reserve == 0 {
        return Err(QuoteError::InvalidInput);
    }

    let total_fee_bps = u128::from(lp_fee_bps)
        .checked_add(u128::from(protocol_fee_bps))
        .and_then(|value| value.checked_add(u128::from(creator_fee_bps)))
        .ok_or(QuoteError::MathOverflow)?;
    let mut effective_quote = u128::from(quote_in)
        .checked_mul(10_000)
        .ok_or(QuoteError::MathOverflow)?
        / (10_000 + total_fee_bps);

    let fee_for = |bps: u16| -> Result<u128, QuoteError> {
        ceil_div(
            effective_quote
                .checked_mul(u128::from(bps))
                .ok_or(QuoteError::MathOverflow)?,
            10_000,
        )
    };
    let total_with_fees = effective_quote
        .checked_add(fee_for(lp_fee_bps)?)
        .and_then(|value| value.checked_add(fee_for(protocol_fee_bps).ok()?))
        .and_then(|value| value.checked_add(fee_for(creator_fee_bps).ok()?))
        .ok_or(QuoteError::MathOverflow)?;
    if total_with_fees > u128::from(quote_in) {
        effective_quote = effective_quote
            .checked_sub(total_with_fees - u128::from(quote_in))
            .ok_or(QuoteError::MathOverflow)?;
    }
    let curve_input = effective_quote
        .checked_sub(1)
        .ok_or(QuoteError::InvalidInput)?;
    let effective_quote_reserve = u128::from(quote_reserve)
        .checked_add(u128::from(virtual_quote_reserves))
        .ok_or(QuoteError::MathOverflow)?;
    let amount_out = u128::from(base_reserve)
        .checked_mul(curve_input)
        .ok_or(QuoteError::MathOverflow)?
        / effective_quote_reserve
            .checked_add(curve_input)
            .ok_or(QuoteError::MathOverflow)?;

    Ok(QuoteResult {
        amount_in: quote_in,
        amount_out: to_u64(amount_out)?,
        fee: to_u64(u128::from(quote_in) - effective_quote)?,
    })
}

pub fn pump_sell_base_in(
    base_in: u64,
    base_reserve: u64,
    quote_reserve: u64,
    virtual_quote_reserves: u64,
    lp_fee_bps: u16,
    protocol_fee_bps: u16,
    creator_fee_bps: u16,
) -> Result<QuoteResult, QuoteError> {
    if base_in == 0 || base_reserve == 0 || quote_reserve == 0 {
        return Err(QuoteError::InvalidInput);
    }
    let effective_quote_reserve = u128::from(quote_reserve)
        .checked_add(u128::from(virtual_quote_reserves))
        .ok_or(QuoteError::MathOverflow)?;
    let raw_quote = effective_quote_reserve
        .checked_mul(u128::from(base_in))
        .ok_or(QuoteError::MathOverflow)?
        / u128::from(base_reserve)
            .checked_add(u128::from(base_in))
            .ok_or(QuoteError::MathOverflow)?;
    let fee_for = |bps: u16| -> Result<u128, QuoteError> {
        ceil_div(
            raw_quote
                .checked_mul(u128::from(bps))
                .ok_or(QuoteError::MathOverflow)?,
            10_000,
        )
    };
    let lp_fee = fee_for(lp_fee_bps)?;
    let fee = lp_fee
        .checked_add(fee_for(protocol_fee_bps)?)
        .and_then(|value| value.checked_add(fee_for(creator_fee_bps).ok()?))
        .ok_or(QuoteError::MathOverflow)?;
    let amount_out = raw_quote.checked_sub(fee).ok_or(QuoteError::MathOverflow)?;
    if u128::from(quote_reserve)
        < raw_quote
            .checked_sub(lp_fee)
            .ok_or(QuoteError::MathOverflow)?
    {
        return Err(QuoteError::InsufficientLiquidity);
    }
    Ok(QuoteResult {
        amount_in: base_in,
        amount_out: to_u64(amount_out)?,
        fee: to_u64(fee)?,
    })
}

pub fn dlmm_total_fee_rate(parameters: DlmmFeeParameters) -> Result<u128, QuoteError> {
    let power = 10_u128
        .checked_pow(u32::from(parameters.base_fee_power_factor))
        .ok_or(QuoteError::MathOverflow)?;
    let base_fee = u128::from(parameters.base_factor)
        .checked_mul(u128::from(parameters.bin_step))
        .and_then(|value| value.checked_mul(10))
        .and_then(|value| value.checked_mul(power))
        .ok_or(QuoteError::MathOverflow)?;
    let variable_fee = if parameters.variable_fee_control == 0 {
        0
    } else {
        let volatility_bin = u128::from(parameters.volatility_accumulator)
            .checked_mul(u128::from(parameters.bin_step))
            .ok_or(QuoteError::MathOverflow)?;
        u128::from(parameters.variable_fee_control)
            .checked_mul(
                volatility_bin
                    .checked_mul(volatility_bin)
                    .ok_or(QuoteError::MathOverflow)?,
            )
            .and_then(|value| value.checked_add(99_999_999_999))
            .ok_or(QuoteError::MathOverflow)?
            / 100_000_000_000
    };
    Ok(base_fee
        .checked_add(variable_fee)
        .ok_or(QuoteError::MathOverflow)?
        .min(MAX_FEE_RATE))
}

fn excluded_fee_amount(amount: u64, fee_rate: u128) -> Result<(u64, u64), QuoteError> {
    let fee = ceil_div(
        u128::from(amount)
            .checked_mul(fee_rate)
            .ok_or(QuoteError::MathOverflow)?,
        FEE_PRECISION,
    )?;
    Ok((
        to_u64(
            u128::from(amount)
                .checked_sub(fee)
                .ok_or(QuoteError::MathOverflow)?,
        )?,
        to_u64(fee)?,
    ))
}

fn included_fee_amount(amount: u64, fee_rate: u128) -> Result<(u64, u64), QuoteError> {
    let denominator = FEE_PRECISION
        .checked_sub(fee_rate)
        .ok_or(QuoteError::InvalidInput)?;
    let included = ceil_div(
        u128::from(amount)
            .checked_mul(FEE_PRECISION)
            .ok_or(QuoteError::MathOverflow)?,
        denominator,
    )?;
    Ok((to_u64(included)?, to_u64(included - u128::from(amount))?))
}

fn amount_in_for_out(
    amount_out: u64,
    price_q64: u128,
    swap_for_y: bool,
) -> Result<u64, QuoteError> {
    if price_q64 == 0 {
        return Err(QuoteError::InvalidInput);
    }
    let value = if swap_for_y {
        ceil_div(u128::from(amount_out) << Q64, price_q64)?
    } else {
        ceil_div(
            u128::from(amount_out)
                .checked_mul(price_q64)
                .ok_or(QuoteError::MathOverflow)?,
            1_u128 << Q64,
        )?
    };
    to_u64(value)
}

fn amount_out_for_in(amount_in: u64, price_q64: u128, swap_for_y: bool) -> Result<u64, QuoteError> {
    if price_q64 == 0 {
        return Err(QuoteError::InvalidInput);
    }
    let value = if swap_for_y {
        u128::from(amount_in)
            .checked_mul(price_q64)
            .ok_or(QuoteError::MathOverflow)?
            >> Q64
    } else {
        (u128::from(amount_in) << Q64) / price_q64
    };
    to_u64(value)
}

pub fn dlmm_quote_exact_in(
    amount_in: u64,
    bins: &[Bin],
    swap_for_y: bool,
    fee_on_input: bool,
    parameters: DlmmFeeParameters,
) -> Result<QuoteResult, QuoteError> {
    dlmm_quote_exact_in_impl(amount_in, bins, swap_for_y, fee_on_input, parameters, true)
}

pub fn dlmm_quote_exact_in_partial(
    amount_in: u64,
    bins: &[Bin],
    swap_for_y: bool,
    fee_on_input: bool,
    parameters: DlmmFeeParameters,
) -> Result<QuoteResult, QuoteError> {
    dlmm_quote_exact_in_impl(amount_in, bins, swap_for_y, fee_on_input, parameters, false)
}

fn dlmm_quote_exact_in_impl(
    amount_in: u64,
    bins: &[Bin],
    swap_for_y: bool,
    fee_on_input: bool,
    parameters: DlmmFeeParameters,
    require_full_fill: bool,
) -> Result<QuoteResult, QuoteError> {
    if amount_in == 0 || bins.is_empty() {
        return Err(QuoteError::InvalidInput);
    }
    let fee_rate = dlmm_total_fee_rate(parameters)?;
    let mut remaining = amount_in;
    let mut total_in = 0_u64;
    let mut total_out = 0_u64;
    let mut total_fee = 0_u64;

    for bin in bins {
        if remaining == 0 {
            break;
        }
        let (available, fee_for_full_input) = if fee_on_input {
            excluded_fee_amount(remaining, fee_rate)?
        } else {
            (remaining, 0)
        };
        let mm_out = if swap_for_y {
            bin.amount_y
        } else {
            bin.amount_x
        };
        let limit_order_out = if (swap_for_y && !bin.limit_order_ask_side)
            || (!swap_for_y && bin.limit_order_ask_side)
        {
            bin.open_order_amount
                .checked_add(bin.processed_order_remaining_amount)
                .ok_or(QuoteError::MathOverflow)?
        } else {
            0
        };
        let max_out = mm_out
            .checked_add(limit_order_out)
            .ok_or(QuoteError::MathOverflow)?;
        if max_out == 0 {
            continue;
        }
        let max_input_without_fee = amount_in_for_out(max_out, bin.price_q64, swap_for_y)?;
        let used_without_fee = available.min(max_input_without_fee);
        let raw_out = if used_without_fee == max_input_without_fee {
            max_out
        } else {
            amount_out_for_in(used_without_fee, bin.price_q64, swap_for_y)?
        };
        let (used_with_fee, fee, output) = if fee_on_input {
            if used_without_fee == available {
                (remaining, fee_for_full_input, raw_out)
            } else {
                let (included, partial_fee) = included_fee_amount(used_without_fee, fee_rate)?;
                (included, partial_fee, raw_out)
            }
        } else {
            let (output, output_fee) = excluded_fee_amount(raw_out, fee_rate)?;
            (used_without_fee, output_fee, output)
        };
        remaining = remaining
            .checked_sub(used_with_fee)
            .ok_or(QuoteError::MathOverflow)?;
        total_in = total_in
            .checked_add(used_with_fee)
            .ok_or(QuoteError::MathOverflow)?;
        total_out = total_out
            .checked_add(output)
            .ok_or(QuoteError::MathOverflow)?;
        total_fee = total_fee.checked_add(fee).ok_or(QuoteError::MathOverflow)?;
    }

    if require_full_fill && remaining != 0 {
        return Err(QuoteError::InsufficientLiquidity);
    }
    Ok(QuoteResult {
        amount_in: total_in,
        amount_out: total_out,
        fee: total_fee,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pump_quote_vector() {
        let quote = pump_buy_exact_quote_in(
            5_000_000,
            800_000_000_000,
            20_000_000_000,
            1_000_000_000,
            20,
            5,
            5,
        )
        .unwrap();
        // Matches @pump-fun/pump-swap-sdk 1.19.0 buyQuoteInput exactly.
        assert_eq!(quote.amount_out, 189_861_292);
        assert_eq!(quote.fee, 14_957);
    }

    #[test]
    fn dlmm_crosses_two_bins() {
        let bins = [
            Bin {
                price_q64: 1_u128 << 64,
                amount_x: 0,
                amount_y: 2_000_000,
                open_order_amount: 0,
                processed_order_remaining_amount: 0,
                limit_order_ask_side: false,
            },
            Bin {
                price_q64: (1_u128 << 64) * 99 / 100,
                amount_x: 0,
                amount_y: 10_000_000,
                open_order_amount: 0,
                processed_order_remaining_amount: 0,
                limit_order_ask_side: false,
            },
        ];
        let quote = dlmm_quote_exact_in(
            5_000_000,
            &bins,
            true,
            true,
            DlmmFeeParameters {
                bin_step: 10,
                base_factor: 200,
                base_fee_power_factor: 0,
                variable_fee_control: 0,
                volatility_accumulator: 0,
            },
        )
        .unwrap();
        assert_eq!(quote.amount_in, 5_000_000);
        // Matches @meteora-ag/dlmm 1.9.14 swapExactInQuoteAtBin exactly.
        assert_eq!(quote.amount_out, 4_969_900);
        assert_eq!(quote.fee, 101);
    }

    #[test]
    fn dlmm_reverse_with_output_fee() {
        let quote = dlmm_quote_exact_in(
            3_000_000,
            &[Bin {
                price_q64: (1_u128 << 64) * 105 / 100,
                amount_x: 10_000_000,
                amount_y: 0,
                open_order_amount: 0,
                processed_order_remaining_amount: 0,
                limit_order_ask_side: false,
            }],
            false,
            false,
            DlmmFeeParameters {
                bin_step: 10,
                base_factor: 250,
                base_fee_power_factor: 0,
                variable_fee_control: 0,
                volatility_accumulator: 0,
            },
        )
        .unwrap();
        assert_eq!(quote.amount_out, 2_857_070);
        assert_eq!(quote.fee, 72);
    }

    #[test]
    fn dlmm_dynamic_fee_vector() {
        let parameters = DlmmFeeParameters {
            bin_step: 10,
            base_factor: 200,
            base_fee_power_factor: 0,
            variable_fee_control: 100,
            volatility_accumulator: 1_000,
        };
        assert_eq!(dlmm_total_fee_rate(parameters).unwrap(), 20_001);
        let quote = dlmm_quote_exact_in(
            5_000_000,
            &[Bin {
                price_q64: (1_u128 << 64) * 101 / 100,
                amount_x: 0,
                amount_y: 10_000_000,
                open_order_amount: 0,
                processed_order_remaining_amount: 0,
                limit_order_ask_side: false,
            }],
            true,
            true,
            parameters,
        )
        .unwrap();
        assert_eq!(quote.amount_out, 5_049_897);
        assert_eq!(quote.fee, 101);
    }

    #[test]
    fn dlmm_limit_order_liquidity_vector() {
        let quote = dlmm_quote_exact_in(
            250,
            &[Bin {
                price_q64: 1_u128 << 64,
                amount_x: 0,
                amount_y: 100,
                open_order_amount: 100,
                processed_order_remaining_amount: 100,
                limit_order_ask_side: false,
            }],
            true,
            true,
            DlmmFeeParameters {
                bin_step: 10,
                base_factor: 200,
                base_fee_power_factor: 0,
                variable_fee_control: 0,
                volatility_accumulator: 0,
            },
        )
        .unwrap();
        assert_eq!(quote.amount_out, 249);
        assert_eq!(quote.fee, 1);
    }
}
