use anchor_lang::prelude::*;

use crate::{
    constants::PUMP_PROGRAM_ID,
    errors::ArbError,
    events::{DynamicAmountSelected, RouteDirection},
    instructions::{best_direction, meteora_to_pump, pump_to_meteora, ExecuteRoute},
    quote::{
        bin_array_index, default_bitmap_contains, dlmm_bin_output_within_capacity,
        dlmm_bin_quote_capacity, dlmm_fee_parameters, dlmm_total_fee_rate,
        extension_bitmap_contains, fee_on_input, parse_bin_array_index, parse_bin_for_id,
        parse_lb_pair, parse_pump_global_fees, parse_pump_pool, pump_buy_exact_quote_in,
        pump_sell_base_in, select_pump_fees_from_data, supports_limit_orders, token_amount,
        LbPairState, PumpFees, QuoteError, MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION,
        MAX_QUOTE_VISITED_BINS_PER_DIRECTION,
    },
};

const PUMP_FEE_DENOMINATOR: u128 = 10_000;
const INTERIOR_NEIGHBORHOOD: u64 = 1;
const MAX_DYNAMIC_CANDIDATES: usize = 2 + MAX_QUOTE_VISITED_BINS_PER_DIRECTION * 4;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Eq, PartialEq)]
pub struct BestDirectionDynamicArgs {
    pub min_wsol_amount_in: u64,
    pub max_wsol_amount_in: u64,
    pub min_profit_lamports: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SelectedDirection {
    PumpToMeteora,
    MeteoraToPump,
}

impl SelectedDirection {
    fn event_direction(self) -> RouteDirection {
        match self {
            Self::PumpToMeteora => RouteDirection::PumpToMeteora,
            Self::MeteoraToPump => RouteDirection::MeteoraToPump,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct DlmmSegment {
    input_start: u64,
    input_end: u64,
    output_start: u64,
    output_end: u64,
    price_q64: u128,
    fee_rate: u64,
    swap_for_y: bool,
    fee_on_input: bool,
    used_indices: [i64; MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION],
    used_len: usize,
}

impl DlmmSegment {
    const EMPTY: Self = Self {
        input_start: 0,
        input_end: 0,
        output_start: 0,
        output_end: 0,
        price_q64: 0,
        fee_rate: 0,
        swap_for_y: false,
        fee_on_input: false,
        used_indices: [0; MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION],
        used_len: 0,
    };

    fn input_capacity(self) -> u64 {
        self.input_end - self.input_start
    }

    fn output_capacity(self) -> u64 {
        self.output_end - self.output_start
    }
}

#[derive(Clone, Debug)]
struct DlmmCurve {
    segments: [DlmmSegment; MAX_QUOTE_VISITED_BINS_PER_DIRECTION],
    len: usize,
    visited_bins: u8,
    stop_reason: CurveStopReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CurveStopReason {
    InputLimitReached,
    MissingBinArray,
    BinArrayLimitReached,
    VisitedBinLimitReached,
    NoUsableLiquidity,
}

impl CurveStopReason {
    const fn code(self) -> u8 {
        match self {
            Self::InputLimitReached => 0,
            Self::MissingBinArray => 1,
            Self::BinArrayLimitReached => 2,
            Self::VisitedBinLimitReached => 3,
            Self::NoUsableLiquidity => 4,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct CurveQuote {
    amount_out: u64,
    used_indices: [i64; MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION],
    used_len: usize,
}

impl DlmmCurve {
    fn new() -> Self {
        Self {
            segments: [DlmmSegment::EMPTY; MAX_QUOTE_VISITED_BINS_PER_DIRECTION],
            len: 0,
            visited_bins: 0,
            stop_reason: CurveStopReason::VisitedBinLimitReached,
        }
    }

    fn clear(&mut self) {
        self.len = 0;
        self.visited_bins = 0;
        self.stop_reason = CurveStopReason::VisitedBinLimitReached;
    }

    fn push(&mut self, segment: DlmmSegment) -> Result<()> {
        require!(
            self.len < self.segments.len(),
            ArbError::BestDirectionQuoteIncomplete
        );
        self.segments[self.len] = segment;
        self.len += 1;
        Ok(())
    }

    fn as_slice(&self) -> &[DlmmSegment] {
        &self.segments[..self.len]
    }

    fn largest_complete_input(&self) -> u64 {
        self.as_slice()
            .last()
            .map(|segment| segment.input_end)
            .unwrap_or(0)
    }

    fn quote(&self, amount_in: u64) -> std::result::Result<CurveQuote, QuoteError> {
        if amount_in == 0 {
            return Err(QuoteError::InvalidInput);
        }
        let segment = self
            .as_slice()
            .iter()
            .find(|segment| amount_in <= segment.input_end)
            .ok_or(QuoteError::InsufficientLiquidity)?;
        let remaining = amount_in
            .checked_sub(segment.input_start)
            .ok_or(QuoteError::MathOverflow)?;
        let amount_out = if remaining == 0 {
            segment.output_start
        } else {
            segment
                .output_start
                .checked_add(dlmm_bin_output_within_capacity(
                    remaining,
                    segment.input_capacity(),
                    segment.output_capacity(),
                    segment.price_q64,
                    segment.swap_for_y,
                    segment.fee_on_input,
                    u128::from(segment.fee_rate),
                )?)
                .ok_or(QuoteError::MathOverflow)?
        };
        Ok(CurveQuote {
            amount_out,
            used_indices: segment.used_indices,
            used_len: segment.used_len,
        })
    }
}

#[derive(Clone, Debug)]
struct MarketState {
    pump_base_reserve: u64,
    pump_quote_reserve: u64,
    pump_virtual_quote_reserve: u64,
    pump_fees: PumpFees,
    pair: LbPairState,
    target_is_x: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectionChoice {
    amount_in: u64,
    amount_out: u64,
    profit: u64,
    used_indices: [i64; MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION],
    used_len: usize,
}

#[derive(Clone, Debug)]
struct DirectionSearch {
    best: Option<DirectionChoice>,
    complete_seen: bool,
    largest_complete_amount: u64,
    boundary_candidates: u8,
    interior_candidates: u8,
    visited_bins: u8,
    curve_stop_reason: CurveStopReason,
}

#[derive(Clone, Copy, Debug)]
struct DynamicSelection {
    direction: SelectedDirection,
    choice: DirectionChoice,
    largest_complete_amount: u64,
    boundary_candidates: u8,
    interior_candidates: u8,
    visited_bins: u8,
}

#[derive(Clone, Copy, Debug)]
struct DynamicSearchBounds {
    min_amount: u64,
    max_amount: u64,
    min_profit: u64,
}

#[derive(Clone, Copy, Debug)]
struct CandidateEvaluationContext {
    min_amount: u64,
    min_profit: u64,
    largest_complete_amount: u64,
    visited_bins: u8,
    boundary_candidates: u8,
    interior_candidates: u8,
    curve_stop_reason: CurveStopReason,
}

#[derive(Clone, Debug)]
struct CandidateAmounts {
    values: [u64; MAX_DYNAMIC_CANDIDATES],
    len: usize,
}

impl CandidateAmounts {
    fn new() -> Self {
        Self {
            values: [0; MAX_DYNAMIC_CANDIDATES],
            len: 0,
        }
    }

    fn push_unique(&mut self, amount: u64) {
        if amount == 0 || self.values[..self.len].contains(&amount) {
            return;
        }
        debug_assert!(self.len < self.values.len());
        if self.len < self.values.len() {
            self.values[self.len] = amount;
            self.len += 1;
        }
    }

    fn as_slice(&self) -> &[u64] {
        &self.values[..self.len]
    }
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
    args: BestDirectionDynamicArgs,
) -> Result<()> {
    validate_args(&args)?;
    ctx.accounts.validate_route_mints()?;
    best_direction::validate_quote_accounts(ctx.accounts, ctx.remaining_accounts)?;

    let balance_limited_max = args.max_wsol_amount_in.min(ctx.accounts.user_wsol.amount);
    require!(
        balance_limited_max >= args.min_wsol_amount_in,
        ArbError::InvalidDynamicAmountRange
    );
    let timestamp = Clock::get()?.unix_timestamp;
    let selection = select_dynamic(
        ctx.accounts,
        ctx.remaining_accounts,
        args.min_wsol_amount_in,
        balance_limited_max,
        args.min_profit_lamports,
        timestamp,
    )?;
    require!(
        selection.choice.amount_in >= args.min_wsol_amount_in
            && selection.choice.amount_in <= balance_limited_max,
        ArbError::InvalidDynamicAmountRange
    );
    let selected_bin_arrays = best_direction::ordered_bin_arrays(
        ctx.remaining_accounts,
        &selection.choice.used_indices[..selection.choice.used_len],
    )?;

    emit!(DynamicAmountSelected {
        direction: selection.direction.event_direction(),
        min_wsol_amount_in: args.min_wsol_amount_in,
        max_wsol_amount_in: args.max_wsol_amount_in,
        balance_limited_max,
        largest_complete_amount: selection.largest_complete_amount,
        actual_wsol_amount_in: selection.choice.amount_in,
        expected_wsol_amount_out: selection.choice.amount_out,
        expected_profit_lamports: selection.choice.profit,
        visited_bins: selection.visited_bins,
        boundary_candidates: selection.boundary_candidates,
        interior_candidates: selection.interior_candidates,
        // V1 always completes the existing bounded 16-bin traversal. A future
        // monotonicity-proven stop may set this flag without changing the ABI.
        early_stop_used: false,
    });

    match selection.direction {
        SelectedDirection::PumpToMeteora => pump_to_meteora::execute(
            ctx.accounts,
            &selected_bin_arrays,
            selection.choice.amount_in,
            args.min_profit_lamports,
        ),
        SelectedDirection::MeteoraToPump => meteora_to_pump::execute(
            ctx.accounts,
            &selected_bin_arrays,
            selection.choice.amount_in,
            args.min_profit_lamports,
        ),
    }
}

fn validate_args(args: &BestDirectionDynamicArgs) -> Result<()> {
    require!(
        args.min_wsol_amount_in > 0
            && args.max_wsol_amount_in >= args.min_wsol_amount_in
            && args.min_profit_lamports > 0,
        ArbError::InvalidDynamicAmountRange
    );
    Ok(())
}

fn select_dynamic(
    accounts: &ExecuteRoute<'_>,
    bin_array_accounts: &[AccountInfo<'_>],
    min_amount: u64,
    max_amount: u64,
    min_profit: u64,
    timestamp: i64,
) -> Result<DynamicSelection> {
    let market = parse_market(accounts)?;
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
    let bounds = DynamicSearchBounds {
        min_amount,
        max_amount,
        min_profit,
    };

    // Build and search each direction in its own non-inlined frame. This keeps
    // the bounded 16-bin curve off the SBF heap without combining it with the
    // caller's Anchor account frame (whose per-frame limit is 4 KiB).
    let forward = search_forward_direction(
        bin_array_accounts,
        bitmap_extension,
        market.target_is_x,
        timestamp,
        &market,
        bounds,
    )?;

    let cashback_sell_is_ready =
        crate::adapters::pump_swap::cashback_sell_is_ready(&accounts.pump_accounts())?;
    let reverse = if cashback_sell_is_ready {
        search_reverse_direction(
            bin_array_accounts,
            bitmap_extension,
            !market.target_is_x,
            timestamp,
            &market,
            bounds,
        )?
    } else {
        DirectionSearch {
            best: None,
            complete_seen: false,
            largest_complete_amount: 0,
            boundary_candidates: 0,
            interior_candidates: 0,
            visited_bins: 0,
            curve_stop_reason: CurveStopReason::NoUsableLiquidity,
        }
    };

    if !forward.complete_seen && !reverse.complete_seen {
        msg!(
            "dynamic_quote_incomplete forward_stop={} forward_cap={} forward_bins={} reverse_stop={} reverse_cap={} reverse_bins={}",
            forward.curve_stop_reason.code(),
            forward.largest_complete_amount,
            forward.visited_bins,
            reverse.curve_stop_reason.code(),
            reverse.largest_complete_amount,
            reverse.visited_bins,
        );
        return err!(ArbError::BestDirectionQuoteIncomplete);
    }
    let (direction, selected) = match (forward.best, reverse.best) {
        (Some(forward_choice), Some(reverse_choice)) => {
            if better_choice(reverse_choice, forward_choice) {
                (SelectedDirection::MeteoraToPump, reverse_choice)
            } else {
                (SelectedDirection::PumpToMeteora, forward_choice)
            }
        }
        (Some(choice), None) => (SelectedDirection::PumpToMeteora, choice),
        (None, Some(choice)) => (SelectedDirection::MeteoraToPump, choice),
        (None, None) => return err!(ArbError::NoProfitableDirection),
    };
    let stats = match direction {
        SelectedDirection::PumpToMeteora => &forward,
        SelectedDirection::MeteoraToPump => &reverse,
    };
    Ok(DynamicSelection {
        direction,
        choice: selected,
        largest_complete_amount: stats.largest_complete_amount,
        boundary_candidates: stats.boundary_candidates,
        interior_candidates: stats.interior_candidates,
        visited_bins: stats.visited_bins,
    })
}

#[inline(never)]
fn search_forward_direction(
    bin_array_accounts: &[AccountInfo<'_>],
    bitmap_extension: Option<&[u8]>,
    swap_for_y: bool,
    timestamp: i64,
    market: &MarketState,
    bounds: DynamicSearchBounds,
) -> Result<DirectionSearch> {
    // Materialize only the part of the DLMM curve that the configured WSOL
    // upper bound can reach. Later bins cannot affect any legal candidate.
    let forward_input_limit = pump_buy_amount_out(market, bounds.max_amount).unwrap_or(u64::MAX);
    let mut curve = DlmmCurve::new();
    build_curve(
        &mut curve,
        &market.pair,
        bin_array_accounts,
        bitmap_extension,
        swap_for_y,
        timestamp,
        forward_input_limit,
    )?;
    Ok(search_forward(
        market,
        &curve,
        bounds.min_amount,
        bounds.max_amount,
        bounds.min_profit,
    ))
}

#[inline(never)]
fn search_reverse_direction(
    bin_array_accounts: &[AccountInfo<'_>],
    bitmap_extension: Option<&[u8]>,
    swap_for_y: bool,
    timestamp: i64,
    market: &MarketState,
    bounds: DynamicSearchBounds,
) -> Result<DirectionSearch> {
    let mut curve = DlmmCurve::new();
    build_curve(
        &mut curve,
        &market.pair,
        bin_array_accounts,
        bitmap_extension,
        swap_for_y,
        timestamp,
        bounds.max_amount,
    )?;
    Ok(search_reverse(
        market,
        &curve,
        bounds.min_amount,
        bounds.max_amount,
        bounds.min_profit,
    ))
}

fn parse_market(accounts: &ExecuteRoute<'_>) -> Result<MarketState> {
    let pool_data = accounts.pump_pool.try_borrow_data()?;
    let global_data = accounts.pump_global_config.try_borrow_data()?;
    let fee_config_data = accounts.pump_fee_config.try_borrow_data()?;
    let base_vault_data = accounts.pump_pool_base_token_account.try_borrow_data()?;
    let quote_vault_data = accounts.pump_pool_quote_token_account.try_borrow_data()?;
    let pair_data = accounts.meteora_lb_pair.try_borrow_data()?;
    let pool = parse_pump_pool(&pool_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let pump_base_reserve =
        token_amount(&base_vault_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let pump_quote_reserve =
        token_amount(&quote_vault_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let effective_quote_reserve = pump_quote_reserve
        .checked_add(pool.virtual_quote_reserves)
        .ok_or_else(|| error!(ArbError::ArithmeticOverflow))?;
    let creator = Pubkey::new_from_array(pool.creator);
    let expected_pump_creator = Pubkey::find_program_address(
        &[b"pool-authority", accounts.target_mint.key().as_ref()],
        &PUMP_PROGRAM_ID,
    )
    .0;
    let mut pump_fees = select_pump_fees_from_data(
        &fee_config_data,
        parse_pump_global_fees(&global_data).map_err(|_| error!(ArbError::InvalidAccountData))?,
        creator == expected_pump_creator,
        accounts.target_mint.supply,
        pump_base_reserve,
        effective_quote_reserve,
    )
    .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    if pool.coin_creator == [0; 32] {
        pump_fees.creator_fee_bps = 0;
    }
    let pair = parse_lb_pair(&pair_data).map_err(|_| error!(ArbError::InvalidAccountData))?;
    let target_is_x = crate::utils::account_validation::parse_meteora_pair(&pair_data)?
        .token_x_mint
        == accounts.target_mint.key();
    Ok(MarketState {
        pump_base_reserve,
        pump_quote_reserve,
        pump_virtual_quote_reserve: pool.virtual_quote_reserves,
        pump_fees,
        pair,
        target_is_x,
    })
}

fn build_curve(
    curve: &mut DlmmCurve,
    pair: &LbPairState,
    arrays: &[AccountInfo<'_>],
    bitmap_extension: Option<&[u8]>,
    swap_for_y: bool,
    timestamp: i64,
    input_limit: u64,
) -> Result<()> {
    curve.clear();
    let mut variable = pair.variable_parameters;
    crate::quote::update_reference(
        pair.active_id,
        &mut variable,
        pair.static_parameters,
        timestamp,
    );
    let fee_on_input = fee_on_input(pair, swap_for_y)
        .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    let supports_limit_orders =
        supports_limit_orders(pair).map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
    let mut active_id = pair.active_id;
    let mut total_in = 0_u64;
    let mut total_out = 0_u64;
    let mut used_indices = [0_i64; MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION];
    let mut used_len = 0_usize;
    let mut visited_bins = 0_u8;
    let mut stop_reason = CurveStopReason::VisitedBinLimitReached;

    for _ in 0..MAX_QUOTE_VISITED_BINS_PER_DIRECTION {
        visited_bins = visited_bins.saturating_add(1);
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
        let Some(account) = arrays.iter().find(|account| {
            account
                .try_borrow_data()
                .ok()
                .and_then(|data| parse_bin_array_index(&data).ok())
                == Some(array_index)
        }) else {
            stop_reason = CurveStopReason::MissingBinArray;
            break;
        };
        if used_len == 0 || used_indices[used_len - 1] != array_index {
            if used_len == MAX_QUOTE_BIN_ARRAYS_PER_DIRECTION {
                stop_reason = CurveStopReason::BinArrayLimitReached;
                break;
            }
            used_indices[used_len] = array_index;
            used_len += 1;
        }
        let mut bin = parse_bin_for_id(&account.try_borrow_data()?, active_id, array_index)
            .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
        if !supports_limit_orders {
            bin.open_order_amount = 0;
            bin.processed_order_remaining_amount = 0;
        }
        crate::quote::update_volatility_accumulator(
            active_id,
            &mut variable,
            pair.static_parameters,
        );
        let parameters = dlmm_fee_parameters(pair, variable);
        let fee_rate: u64 = dlmm_total_fee_rate(parameters)
            .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?
            .try_into()
            .map_err(|_| error!(ArbError::BestDirectionQuoteIncomplete))?;
        match dlmm_bin_quote_capacity(&bin, swap_for_y, fee_on_input, parameters) {
            Ok(capacity) => {
                let input_end = total_in
                    .checked_add(capacity.amount_in)
                    .ok_or_else(|| error!(ArbError::ArithmeticOverflow))?;
                let output_end = total_out
                    .checked_add(capacity.amount_out)
                    .ok_or_else(|| error!(ArbError::ArithmeticOverflow))?;
                curve.push(DlmmSegment {
                    input_start: total_in,
                    input_end,
                    output_start: total_out,
                    output_end,
                    price_q64: bin.price_q64,
                    fee_rate,
                    swap_for_y,
                    fee_on_input,
                    used_indices,
                    used_len,
                })?;
                total_in = input_end;
                total_out = output_end;
                if total_in >= input_limit {
                    stop_reason = CurveStopReason::InputLimitReached;
                    break;
                }
            }
            Err(QuoteError::InsufficientLiquidity) => {}
            Err(_) => return err!(ArbError::BestDirectionQuoteIncomplete),
        }
        active_id = next_bin(active_id, swap_for_y);
    }
    curve.visited_bins = visited_bins;
    curve.stop_reason =
        if curve.as_slice().is_empty() && stop_reason == CurveStopReason::VisitedBinLimitReached {
            CurveStopReason::NoUsableLiquidity
        } else {
            stop_reason
        };
    Ok(())
}

fn search_forward(
    market: &MarketState,
    curve: &DlmmCurve,
    min_amount: u64,
    max_amount: u64,
    min_profit: u64,
) -> DirectionSearch {
    let largest_complete_amount = largest_forward_complete_amount(market, curve, max_amount);
    if largest_complete_amount < min_amount {
        return incomplete_direction(curve, largest_complete_amount);
    }
    let mut candidates = CandidateAmounts::new();
    candidates.push_unique(min_amount);
    candidates.push_unique(largest_complete_amount);
    let mut boundary_candidates = 0_u8;
    let mut interior_candidates = 0_u8;
    let mut previous_segment_end_input = None;
    for segment in curve.as_slice() {
        let segment_start = if segment.input_start == 0 {
            1
        } else if let Some(value) = previous_segment_end_input {
            value
        } else if let Some(value) = pump_input_at_or_below_target_out(market, segment.input_start) {
            value
        } else {
            continue;
        };
        let Some(segment_end) = pump_input_at_or_below_target_out(market, segment.input_end) else {
            continue;
        };
        previous_segment_end_input = Some(segment_end);
        if segment_end < min_amount || segment_start > largest_complete_amount {
            continue;
        }
        if segment_end >= min_amount && segment_end <= largest_complete_amount {
            candidates.push_unique(segment_end);
            boundary_candidates = boundary_candidates.saturating_add(1);
        }
        if let Some(interior) =
            forward_interior_candidate(market, *segment, segment_start, segment_end)
        {
            if interior >= min_amount && interior <= largest_complete_amount {
                push_neighborhood(
                    &mut candidates,
                    interior,
                    min_amount,
                    largest_complete_amount,
                );
                interior_candidates = interior_candidates.saturating_add(1);
            }
        }
    }
    evaluate_candidates(
        candidates.as_slice(),
        CandidateEvaluationContext {
            min_amount,
            min_profit,
            largest_complete_amount,
            visited_bins: curve.visited_bins,
            boundary_candidates,
            interior_candidates,
            curve_stop_reason: curve.stop_reason,
        },
        |amount| evaluate_forward(market, curve, amount),
    )
}

fn search_reverse(
    market: &MarketState,
    curve: &DlmmCurve,
    min_amount: u64,
    max_amount: u64,
    min_profit: u64,
) -> DirectionSearch {
    let largest_complete_amount = max_amount.min(curve.largest_complete_input());
    if largest_complete_amount < min_amount {
        return incomplete_direction(curve, largest_complete_amount);
    }
    let mut candidates = CandidateAmounts::new();
    candidates.push_unique(min_amount);
    candidates.push_unique(largest_complete_amount);
    let mut boundary_candidates = 0_u8;
    let mut interior_candidates = 0_u8;
    for segment in curve.as_slice() {
        if segment.input_end < min_amount || segment.input_start > largest_complete_amount {
            continue;
        }
        if segment.input_end >= min_amount && segment.input_end <= largest_complete_amount {
            candidates.push_unique(segment.input_end);
            boundary_candidates = boundary_candidates.saturating_add(1);
        }
        if let Some(interior) = reverse_interior_candidate(market, *segment) {
            if interior >= min_amount && interior <= largest_complete_amount {
                push_neighborhood(
                    &mut candidates,
                    interior,
                    min_amount,
                    largest_complete_amount,
                );
                interior_candidates = interior_candidates.saturating_add(1);
            }
        }
    }
    evaluate_candidates(
        candidates.as_slice(),
        CandidateEvaluationContext {
            min_amount,
            min_profit,
            largest_complete_amount,
            visited_bins: curve.visited_bins,
            boundary_candidates,
            interior_candidates,
            curve_stop_reason: curve.stop_reason,
        },
        |amount| evaluate_reverse(market, curve, amount),
    )
}

fn evaluate_candidates<F>(
    candidates: &[u64],
    context: CandidateEvaluationContext,
    mut evaluate: F,
) -> DirectionSearch
where
    F: FnMut(u64) -> std::result::Result<CurveQuote, QuoteError>,
{
    let mut best = None;
    let mut complete_seen = false;
    for amount_in in candidates.iter().copied().filter(|amount| {
        *amount >= context.min_amount && *amount <= context.largest_complete_amount
    }) {
        let Ok(quote) = evaluate(amount_in) else {
            continue;
        };
        complete_seen = true;
        let Some(profit) = quote.amount_out.checked_sub(amount_in) else {
            continue;
        };
        if profit < context.min_profit {
            continue;
        }
        let candidate = DirectionChoice {
            amount_in,
            amount_out: quote.amount_out,
            profit,
            used_indices: quote.used_indices,
            used_len: quote.used_len,
        };
        if best.is_none_or(|current| better_choice(candidate, current)) {
            best = Some(candidate);
        }
    }
    DirectionSearch {
        best,
        complete_seen,
        largest_complete_amount: context.largest_complete_amount,
        boundary_candidates: context.boundary_candidates,
        interior_candidates: context.interior_candidates,
        visited_bins: context.visited_bins,
        curve_stop_reason: context.curve_stop_reason,
    }
}

fn incomplete_direction(curve: &DlmmCurve, largest_complete_amount: u64) -> DirectionSearch {
    DirectionSearch {
        best: None,
        complete_seen: false,
        largest_complete_amount,
        boundary_candidates: 0,
        interior_candidates: 0,
        visited_bins: curve.visited_bins,
        curve_stop_reason: curve.stop_reason,
    }
}

fn evaluate_forward(
    market: &MarketState,
    curve: &DlmmCurve,
    amount_in: u64,
) -> std::result::Result<CurveQuote, QuoteError> {
    let buy = pump_buy_exact_quote_in(
        amount_in,
        market.pump_base_reserve,
        market.pump_quote_reserve,
        market.pump_virtual_quote_reserve,
        market.pump_fees.lp_fee_bps,
        market.pump_fees.protocol_fee_bps,
        market.pump_fees.creator_fee_bps,
    )?;
    curve.quote(buy.amount_out)
}

fn evaluate_reverse(
    market: &MarketState,
    curve: &DlmmCurve,
    amount_in: u64,
) -> std::result::Result<CurveQuote, QuoteError> {
    let dlmm = curve.quote(amount_in)?;
    let sell = pump_sell_base_in(
        dlmm.amount_out,
        market.pump_base_reserve,
        market.pump_quote_reserve,
        market.pump_virtual_quote_reserve,
        market.pump_fees.lp_fee_bps,
        market.pump_fees.protocol_fee_bps,
        market.pump_fees.creator_fee_bps,
    )?;
    Ok(CurveQuote {
        amount_out: sell.amount_out,
        used_indices: dlmm.used_indices,
        used_len: dlmm.used_len,
    })
}

fn largest_forward_complete_amount(
    market: &MarketState,
    curve: &DlmmCurve,
    max_amount: u64,
) -> u64 {
    if evaluate_forward(market, curve, max_amount).is_ok() {
        return max_amount;
    }
    let capacity = curve.largest_complete_input();
    if capacity == 0 || max_amount == 0 {
        return 0;
    }

    // Pump output is monotonic in quote input. Search this cheap curve once;
    // the expensive DLMM traversal above is not replayed for each midpoint.
    let mut lower = 0_u64;
    let mut upper = max_amount;
    while lower < upper {
        let midpoint = lower + (upper - lower).div_ceil(2);
        if pump_buy_amount_out(market, midpoint).is_some_and(|output| output <= capacity) {
            lower = midpoint;
        } else {
            upper = midpoint - 1;
        }
    }
    lower
}

fn pump_input_at_or_below_target_out(market: &MarketState, target_out: u64) -> Option<u64> {
    if target_out == 0 || target_out >= market.pump_base_reserve {
        return None;
    }
    let effective_quote_reserve = u128::from(market.pump_quote_reserve)
        .checked_add(u128::from(market.pump_virtual_quote_reserve))?;
    let boundary_curve_input = div_ceil(
        u128::from(target_out).checked_mul(effective_quote_reserve)?,
        u128::from(market.pump_base_reserve.checked_sub(target_out)?),
    )?;
    let total_fee_bps = u128::from(pump_total_fee_bps(market)?);

    // `boundary_curve_input` is the first constant-product curve input that
    // can produce `target_out`. Pump subtracts one from its post-fee effective
    // quote before applying the curve. By targeting an effective quote no
    // greater than `boundary_curve_input`, this closed-form gross input stays
    // immediately below the DLMM segment boundary even after Pump's fee
    // rounding. Candidate evaluation later performs the exact Pump quote, so
    // this approximation changes only boundary sampling, never execution or
    // profit safety.
    let gross = boundary_curve_input
        .checked_mul(PUMP_FEE_DENOMINATOR.checked_add(total_fee_bps)?)?
        / PUMP_FEE_DENOMINATOR;
    let candidate: u64 = gross.try_into().ok()?;
    if candidate == 0 {
        return None;
    }
    pump_buy_amount_out(market, candidate)
        .is_some_and(|output| output < target_out)
        .then_some(candidate)
}

fn pump_buy_amount_out(market: &MarketState, amount_in: u64) -> Option<u64> {
    pump_buy_exact_quote_in(
        amount_in,
        market.pump_base_reserve,
        market.pump_quote_reserve,
        market.pump_virtual_quote_reserve,
        market.pump_fees.lp_fee_bps,
        market.pump_fees.protocol_fee_bps,
        market.pump_fees.creator_fee_bps,
    )
    .ok()
    .map(|quote| quote.amount_out)
}

fn forward_interior_candidate(
    market: &MarketState,
    segment: DlmmSegment,
    segment_start: u64,
    segment_end: u64,
) -> Option<u64> {
    let total_fee_bps = pump_total_fee_bps(market)?;
    let effective_quote_reserve = u128::from(market.pump_quote_reserve)
        .checked_add(u128::from(market.pump_virtual_quote_reserve))?;
    let root = sqrt_product_ratio(
        &[
            u128::from(segment.output_capacity()),
            u128::from(market.pump_base_reserve),
            PUMP_FEE_DENOMINATOR,
            effective_quote_reserve,
        ],
        &[
            u128::from(segment.input_capacity()),
            PUMP_FEE_DENOMINATOR.checked_add(u128::from(total_fee_bps))?,
        ],
    )?;
    if root <= effective_quote_reserve {
        return None;
    }
    let continuous_input = root
        .checked_sub(effective_quote_reserve)?
        .checked_mul(PUMP_FEE_DENOMINATOR.checked_add(u128::from(total_fee_bps))?)?
        / PUMP_FEE_DENOMINATOR;
    let candidate: u64 = continuous_input.try_into().ok()?;
    (candidate > segment_start && candidate < segment_end).then_some(candidate)
}

fn reverse_interior_candidate(market: &MarketState, segment: DlmmSegment) -> Option<u64> {
    let total_fee_bps = pump_total_fee_bps(market)?;
    if u128::from(total_fee_bps) >= PUMP_FEE_DENOMINATOR {
        return None;
    }
    let effective_quote_reserve = u128::from(market.pump_quote_reserve)
        .checked_add(u128::from(market.pump_virtual_quote_reserve))?;
    let root = sqrt_product_ratio(
        &[
            u128::from(segment.output_capacity()),
            effective_quote_reserve,
            u128::from(market.pump_base_reserve),
            PUMP_FEE_DENOMINATOR.checked_sub(u128::from(total_fee_bps))?,
        ],
        &[u128::from(segment.input_capacity()), PUMP_FEE_DENOMINATOR],
    )?;
    let target_at_optimum = root.checked_sub(u128::from(market.pump_base_reserve))?;
    if target_at_optimum <= u128::from(segment.output_start)
        || target_at_optimum >= u128::from(segment.output_end)
    {
        return None;
    }
    let target_delta = target_at_optimum.checked_sub(u128::from(segment.output_start))?;
    let input_delta = target_delta.checked_mul(u128::from(segment.input_capacity()))?
        / u128::from(segment.output_capacity());
    u128::from(segment.input_start)
        .checked_add(input_delta)?
        .try_into()
        .ok()
}

fn pump_total_fee_bps(market: &MarketState) -> Option<u64> {
    u64::from(market.pump_fees.lp_fee_bps)
        .checked_add(u64::from(market.pump_fees.protocol_fee_bps))?
        .checked_add(u64::from(market.pump_fees.creator_fee_bps))
}

fn better_choice(candidate: DirectionChoice, current: DirectionChoice) -> bool {
    candidate.profit > current.profit
        || (candidate.profit == current.profit && candidate.amount_in < current.amount_in)
}

fn push_neighborhood(candidates: &mut CandidateAmounts, amount: u64, min: u64, max: u64) {
    for candidate in [
        amount.saturating_sub(INTERIOR_NEIGHBORHOOD),
        amount,
        amount.saturating_add(INTERIOR_NEIGHBORHOOD),
    ] {
        if candidate >= min && candidate <= max {
            candidates.push_unique(candidate);
        }
    }
}

fn next_bin(active_id: i32, swap_for_y: bool) -> i32 {
    if swap_for_y {
        active_id.saturating_sub(1)
    } else {
        active_id.saturating_add(1)
    }
}

fn div_ceil(numerator: u128, denominator: u128) -> Option<u128> {
    if denominator == 0 {
        return None;
    }
    numerator
        .checked_add(denominator.checked_sub(1)?)?
        .checked_div(denominator)
}

/// A 64-bit normalized positive number represented as
/// `(mantissa / 2^63) * 2^exponent`. It provides enough precision for locating
/// an interior candidate while the exact quote still decides the winner.
#[derive(Clone, Copy, Debug)]
struct Normalized {
    mantissa: u64,
    exponent: i32,
}

impl Normalized {
    fn from_u128(value: u128) -> Option<Self> {
        if value == 0 {
            return None;
        }
        let bits = 128_i32.checked_sub(value.leading_zeros() as i32)?;
        let exponent = bits.checked_sub(1)?;
        let mantissa = if bits <= 64 {
            (value << (64 - bits)) as u64
        } else {
            (value >> (bits - 64)) as u64
        };
        Some(Self { mantissa, exponent })
    }

    fn multiply(self, other: Self) -> Option<Self> {
        let product = u128::from(self.mantissa).checked_mul(u128::from(other.mantissa))?;
        let mut mantissa = product >> 63;
        let mut exponent = self.exponent.checked_add(other.exponent)?;
        if mantissa >= (1_u128 << 64) {
            mantissa >>= 1;
            exponent = exponent.checked_add(1)?;
        }
        Some(Self {
            mantissa: mantissa.try_into().ok()?,
            exponent,
        })
    }

    fn divide(self, other: Self) -> Option<Self> {
        let mut quotient = (u128::from(self.mantissa) << 63) / u128::from(other.mantissa);
        let mut exponent = self.exponent.checked_sub(other.exponent)?;
        if quotient < (1_u128 << 63) {
            quotient <<= 1;
            exponent = exponent.checked_sub(1)?;
        }
        Some(Self {
            mantissa: quotient.try_into().ok()?,
            exponent,
        })
    }

    fn sqrt_floor(self) -> Option<u128> {
        let mut exponent = self.exponent;
        let mut mantissa = u128::from(self.mantissa);
        if exponent.rem_euclid(2) != 0 {
            mantissa = mantissa.checked_mul(2)?;
            exponent = exponent.checked_sub(1)?;
        }
        let scaled_root = integer_sqrt(mantissa << 63);
        let shift = exponent.checked_div(2)?.checked_sub(63)?;
        if shift >= 0 {
            scaled_root.checked_shl(shift as u32)
        } else {
            Some(scaled_root >> shift.unsigned_abs())
        }
    }
}

fn sqrt_product_ratio(numerators: &[u128], denominators: &[u128]) -> Option<u128> {
    let mut value = Normalized::from_u128(1)?;
    for numerator in numerators {
        value = value.multiply(Normalized::from_u128(*numerator)?)?;
    }
    for denominator in denominators {
        value = value.divide(Normalized::from_u128(*denominator)?)?;
    }
    value.sqrt_floor()
}

fn integer_sqrt(value: u128) -> u128 {
    if value < 2 {
        return value;
    }
    let mut estimate = 1_u128 << (128 - value.leading_zeros()).div_ceil(2);
    loop {
        let next = (estimate + value / estimate) / 2;
        if next >= estimate {
            return estimate;
        }
        estimate = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market() -> MarketState {
        MarketState {
            pump_base_reserve: 1_000_000_000_000,
            pump_quote_reserve: 10_000_000_000,
            pump_virtual_quote_reserve: 1_000_000_000,
            pump_fees: PumpFees {
                lp_fee_bps: 20,
                protocol_fee_bps: 5,
                creator_fee_bps: 5,
            },
            pair: LbPairState {
                static_parameters: crate::quote::DlmmStaticParameters {
                    base_factor: 200,
                    filter_period: 30,
                    decay_period: 600,
                    reduction_factor: 5_000,
                    variable_fee_control: 0,
                    max_volatility_accumulator: 0,
                    protocol_share: 0,
                    base_fee_power_factor: 0,
                    function_type: 1,
                    collect_fee_mode: 0,
                },
                variable_parameters: crate::quote::DlmmVariableParameters {
                    volatility_accumulator: 0,
                    volatility_reference: 0,
                    index_reference: 0,
                    last_update_timestamp: 0,
                },
                active_id: 0,
                bin_step: 10,
                bitmap: [0; 16],
                rewards_are_empty: true,
            },
            target_is_x: true,
        }
    }

    fn segment(
        input_start: u64,
        input_end: u64,
        output_start: u64,
        output_end: u64,
    ) -> DlmmSegment {
        DlmmSegment {
            input_start,
            input_end,
            output_start,
            output_end,
            price_q64: 1_u128 << 64,
            fee_rate: 0,
            swap_for_y: true,
            fee_on_input: true,
            used_indices: [0, 0],
            used_len: 1,
        }
    }

    fn evaluation_context(
        min_amount: u64,
        min_profit: u64,
        largest_complete_amount: u64,
    ) -> CandidateEvaluationContext {
        CandidateEvaluationContext {
            min_amount,
            min_profit,
            largest_complete_amount,
            visited_bins: 1,
            boundary_candidates: 0,
            interior_candidates: 0,
            curve_stop_reason: CurveStopReason::InputLimitReached,
        }
    }

    fn exact_pump_input_for_target_out(market: &MarketState, target_out: u64) -> u64 {
        let mut low = 1_u64;
        let mut high = 1_u64;
        while pump_buy_amount_out(market, high).is_none_or(|output| output < target_out) {
            high = high.checked_mul(2).unwrap();
        }
        while low < high {
            let midpoint = low + (high - low) / 2;
            if pump_buy_amount_out(market, midpoint).is_some_and(|output| output >= target_out) {
                high = midpoint;
            } else {
                low = midpoint + 1;
            }
        }
        low
    }

    #[test]
    fn validates_dynamic_range() {
        assert!(validate_args(&BestDirectionDynamicArgs {
            min_wsol_amount_in: 5,
            max_wsol_amount_in: 25,
            min_profit_lamports: 1,
        })
        .is_ok());
        for args in [
            BestDirectionDynamicArgs {
                min_wsol_amount_in: 0,
                max_wsol_amount_in: 25,
                min_profit_lamports: 1,
            },
            BestDirectionDynamicArgs {
                min_wsol_amount_in: 26,
                max_wsol_amount_in: 25,
                min_profit_lamports: 1,
            },
            BestDirectionDynamicArgs {
                min_wsol_amount_in: 5,
                max_wsol_amount_in: 25,
                min_profit_lamports: 0,
            },
        ] {
            assert!(validate_args(&args).is_err());
        }
    }

    #[test]
    fn normalized_square_root_handles_large_products_without_u128_multiplication() {
        let root = sqrt_product_ratio(
            &[1_000_000_000_000, 10_000_000_000, 1_000_000_000],
            &[1_000_000],
        )
        .unwrap();
        let expected = integer_sqrt(10_000_000_000_000_000_000_000_000);
        assert!(root.abs_diff(expected) <= 2);
    }

    #[test]
    fn candidate_selection_uses_absolute_profit_then_lower_input() {
        let candidates = [5, 10, 20];
        let mut context = evaluation_context(5, 1, 20);
        context.boundary_candidates = 2;
        context.interior_candidates = 1;
        let search = evaluate_candidates(&candidates, context, |amount| {
            Ok(CurveQuote {
                amount_out: match amount {
                    5 => 7,
                    10 => 15,
                    20 => 25,
                    _ => unreachable!(),
                },
                used_indices: [0, 0],
                used_len: 1,
            })
        });
        assert_eq!(search.best.unwrap().amount_in, 10);
    }

    #[test]
    fn incomplete_larger_candidate_keeps_smaller_complete_choice() {
        let candidates = [5, 10, 20];
        let mut context = evaluation_context(5, 1, 10);
        context.boundary_candidates = 1;
        context.curve_stop_reason = CurveStopReason::MissingBinArray;
        let search = evaluate_candidates(&candidates, context, |amount| {
            if amount > 10 {
                Err(QuoteError::InsufficientLiquidity)
            } else {
                Ok(CurveQuote {
                    amount_out: amount + 2,
                    used_indices: [0, 0],
                    used_len: 1,
                })
            }
        });
        assert!(search.complete_seen);
        assert_eq!(search.best.unwrap().amount_in, 5);
    }

    #[test]
    fn candidate_evaluation_never_selects_below_configured_minimum() {
        let candidates = [4, 5, 10];
        let search = evaluate_candidates(&candidates, evaluation_context(5, 1, 10), |amount| {
            Ok(CurveQuote {
                amount_out: amount + 2,
                used_indices: [0, 0],
                used_len: 1,
            })
        });
        assert!(search.complete_seen);
        assert_eq!(search.best.unwrap().amount_in, 5);
    }

    #[test]
    fn reverse_coverage_below_minimum_is_incomplete() {
        let market = market();
        let mut curve = DlmmCurve::new();
        curve.push(segment(0, 4, 0, 8)).unwrap();
        curve.visited_bins = 1;
        curve.stop_reason = CurveStopReason::MissingBinArray;

        let search = search_reverse(&market, &curve, 5, 25, 1);

        assert!(!search.complete_seen);
        assert!(search.best.is_none());
        assert_eq!(search.largest_complete_amount, 4);
        assert_eq!(search.curve_stop_reason, CurveStopReason::MissingBinArray);
    }

    #[test]
    fn reverse_coverage_equal_to_minimum_remains_eligible() {
        let market = market();
        let mut curve = DlmmCurve::new();
        curve.push(segment(0, 5, 0, 10)).unwrap();
        curve.visited_bins = 1;
        curve.stop_reason = CurveStopReason::MissingBinArray;

        let search = search_reverse(&market, &curve, 5, 25, 1);

        assert!(search.complete_seen);
        assert_eq!(search.largest_complete_amount, 5);
    }

    #[test]
    fn curve_quotes_inside_a_segment_without_replaying_prior_bins() {
        let mut curve = DlmmCurve::new();
        curve.push(segment(0, 1_000, 0, 1_000)).unwrap();
        curve.visited_bins = 1;
        assert_eq!(curve.quote(250).unwrap().amount_out, 250);
        assert!(curve.quote(1_001).is_err());
    }

    #[test]
    fn conservative_pump_boundary_stays_below_exact_transition() {
        let market = market();
        for target in [1_000_u64, 5_000_000, 100_000_000, 10_000_000_000] {
            let conservative = pump_input_at_or_below_target_out(&market, target).unwrap();
            let exact = exact_pump_input_for_target_out(&market, target);
            assert!(pump_buy_amount_out(&market, conservative).unwrap() < target);
            assert!(conservative < exact);
            assert!(exact - conservative <= 8);
        }
    }

    #[test]
    fn conservative_pump_boundary_handles_reserve_and_fee_variants() {
        for (base, quote, virtual_quote) in [
            (800_000_000_000, 20_000_000_000, 1_000_000_000),
            (1_000_000_000_000, 10_000_000_000, 0),
            (10_000_000_000_000, 500_000_000_000, 50_000_000_000),
        ] {
            for (lp, protocol, creator) in [(0, 0, 0), (20, 5, 5), (100, 50, 50)] {
                let mut market = market();
                market.pump_base_reserve = base;
                market.pump_quote_reserve = quote;
                market.pump_virtual_quote_reserve = virtual_quote;
                market.pump_fees = PumpFees {
                    lp_fee_bps: lp,
                    protocol_fee_bps: protocol,
                    creator_fee_bps: creator,
                };
                for target in [base / 1_000_000, base / 10_000, base / 100, base / 4] {
                    let conservative = pump_input_at_or_below_target_out(&market, target).unwrap();
                    let exact = exact_pump_input_for_target_out(&market, target);
                    assert!(pump_buy_amount_out(&market, conservative).unwrap() < target);
                    assert!(conservative < exact);
                    assert!(exact - conservative <= 8);
                }
            }
        }
    }

    #[test]
    fn forward_coverage_cap_keeps_the_largest_complete_input() {
        let market = market();
        let mut curve = DlmmCurve::new();
        curve.push(segment(0, 5_000_000, 0, 5_000_000)).unwrap();
        curve.visited_bins = 1;
        let largest = largest_forward_complete_amount(&market, &curve, 1_000_000);
        assert!(largest > 0 && largest < 1_000_000);
        assert!(pump_buy_amount_out(&market, largest).unwrap() <= 5_000_000);
        assert!(pump_buy_amount_out(&market, largest + 1).unwrap() > 5_000_000);
    }

    #[test]
    fn forward_coverage_below_minimum_is_incomplete() {
        let market = market();
        let mut curve = DlmmCurve::new();
        curve.push(segment(0, 5_000_000, 0, 5_000_000)).unwrap();
        curve.visited_bins = 1;
        curve.stop_reason = CurveStopReason::MissingBinArray;
        let largest = largest_forward_complete_amount(&market, &curve, 1_000_000);

        let search = search_forward(&market, &curve, largest + 1, 1_000_000, 1);

        assert!(!search.complete_seen);
        assert!(search.best.is_none());
        assert_eq!(search.largest_complete_amount, largest);
        assert_eq!(search.curve_stop_reason, CurveStopReason::MissingBinArray);
    }

    #[test]
    fn forward_coverage_equal_to_minimum_remains_eligible() {
        let market = market();
        let mut curve = DlmmCurve::new();
        curve.push(segment(0, 5_000_000, 0, 5_000_000)).unwrap();
        curve.visited_bins = 1;
        curve.stop_reason = CurveStopReason::MissingBinArray;
        let largest = largest_forward_complete_amount(&market, &curve, 1_000_000);

        let search = search_forward(&market, &curve, largest, 1_000_000, 1);

        assert!(search.complete_seen);
        assert_eq!(search.largest_complete_amount, largest);
    }
}
