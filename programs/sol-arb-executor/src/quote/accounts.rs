use crate::quote::{dlmm_quote_exact_in_partial, Bin, DlmmFeeParameters, QuoteError, QuoteResult};

const DISCRIMINATOR_LEN: usize = 8;
const BIN_SIZE: usize = 144;
const BIN_ARRAY_HEADER_SIZE: usize = 48;
pub const MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION: usize = 2;
pub const MAX_QUOTE_VISITED_BINS_PER_DIRECTION: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PumpPoolState {
    pub creator: [u8; 32],
    pub base_mint: [u8; 32],
    pub coin_creator: [u8; 32],
    pub virtual_quote_reserves: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PumpFees {
    pub lp_fee_bps: u16,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PumpFeeTier {
    pub market_cap_threshold: u128,
    pub fees: PumpFees,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PumpFeeConfig {
    pub flat_fees: PumpFees,
    pub tiers: Vec<PumpFeeTier>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DlmmStaticParameters {
    pub base_factor: u16,
    pub filter_period: u16,
    pub decay_period: u16,
    pub reduction_factor: u16,
    pub variable_fee_control: u32,
    pub max_volatility_accumulator: u32,
    pub protocol_share: u16,
    pub base_fee_power_factor: u8,
    pub function_type: u8,
    pub collect_fee_mode: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DlmmVariableParameters {
    pub volatility_accumulator: u32,
    pub volatility_reference: u32,
    pub index_reference: i32,
    pub last_update_timestamp: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LbPairState {
    pub static_parameters: DlmmStaticParameters,
    pub variable_parameters: DlmmVariableParameters,
    pub active_id: i32,
    pub bin_step: u16,
    pub bitmap: [u64; 16],
    pub rewards_are_empty: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedBinArray {
    pub index: i64,
    pub bins: Vec<(u8, Bin)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DlmmSnapshotQuote {
    pub quote: QuoteResult,
    pub used_array_indices: Vec<i64>,
}

fn bytes<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N], QuoteError> {
    data.get(offset..offset + N)
        .ok_or(QuoteError::InvalidInput)?
        .try_into()
        .map_err(|_| QuoteError::InvalidInput)
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, QuoteError> {
    Ok(u16::from_le_bytes(bytes(data, offset)?))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, QuoteError> {
    Ok(u32::from_le_bytes(bytes(data, offset)?))
}

fn read_i32(data: &[u8], offset: usize) -> Result<i32, QuoteError> {
    Ok(i32::from_le_bytes(bytes(data, offset)?))
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64, QuoteError> {
    Ok(u64::from_le_bytes(bytes(data, offset)?))
}

fn read_i64(data: &[u8], offset: usize) -> Result<i64, QuoteError> {
    Ok(i64::from_le_bytes(bytes(data, offset)?))
}

fn read_u128(data: &[u8], offset: usize) -> Result<u128, QuoteError> {
    Ok(u128::from_le_bytes(bytes(data, offset)?))
}

fn parse_fees(data: &[u8], offset: usize) -> Result<PumpFees, QuoteError> {
    Ok(PumpFees {
        lp_fee_bps: read_u64(data, offset)?
            .try_into()
            .map_err(|_| QuoteError::InvalidInput)?,
        protocol_fee_bps: read_u64(data, offset + 8)?
            .try_into()
            .map_err(|_| QuoteError::InvalidInput)?,
        creator_fee_bps: read_u64(data, offset + 16)?
            .try_into()
            .map_err(|_| QuoteError::InvalidInput)?,
    })
}

pub fn parse_pump_pool(data: &[u8]) -> Result<PumpPoolState, QuoteError> {
    let virtual_reserves = i128::from_le_bytes(bytes(data, 245)?);
    Ok(PumpPoolState {
        creator: bytes(data, 11)?,
        base_mint: bytes(data, 43)?,
        coin_creator: bytes(data, 211)?,
        virtual_quote_reserves: virtual_reserves
            .try_into()
            .map_err(|_| QuoteError::InvalidInput)?,
    })
}

pub fn parse_pump_global_fees(data: &[u8]) -> Result<PumpFees, QuoteError> {
    Ok(PumpFees {
        lp_fee_bps: read_u64(data, 40)?
            .try_into()
            .map_err(|_| QuoteError::InvalidInput)?,
        protocol_fee_bps: read_u64(data, 48)?
            .try_into()
            .map_err(|_| QuoteError::InvalidInput)?,
        creator_fee_bps: read_u64(data, 313)?
            .try_into()
            .map_err(|_| QuoteError::InvalidInput)?,
    })
}

pub fn parse_pump_fee_config(data: &[u8]) -> Result<PumpFeeConfig, QuoteError> {
    let flat_offset = DISCRIMINATOR_LEN + 1 + 32;
    let tier_count = read_u32(data, flat_offset + 24)? as usize;
    let tiers_offset = flat_offset + 28;
    let available_tiers = data.len().saturating_sub(tiers_offset) / 40;
    if tier_count == 0 || tier_count > available_tiers || tier_count > 64 {
        return Err(QuoteError::InvalidInput);
    }
    let mut tiers = Vec::with_capacity(tier_count);
    let mut offset = tiers_offset;
    for _ in 0..tier_count {
        tiers.push(PumpFeeTier {
            market_cap_threshold: read_u128(data, offset)?,
            fees: parse_fees(data, offset + 16)?,
        });
        offset = offset.checked_add(40).ok_or(QuoteError::MathOverflow)?;
    }
    Ok(PumpFeeConfig {
        flat_fees: parse_fees(data, flat_offset)?,
        tiers,
    })
}

pub fn select_pump_fees(
    config: Option<&PumpFeeConfig>,
    global: PumpFees,
    is_pump_pool: bool,
    mint_supply: u64,
    base_reserve: u64,
    effective_quote_reserve: u64,
) -> Result<PumpFees, QuoteError> {
    let Some(config) = config else {
        return Ok(global);
    };
    if !is_pump_pool {
        return Ok(config.flat_fees);
    }
    if base_reserve == 0 || config.tiers.is_empty() {
        return Err(QuoteError::InvalidInput);
    }
    let market_cap = u128::from(effective_quote_reserve)
        .checked_mul(u128::from(mint_supply))
        .ok_or(QuoteError::MathOverflow)?
        / u128::from(base_reserve);
    let mut selected = config.tiers[0].fees;
    for tier in &config.tiers {
        if market_cap >= tier.market_cap_threshold {
            selected = tier.fees;
        }
    }
    Ok(selected)
}

pub fn select_pump_fees_from_data(
    data: &[u8],
    global: PumpFees,
    is_pump_pool: bool,
    mint_supply: u64,
    base_reserve: u64,
    effective_quote_reserve: u64,
) -> Result<PumpFees, QuoteError> {
    let flat_offset = DISCRIMINATOR_LEN + 1 + 32;
    let flat_fees = parse_fees(data, flat_offset)?;
    if !is_pump_pool {
        return Ok(flat_fees);
    }
    if base_reserve == 0 {
        return Err(QuoteError::InvalidInput);
    }
    let tier_count = read_u32(data, flat_offset + 24)? as usize;
    let tiers_offset = flat_offset + 28;
    let available_tiers = data.len().saturating_sub(tiers_offset) / 40;
    if tier_count == 0 || tier_count > available_tiers || tier_count > 64 {
        return if tier_count == 0 {
            Ok(global)
        } else {
            Err(QuoteError::InvalidInput)
        };
    }
    let market_cap = u128::from(effective_quote_reserve)
        .checked_mul(u128::from(mint_supply))
        .ok_or(QuoteError::MathOverflow)?
        / u128::from(base_reserve);
    let mut selected = parse_fees(data, tiers_offset + 16)?;
    for tier_index in 0..tier_count {
        let offset = tiers_offset
            .checked_add(tier_index.checked_mul(40).ok_or(QuoteError::MathOverflow)?)
            .ok_or(QuoteError::MathOverflow)?;
        if market_cap >= read_u128(data, offset)? {
            selected = parse_fees(data, offset + 16)?;
        }
    }
    Ok(selected)
}

pub fn token_amount(data: &[u8]) -> Result<u64, QuoteError> {
    read_u64(data, 64)
}

pub fn mint_supply(data: &[u8]) -> Result<u64, QuoteError> {
    read_u64(data, 36)
}

pub fn parse_lb_pair(data: &[u8]) -> Result<LbPairState, QuoteError> {
    let base = DISCRIMINATOR_LEN;
    let static_parameters = DlmmStaticParameters {
        base_factor: read_u16(data, base)?,
        filter_period: read_u16(data, base + 2)?,
        decay_period: read_u16(data, base + 4)?,
        reduction_factor: read_u16(data, base + 6)?,
        variable_fee_control: read_u32(data, base + 8)?,
        max_volatility_accumulator: read_u32(data, base + 12)?,
        protocol_share: read_u16(data, base + 24)?,
        base_fee_power_factor: *data.get(base + 26).ok_or(QuoteError::InvalidInput)?,
        function_type: *data.get(base + 27).ok_or(QuoteError::InvalidInput)?,
        collect_fee_mode: *data.get(base + 28).ok_or(QuoteError::InvalidInput)?,
    };
    let variable_base = base + 32;
    let variable_parameters = DlmmVariableParameters {
        volatility_accumulator: read_u32(data, variable_base)?,
        volatility_reference: read_u32(data, variable_base + 4)?,
        index_reference: read_i32(data, variable_base + 8)?,
        last_update_timestamp: read_i64(data, variable_base + 16)?,
    };
    let mut bitmap = [0_u64; 16];
    let bitmap_base = base + 576;
    for (index, word) in bitmap.iter_mut().enumerate() {
        *word = read_u64(data, bitmap_base + index * 8)?;
    }
    let first_reward_mint: [u8; 32] = bytes(data, base + 256)?;
    let second_reward_mint: [u8; 32] = bytes(data, base + 400)?;
    Ok(LbPairState {
        static_parameters,
        variable_parameters,
        active_id: read_i32(data, base + 68)?,
        bin_step: read_u16(data, base + 72)?,
        bitmap,
        rewards_are_empty: first_reward_mint == [0; 32] && second_reward_mint == [0; 32],
    })
}

pub fn parse_bin_array(data: &[u8]) -> Result<ParsedBinArray, QuoteError> {
    let index = parse_bin_array_index(data)?;
    let bins_base = DISCRIMINATOR_LEN + BIN_ARRAY_HEADER_SIZE;
    let mut bins = Vec::with_capacity(70);
    for bin_index in 0..70 {
        bins.push((bin_index as u8, parse_bin(data, bins_base, bin_index)?));
    }
    Ok(ParsedBinArray { index, bins })
}

pub fn parse_bin_array_window(data: &[u8], active_id: i32) -> Result<ParsedBinArray, QuoteError> {
    let index = parse_bin_array_index(data)?;
    let bins_base = DISCRIMINATOR_LEN + BIN_ARRAY_HEADER_SIZE;
    let lower = active_id.saturating_sub((MAX_QUOTE_VISITED_BINS_PER_DIRECTION - 1) as i32);
    let upper = active_id.saturating_add((MAX_QUOTE_VISITED_BINS_PER_DIRECTION - 1) as i32);
    let mut bins = Vec::with_capacity(MAX_QUOTE_VISITED_BINS_PER_DIRECTION * 2 - 1);
    for bin_index in 0..70 {
        let absolute_id = index
            .checked_mul(70)
            .and_then(|value| value.checked_add(bin_index as i64))
            .ok_or(QuoteError::MathOverflow)?;
        if absolute_id >= i64::from(lower) && absolute_id <= i64::from(upper) {
            bins.push((bin_index as u8, parse_bin(data, bins_base, bin_index)?));
        }
    }
    Ok(ParsedBinArray { index, bins })
}

fn parse_bin(data: &[u8], bins_base: usize, bin_index: usize) -> Result<Bin, QuoteError> {
    let offset = bins_base
        .checked_add(
            bin_index
                .checked_mul(BIN_SIZE)
                .ok_or(QuoteError::MathOverflow)?,
        )
        .ok_or(QuoteError::MathOverflow)?;
    Ok(Bin {
        amount_x: read_u64(data, offset)?,
        amount_y: read_u64(data, offset + 8)?,
        price_q64: read_u128(data, offset + 16)?,
        open_order_amount: read_u64(data, offset + 112)?,
        processed_order_remaining_amount: read_u64(data, offset + 128)?,
        limit_order_ask_side: *data.get(offset + 140).ok_or(QuoteError::InvalidInput)? != 0,
    })
}

pub fn parse_bin_for_id(data: &[u8], bin_id: i32, array_index: i64) -> Result<Bin, QuoteError> {
    let bin_index = bin_offset(bin_id, array_index)?;
    parse_bin(data, DISCRIMINATOR_LEN + BIN_ARRAY_HEADER_SIZE, bin_index)
}

pub fn parse_bin_array_index(data: &[u8]) -> Result<i64, QuoteError> {
    read_i64(data, DISCRIMINATOR_LEN)
}

pub fn bin_array_index(bin_id: i32) -> i64 {
    i64::from(bin_id).div_euclid(70)
}

pub fn bin_offset(bin_id: i32, array_index: i64) -> Result<usize, QuoteError> {
    let offset = i64::from(bin_id)
        .checked_sub(
            array_index
                .checked_mul(70)
                .ok_or(QuoteError::MathOverflow)?,
        )
        .ok_or(QuoteError::MathOverflow)?;
    if !(0..70).contains(&offset) {
        return Err(QuoteError::InvalidInput);
    }
    offset.try_into().map_err(|_| QuoteError::InvalidInput)
}

pub fn default_bitmap_contains(bitmap: &[u64; 16], array_index: i64) -> bool {
    if !(-512..=511).contains(&array_index) {
        return false;
    }
    let bit = (array_index + 512) as usize;
    bitmap[bit / 64] & (1_u64 << (bit % 64)) != 0
}

pub fn extension_bitmap_contains(data: &[u8], array_index: i64) -> Result<bool, QuoteError> {
    const BITMAP_WORDS: i64 = 512;
    const EXTENSION_CHUNKS: i64 = 12;
    const HEADER: usize = 8 + 32;
    const SIDE_BYTES: usize = 12 * 8 * 8;
    if (-512..=511).contains(&array_index) {
        return Ok(false);
    }
    let (side_offset, chunk, bit) = if array_index >= 512 {
        let relative = array_index;
        (HEADER, relative / BITMAP_WORDS - 1, relative % BITMAP_WORDS)
    } else {
        let relative = array_index
            .checked_add(1)
            .ok_or(QuoteError::MathOverflow)?
            .checked_neg()
            .ok_or(QuoteError::MathOverflow)?;
        (
            HEADER + SIDE_BYTES,
            relative / BITMAP_WORDS - 1,
            relative % BITMAP_WORDS,
        )
    };
    if !(0..EXTENSION_CHUNKS).contains(&chunk) {
        return Ok(false);
    }
    let word = bit / 64;
    let word_bit = bit % 64;
    let offset = side_offset
        .checked_add((chunk as usize) * 64)
        .and_then(|value| value.checked_add((word as usize) * 8))
        .ok_or(QuoteError::MathOverflow)?;
    Ok(read_u64(data, offset)? & (1_u64 << word_bit) != 0)
}

pub fn update_reference(
    active_id: i32,
    variable: &mut DlmmVariableParameters,
    parameters: DlmmStaticParameters,
    timestamp: i64,
) {
    let elapsed = timestamp.saturating_sub(variable.last_update_timestamp);
    if elapsed >= i64::from(parameters.filter_period) {
        variable.index_reference = active_id;
        variable.volatility_reference = if elapsed < i64::from(parameters.decay_period) {
            (u64::from(variable.volatility_accumulator)
                .saturating_mul(u64::from(parameters.reduction_factor))
                / 10_000) as u32
        } else {
            0
        };
    }
}

pub fn update_volatility_accumulator(
    active_id: i32,
    variable: &mut DlmmVariableParameters,
    parameters: DlmmStaticParameters,
) {
    let delta = i64::from(variable.index_reference)
        .abs_diff(i64::from(active_id))
        .min(u64::from(u32::MAX)) as u32;
    variable.volatility_accumulator = variable
        .volatility_reference
        .saturating_add(delta.saturating_mul(10_000))
        .min(parameters.max_volatility_accumulator);
}

pub fn dlmm_fee_parameters(
    pair: &LbPairState,
    variable: DlmmVariableParameters,
) -> DlmmFeeParameters {
    DlmmFeeParameters {
        bin_step: pair.bin_step,
        base_factor: pair.static_parameters.base_factor,
        base_fee_power_factor: pair.static_parameters.base_fee_power_factor,
        variable_fee_control: pair.static_parameters.variable_fee_control,
        volatility_accumulator: variable.volatility_accumulator,
    }
}

pub fn fee_on_input(pair: &LbPairState, swap_for_y: bool) -> Result<bool, QuoteError> {
    match pair.static_parameters.collect_fee_mode {
        0 => Ok(true),
        1 => Ok(!swap_for_y),
        _ => Err(QuoteError::InvalidInput),
    }
}

pub fn supports_limit_orders(pair: &LbPairState) -> Result<bool, QuoteError> {
    match pair.static_parameters.function_type {
        2 => Ok(true),
        1 => Ok(false),
        0 => Ok(pair.rewards_are_empty),
        _ => Err(QuoteError::InvalidInput),
    }
}

pub fn quote_dlmm_snapshot(
    amount_in: u64,
    pair: &LbPairState,
    arrays: &[ParsedBinArray],
    swap_for_y: bool,
    timestamp: i64,
) -> Result<QuoteResult, QuoteError> {
    Ok(quote_dlmm_snapshot_with_arrays(amount_in, pair, arrays, swap_for_y, timestamp)?.quote)
}

pub fn quote_dlmm_snapshot_with_arrays(
    amount_in: u64,
    pair: &LbPairState,
    arrays: &[ParsedBinArray],
    swap_for_y: bool,
    timestamp: i64,
) -> Result<DlmmSnapshotQuote, QuoteError> {
    quote_dlmm_snapshot_with_bitmap(amount_in, pair, arrays, None, swap_for_y, timestamp)
}

pub fn quote_dlmm_snapshot_with_bitmap(
    amount_in: u64,
    pair: &LbPairState,
    arrays: &[ParsedBinArray],
    bitmap_extension: Option<&[u8]>,
    swap_for_y: bool,
    timestamp: i64,
) -> Result<DlmmSnapshotQuote, QuoteError> {
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
    let mut total_fee = 0_u64;
    let mut used_array_indices = Vec::with_capacity(2);
    let fee_on_input = fee_on_input(pair, swap_for_y)?;
    let supports_limit_orders = supports_limit_orders(pair)?;
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
                .transpose()?
                .unwrap_or(false)
        };
        if !initialized {
            active_id = if swap_for_y {
                active_id.saturating_sub(1)
            } else {
                active_id.saturating_add(1)
            };
            continue;
        }
        let Some(array) = arrays.iter().find(|array| array.index == array_index) else {
            return Err(QuoteError::InsufficientLiquidity);
        };
        if used_array_indices.last() != Some(&array_index) {
            if used_array_indices.len() == MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION {
                return Err(QuoteError::InsufficientLiquidity);
            }
            used_array_indices.push(array_index);
        }
        let wanted_offset = bin_offset(active_id, array.index)? as u8;
        let mut bin = array
            .bins
            .iter()
            .find(|(offset, _)| *offset == wanted_offset)
            .map(|(_, bin)| *bin)
            .ok_or(QuoteError::InsufficientLiquidity)?;
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
        )?;
        remaining = remaining
            .checked_sub(partial.amount_in)
            .ok_or(QuoteError::MathOverflow)?;
        amount_out = amount_out
            .checked_add(partial.amount_out)
            .ok_or(QuoteError::MathOverflow)?;
        total_fee = total_fee
            .checked_add(partial.fee)
            .ok_or(QuoteError::MathOverflow)?;
        if remaining != 0 {
            active_id = if swap_for_y {
                active_id.saturating_sub(1)
            } else {
                active_id.saturating_add(1)
            };
        }
    }
    if remaining != 0 {
        return Err(QuoteError::InsufficientLiquidity);
    }
    Ok(DlmmSnapshotQuote {
        quote: QuoteResult {
            amount_in,
            amount_out,
            fee: total_fee,
        },
        used_array_indices,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quote::{pump_buy_exact_quote_in, pump_sell_base_in};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/quote-parity-mainnet.json"
        ))
        .unwrap()
    }

    fn string<'a>(value: &'a Value, path: &[&str]) -> &'a str {
        let mut current = value;
        for key in path {
            current = &current[*key];
        }
        current.as_str().unwrap()
    }

    fn account(fixture: &Value, address: &str) -> Vec<u8> {
        let encoded = fixture["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|account| account["address"].as_str() == Some(address))
            .unwrap()["dataBase64"]
            .as_str()
            .unwrap();
        STANDARD.decode(encoded).unwrap()
    }

    #[test]
    fn reads_positive_and_negative_bitmap_extension_boundaries() {
        let mut data = vec![0_u8; 8 + 32 + 2 * 12 * 8 * 8];
        // Positive array index 512 => positive chunk 0, bit 0.
        data[40] = 1;
        // Negative array index -513 => negative chunk 0, bit 0.
        data[40 + 12 * 8 * 8] = 1;
        assert!(extension_bitmap_contains(&data, 512).unwrap());
        assert!(extension_bitmap_contains(&data, -513).unwrap());
        assert!(!extension_bitmap_contains(&data, 513).unwrap());
        assert!(!extension_bitmap_contains(&data, -514).unwrap());
        assert!(!extension_bitmap_contains(&data, 511).unwrap());
    }

    #[test]
    fn replays_both_routes_from_one_real_mainnet_snapshot() {
        let fixture = fixture();
        let addresses = &fixture["addresses"];
        let input: u64 = string(&fixture, &["inputLamports"]).parse().unwrap();
        let pool_data = account(&fixture, addresses["pumpPool"].as_str().unwrap());
        let global_data = account(&fixture, addresses["pumpGlobalConfig"].as_str().unwrap());
        let fee_config_data = account(&fixture, addresses["pumpFeeConfig"].as_str().unwrap());
        let mint_data = account(&fixture, addresses["targetMint"].as_str().unwrap());
        let base_vault_data = account(&fixture, addresses["pumpBaseVault"].as_str().unwrap());
        let quote_vault_data = account(&fixture, addresses["pumpQuoteVault"].as_str().unwrap());
        let pair_data = account(&fixture, addresses["meteoraPool"].as_str().unwrap());

        let pool = parse_pump_pool(&pool_data).unwrap();
        let base_reserve = token_amount(&base_vault_data).unwrap();
        let quote_reserve = token_amount(&quote_vault_data).unwrap();
        let supply = mint_supply(&mint_data).unwrap();
        let fees = select_pump_fees(
            Some(&parse_pump_fee_config(&fee_config_data).unwrap()),
            parse_pump_global_fees(&global_data).unwrap(),
            true,
            supply,
            base_reserve,
            quote_reserve + pool.virtual_quote_reserves,
        )
        .unwrap();
        let streaming_fees = select_pump_fees_from_data(
            &fee_config_data,
            parse_pump_global_fees(&global_data).unwrap(),
            true,
            supply,
            base_reserve,
            quote_reserve + pool.virtual_quote_reserves,
        )
        .unwrap();
        assert_eq!(streaming_fees, fees);
        let pump_buy = pump_buy_exact_quote_in(
            input,
            base_reserve,
            quote_reserve,
            pool.virtual_quote_reserves,
            fees.lp_fee_bps,
            fees.protocol_fee_bps,
            fees.creator_fee_bps,
        )
        .unwrap();
        assert_eq!(
            pump_buy.amount_out.to_string(),
            string(&fixture, &["expected", "pumpBuyTargetOut"])
        );

        let pair = parse_lb_pair(&pair_data).unwrap();
        let forward_arrays: Vec<_> = addresses["forwardBinArrays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|address| parse_bin_array(&account(&fixture, address.as_str().unwrap())).unwrap())
            .collect();
        let reverse_arrays: Vec<_> = addresses["reverseBinArrays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|address| parse_bin_array(&account(&fixture, address.as_str().unwrap())).unwrap())
            .collect();
        let timestamp = fixture["quoteTimestampMs"].as_i64().unwrap() / 1_000;
        let forward =
            quote_dlmm_snapshot(pump_buy.amount_out, &pair, &forward_arrays, true, timestamp)
                .unwrap();
        assert_eq!(
            forward.amount_out.to_string(),
            string(&fixture, &["expected", "forwardDlmmWsolOut"])
        );

        let reverse = quote_dlmm_snapshot(input, &pair, &reverse_arrays, false, timestamp).unwrap();
        assert_eq!(
            reverse.amount_out.to_string(),
            string(&fixture, &["expected", "reverseDlmmTargetOut"])
        );
        let pump_sell = pump_sell_base_in(
            reverse.amount_out,
            base_reserve,
            quote_reserve,
            pool.virtual_quote_reserves,
            fees.lp_fee_bps,
            fees.protocol_fee_bps,
            fees.creator_fee_bps,
        )
        .unwrap();
        assert_eq!(
            pump_sell.amount_out.to_string(),
            string(&fixture, &["expected", "pumpSellWsolOut"])
        );
    }
}
