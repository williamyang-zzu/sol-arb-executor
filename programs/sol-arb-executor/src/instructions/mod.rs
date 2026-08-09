pub mod meteora_to_pump;
pub mod post_trade_checks;
pub mod pump_to_meteora;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    adapters::{meteora_dlmm::MeteoraAccounts, pump_swap::PumpSwapAccounts},
    constants::{
        MEMO_PROGRAM_ID, METEORA_DLMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID,
        WSOL_MINT,
    },
    errors::ArbError,
};

#[derive(Accounts)]
pub struct ExecuteRoute<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: InterfaceAccount<'info, Mint>,
    #[account(constraint = target_mint.key() != WSOL_MINT @ ArbError::InvalidTokenMint)]
    pub target_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_wsol.owner == trader.key() @ ArbError::InvalidTokenAccountOwner,
        constraint = user_wsol.mint == wsol_mint.key() @ ArbError::InvalidTokenMint,
    )]
    pub user_wsol: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_target.owner == trader.key() @ ArbError::InvalidTokenAccountOwner,
        constraint = user_target.mint == target_mint.key() @ ArbError::InvalidTokenMint,
    )]
    pub user_target: InterfaceAccount<'info, TokenAccount>,

    #[account(address = anchor_spl::token::ID @ ArbError::UnsupportedTokenProgram)]
    pub wsol_token_program: Interface<'info, TokenInterface>,
    pub target_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    /// CHECK: Address and executable flag are validated by the Pump adapter.
    #[account(address = PUMP_SWAP_PROGRAM_ID @ ArbError::InvalidProgramId)]
    pub pump_program: UncheckedAccount<'info>,
    /// CHECK: Owner, discriminator, mints, and vaults are validated from official Pool layout.
    #[account(mut)]
    pub pump_pool: UncheckedAccount<'info>,
    /// CHECK: PumpSwap validates its global config PDA.
    pub pump_global_config: UncheckedAccount<'info>,
    /// CHECK: Must match the Pump Pool base vault; validated by the adapter and PumpSwap.
    #[account(mut)]
    pub pump_pool_base_token_account: UncheckedAccount<'info>,
    /// CHECK: Must match the Pump Pool quote vault; validated by the adapter and PumpSwap.
    #[account(mut)]
    pub pump_pool_quote_token_account: UncheckedAccount<'info>,
    /// CHECK: Validated by PumpSwap global config and fee logic.
    pub pump_protocol_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: Validated by PumpSwap as the fee recipient quote-token ATA.
    #[account(mut)]
    pub pump_protocol_fee_recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: PumpSwap event-authority PDA is validated by the callee.
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: PumpSwap validates the creator vault relationship.
    #[account(mut)]
    pub pump_coin_creator_vault_ata: UncheckedAccount<'info>,
    /// CHECK: PumpSwap validates the creator vault authority PDA.
    pub pump_coin_creator_vault_authority: UncheckedAccount<'info>,
    /// CHECK: Required fixed account for buy_exact_quote_in and validated by PumpSwap.
    pub pump_global_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: Required fixed account for buy_exact_quote_in and validated by PumpSwap.
    #[account(mut)]
    pub pump_user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: Pump fee-program PDA validated by PumpSwap.
    pub pump_fee_config: UncheckedAccount<'info>,
    /// CHECK: Address and executable flag are validated by the Pump adapter.
    #[account(address = PUMP_FEE_PROGRAM_ID @ ArbError::InvalidProgramId)]
    pub pump_fee_program: UncheckedAccount<'info>,
    /// CHECK: PumpSwap pool-v2 PDA; its address is validated by the adapter when required.
    pub pump_pool_v2: UncheckedAccount<'info>,
    /// CHECK: PumpSwap validates this address against its global buyback recipients.
    pub pump_buyback_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: PumpSwap validates this as the buyback recipient quote-token ATA.
    #[account(mut)]
    pub pump_buyback_fee_recipient_token_account: UncheckedAccount<'info>,

    /// CHECK: Address and executable flag are validated by the Meteora adapter.
    #[account(address = METEORA_DLMM_PROGRAM_ID @ ArbError::InvalidProgramId)]
    pub meteora_program: UncheckedAccount<'info>,
    /// CHECK: Owner, discriminator, mints, and reserves are validated from official LbPair layout.
    #[account(mut)]
    pub meteora_lb_pair: UncheckedAccount<'info>,
    /// CHECK: Writable bitmap extension or Meteora program-ID sentinel; adapter validates it.
    #[account(mut)]
    pub meteora_bin_array_bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: Must match LbPair reserve X; adapter validates it.
    #[account(mut)]
    pub meteora_reserve_x: UncheckedAccount<'info>,
    /// CHECK: Must match LbPair reserve Y; adapter validates it.
    #[account(mut)]
    pub meteora_reserve_y: UncheckedAccount<'info>,
    /// CHECK: Meteora validates the LbPair oracle relationship.
    #[account(mut)]
    pub meteora_oracle: UncheckedAccount<'info>,
    /// CHECK: Writable host-fee account or Meteora program-ID sentinel; adapter validates it.
    #[account(mut)]
    pub meteora_host_fee_in: UncheckedAccount<'info>,
    /// CHECK: Fixed official memo program.
    #[account(address = MEMO_PROGRAM_ID @ ArbError::InvalidProgramId)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: Meteora event-authority PDA is validated by the callee.
    pub meteora_event_authority: UncheckedAccount<'info>,
}

