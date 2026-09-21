//! Offline feasibility probe, not an executor instruction or a global optimizer.
//! Reuses production integer arithmetic and its 16-bin / 2-array direction caps.
use crate::{quote::*, snapshot_accounts::*};
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, msg, program_error::ProgramError,
    pubkey::Pubkey,
};

pub const MAX_TRIALS: usize = 9;

pub struct Market {
    pub base: u64,
    pub quote: u64,
    pub virtual_quote: u64,
    pub fees: PumpFees,
    pub pair: LbPairState,
    pub arrays: Vec<ParsedBinArray>,
    pub target_is_x: bool,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Row {
    pub input: u64,
    pub forward: Result<u64, QuoteError>,
    pub reverse: Result<u64, QuoteError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    pub input: u64,
    pub output: u64,
    pub reverse: bool,
}

pub fn choose(rows: &[Row], min_profit: u64) -> Option<Choice> {
    let mut best: Option<Choice> = None;
    for row in rows {
        for (reverse, result) in [(false, row.forward), (true, row.reverse)] {
            if let Ok(output) = result {
                if let Some(profit) = output.checked_sub(row.input) {
                    if profit >= min_profit && best.is_none_or(|b| profit > b.output - b.input) {
                        best = Some(Choice {
                            input: row.input,
                            output,
                            reverse,
                        });
                    }
                }
            }
        }
    }
    best
}

impl Market {
    // Fixture contract: pool, global fees, fee config, mint, Pump base/quote
    // vaults, LbPair, then <=4 BinArrays. Bitmap extension is not in this V0 probe.
    pub fn parse(data: &[&[u8]], timestamp: i64) -> Result<Self, QuoteError> {
        if !(8..=11).contains(&data.len()) {
            return Err(QuoteError::InvalidInput);
        }
        let pool = parse_pump_pool(data[0])?;
        let base = token_amount(data[4])?;
        let quote = token_amount(data[5])?;
        let pump_program: Pubkey = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
            .parse()
            .unwrap();
        let expected_creator =
            Pubkey::find_program_address(&[b"pool-authority", &pool.base_mint], &pump_program).0;
        let mut fees = select_pump_fees_from_data(
            data[2],
            parse_pump_global_fees(data[1])?,
            pool.creator == expected_creator.to_bytes(),
            mint_supply(data[3])?,
            base,
            quote
                .checked_add(pool.virtual_quote_reserves)
                .ok_or(QuoteError::MathOverflow)?,
        )?;
        if pool.coin_creator == [0; 32] {
            fees.creator_fee_bps = 0;
        }
        let pair = parse_lb_pair(data[6])?;
        // Canonical LbPair mint offsets, checked against the fixture before use.
        let target_is_x = data[6].get(88..120) == Some(pool.base_mint.as_slice());
        if !target_is_x && data[6].get(120..152) != Some(pool.base_mint.as_slice()) {
            return Err(QuoteError::InvalidInput);
        }
        let arrays = data[7..]
            .iter()
            .map(|d| parse_bin_array_window(d, pair.active_id))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            base,
            quote,
            virtual_quote: pool.virtual_quote_reserves,
            fees,
            pair,
            arrays,
            target_is_x,
            timestamp,
        })
    }

    pub fn row(&self, input: u64) -> Row {
        let f = self.fees;
        let forward = pump_buy_exact_quote_in(
            input,
            self.base,
            self.quote,
            self.virtual_quote,
            f.lp_fee_bps,
            f.protocol_fee_bps,
            f.creator_fee_bps,
        )
        .and_then(|buy| {
            quote_dlmm_snapshot(
                buy.amount_out,
                &self.pair,
                &self.arrays,
                self.target_is_x,
                self.timestamp,
            )
        })
        .map(|q| q.amount_out);
        let reverse = quote_dlmm_snapshot(
            input,
            &self.pair,
            &self.arrays,
            !self.target_is_x,
            self.timestamp,
        )
        .and_then(|buy| {
            pump_sell_base_in(
                buy.amount_out,
                self.base,
                self.quote,
                self.virtual_quote,
                f.lp_fee_bps,
                f.protocol_fee_bps,
                f.creator_fee_bps,
            )
        })
        .map(|q| q.amount_out);
        Row {
            input,
            forward,
            reverse,
        }
    }
}

pub fn process(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 18 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let count = usize::from(data[9]);
    if count == 0 || count > MAX_TRIALS || data.len() != 10 + 8 * count {
        return Err(ProgramError::InvalidInstructionData);
    }
    let timestamp = i64::from_le_bytes(data[1..9].try_into().unwrap());
    let borrowed = accounts
        .iter()
        .map(|a| a.try_borrow_data())
        .collect::<Result<Vec<_>, _>>()?;
    let slices: Vec<&[u8]> = borrowed.iter().map(|d| d.as_ref()).collect();
    let market = Market::parse(&slices, timestamp).map_err(|_| ProgramError::InvalidAccountData)?;
    let rows: Vec<Row> = data[10..]
        .chunks_exact(8)
        .map(|b| market.row(u64::from_le_bytes(b.try_into().unwrap())))
        .collect();
    // Consume all outputs so SBF CU measures real work even for rejected quotes.
    for row in &rows {
        msg!(
            "amount-probe row={} forward={:?} reverse={:?}",
            row.input,
            row.forward,
            row.reverse
        );
    }
    msg!("amount-probe best={:?}", choose(&rows, 1));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chooses_absolute_profit_not_roi_and_skips_incomplete() {
        let rows = [
            Row {
                input: 100,
                forward: Ok(120),
                reverse: Err(QuoteError::InsufficientLiquidity),
            },
            Row {
                input: 1000,
                forward: Ok(1100),
                reverse: Ok(1150),
            },
            Row {
                input: 10000,
                forward: Err(QuoteError::InsufficientLiquidity),
                reverse: Ok(9900),
            },
        ];
        assert_eq!(
            choose(&rows, 1),
            Some(Choice {
                input: 1000,
                output: 1150,
                reverse: true
            })
        );
        assert_eq!(choose(&rows, 151), None);
    }
    #[test]
    fn no_profit_and_overflow_are_not_opportunities() {
        let rows = [Row {
            input: u64::MAX,
            forward: Ok(0),
            reverse: Ok(u64::MAX),
        }];
        assert_eq!(choose(&rows, 1), None);
    }
}