impl<'info> ExecuteRoute<'info> {
    pub fn pump_accounts(&self) -> PumpSwapAccounts<'info> {
        PumpSwapAccounts {
            pool: self.pump_pool.to_account_info(),
            user: self.trader.to_account_info(),
            global_config: self.pump_global_config.to_account_info(),
            base_mint: self.target_mint.to_account_info(),
            quote_mint: self.wsol_mint.to_account_info(),
            user_base_token_account: self.user_target.to_account_info(),
            user_quote_token_account: self.user_wsol.to_account_info(),
            pool_base_token_account: self.pump_pool_base_token_account.to_account_info(),
            pool_quote_token_account: self.pump_pool_quote_token_account.to_account_info(),
            protocol_fee_recipient: self.pump_protocol_fee_recipient.to_account_info(),
            protocol_fee_recipient_token_account: self
                .pump_protocol_fee_recipient_token_account
                .to_account_info(),
            base_token_program: self.target_token_program.to_account_info(),
            quote_token_program: self.wsol_token_program.to_account_info(),
            system_program: self.system_program.to_account_info(),
            associated_token_program: self.associated_token_program.to_account_info(),
            event_authority: self.pump_event_authority.to_account_info(),
            program: self.pump_program.to_account_info(),
            coin_creator_vault_ata: self.pump_coin_creator_vault_ata.to_account_info(),
            coin_creator_vault_authority: self.pump_coin_creator_vault_authority.to_account_info(),
            global_volume_accumulator: self.pump_global_volume_accumulator.to_account_info(),
            user_volume_accumulator: self.pump_user_volume_accumulator.to_account_info(),
            fee_config: self.pump_fee_config.to_account_info(),
            fee_program: self.pump_fee_program.to_account_info(),
            pool_v2: self.pump_pool_v2.to_account_info(),
            buyback_fee_recipient: self.pump_buyback_fee_recipient.to_account_info(),
            buyback_fee_recipient_token_account: self
                .pump_buyback_fee_recipient_token_account
                .to_account_info(),
        }
    }

    pub fn meteora_accounts(
        &self,
        input: AccountInfo<'info>,
        output: AccountInfo<'info>,
    ) -> MeteoraAccounts<'info> {
        // token X/Y follow the pair; user input/output follow route direction.
        let pair_data = self.meteora_lb_pair.try_borrow_data();
        let target_is_x = pair_data
            .ok()
            .and_then(|data| crate::utils::account_validation::parse_meteora_pair(&data).ok())
            .map(|pair| pair.token_x_mint == self.target_mint.key())
            .unwrap_or(false);
        let (token_x, token_y, token_x_program, token_y_program) = if target_is_x {
            (
                self.target_mint.to_account_info(),
                self.wsol_mint.to_account_info(),
                self.target_token_program.to_account_info(),
                self.wsol_token_program.to_account_info(),
            )
        } else {
            (
                self.wsol_mint.to_account_info(),
                self.target_mint.to_account_info(),
                self.wsol_token_program.to_account_info(),
                self.target_token_program.to_account_info(),
            )
        };
        MeteoraAccounts {
            lb_pair: self.meteora_lb_pair.to_account_info(),
            bin_array_bitmap_extension: self.meteora_bin_array_bitmap_extension.to_account_info(),
            reserve_x: self.meteora_reserve_x.to_account_info(),
            reserve_y: self.meteora_reserve_y.to_account_info(),
            user_token_in: input,
            user_token_out: output,
            token_x_mint: token_x,
            token_y_mint: token_y,
            oracle: self.meteora_oracle.to_account_info(),
            host_fee_in: self.meteora_host_fee_in.to_account_info(),
            user: self.trader.to_account_info(),
            token_x_program,
            token_y_program,
            memo_program: self.memo_program.to_account_info(),
            event_authority: self.meteora_event_authority.to_account_info(),
            program: self.meteora_program.to_account_info(),
        }
    }

    pub fn validate_route_mints(&self) -> Result<()> {
        crate::utils::token_extensions::validate_route_token_programs(
            &self.wsol_mint.to_account_info(),
            &self.target_mint.to_account_info(),
            &self.user_wsol.to_account_info(),
            &self.user_target.to_account_info(),
            &self.wsol_token_program.key(),
            &self.target_token_program.key(),
        )?;
        crate::utils::token_extensions::validate_supported_target_mint(
            &self.target_mint.to_account_info(),
        )?;
        crate::utils::account_validation::validate_user_token_fields(
            &self.user_wsol.owner,
            &self.user_wsol.mint,
            &self.trader.key(),
            &WSOL_MINT,
        )?;
        crate::utils::account_validation::validate_user_token_fields(
            &self.user_target.owner,
            &self.user_target.mint,
            &self.trader.key(),
            &self.target_mint.key(),
        )?;
        let pair = crate::utils::account_validation::parse_meteora_pair(
            &self.meteora_lb_pair.try_borrow_data()?,
        )?;
        let valid_pair = (pair.token_x_mint == self.target_mint.key()
            && pair.token_y_mint == WSOL_MINT)
            || (pair.token_y_mint == self.target_mint.key() && pair.token_x_mint == WSOL_MINT);
        require!(valid_pair, ArbError::InvalidRouteAccounts);
        Ok(())
    }
}
