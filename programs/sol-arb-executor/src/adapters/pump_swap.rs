use anchor_lang::{prelude::*, solana_program::instruction::AccountMeta};

use crate::{
    constants::{
        PUMP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR, PUMP_FEE_PROGRAM_ID, PUMP_SELL_DISCRIMINATOR,
        PUMP_SWAP_PROGRAM_ID,
    },
    errors::ArbError,
    utils::account_validation::parse_pump_pool,
};

pub struct PumpSwapAccounts<'info> {
    pub pool: AccountInfo<'info>,
    pub user: AccountInfo<'info>,
    pub global_config: AccountInfo<'info>,
    pub base_mint: AccountInfo<'info>,
    pub quote_mint: AccountInfo<'info>,
    pub user_base_token_account: AccountInfo<'info>,
    pub user_quote_token_account: AccountInfo<'info>,
    pub pool_base_token_account: AccountInfo<'info>,
    pub pool_quote_token_account: AccountInfo<'info>,
    pub protocol_fee_recipient: AccountInfo<'info>,
    pub protocol_fee_recipient_token_account: AccountInfo<'info>,
    pub base_token_program: AccountInfo<'info>,
    pub quote_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub associated_token_program: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub program: AccountInfo<'info>,
    pub coin_creator_vault_ata: AccountInfo<'info>,
    pub coin_creator_vault_authority: AccountInfo<'info>,
    pub global_volume_accumulator: AccountInfo<'info>,
    pub user_volume_accumulator: AccountInfo<'info>,
    pub fee_config: AccountInfo<'info>,
    pub fee_program: AccountInfo<'info>,
    pub pool_v2: AccountInfo<'info>,
    pub buyback_fee_recipient: AccountInfo<'info>,
    pub buyback_fee_recipient_token_account: AccountInfo<'info>,
}

pub fn validate(accounts: &PumpSwapAccounts<'_>) -> Result<()> {
    require_keys_eq!(
        *accounts.program.key,
        PUMP_SWAP_PROGRAM_ID,
        ArbError::InvalidProgramId
    );
    require!(accounts.program.executable, ArbError::InvalidProgramId);
    require_keys_eq!(
        *accounts.fee_program.key,
        PUMP_FEE_PROGRAM_ID,
        ArbError::InvalidProgramId
    );
    require!(accounts.fee_program.executable, ArbError::InvalidProgramId);
    require_keys_eq!(
        *accounts.pool.owner,
        PUMP_SWAP_PROGRAM_ID,
        ArbError::InvalidPool
    );

    let pool = parse_pump_pool(&accounts.pool.try_borrow_data()?)?;
    require_keys_eq!(
        pool.base_mint,
        *accounts.base_mint.key,
        ArbError::InvalidTokenMint
    );
    require_keys_eq!(
        pool.quote_mint,
        *accounts.quote_mint.key,
        ArbError::InvalidTokenMint
    );
    require_keys_eq!(
        pool.base_vault,
        *accounts.pool_base_token_account.key,
        ArbError::InvalidPool
    );
    require_keys_eq!(
        pool.quote_vault,
        *accounts.pool_quote_token_account.key,
        ArbError::InvalidPool
    );
    if pool.coin_creator != Pubkey::default() {
        let (expected_pool_v2, _) = Pubkey::find_program_address(
            &[b"pool-v2", accounts.base_mint.key.as_ref()],
            &PUMP_SWAP_PROGRAM_ID,
        );
        require_keys_eq!(
            expected_pool_v2,
            *accounts.pool_v2.key,
            ArbError::InvalidPool
        );
    }
    Ok(())
}

pub fn buy_exact_quote_in(
    accounts: &PumpSwapAccounts<'_>,
    spendable_quote_in: u64,
    min_base_amount_out: u64,
) -> Result<()> {
    validate(accounts)?;
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&PUMP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR);
    data.extend_from_slice(&spendable_quote_in.to_le_bytes());
    data.extend_from_slice(&min_base_amount_out.to_le_bytes());
    data.push(0); // OptionBool(false): do not track volume in this MVP.

    let mut metas = vec![
        AccountMeta::new(*accounts.pool.key, false),
        AccountMeta::new(*accounts.user.key, true),
        AccountMeta::new_readonly(*accounts.global_config.key, false),
        AccountMeta::new_readonly(*accounts.base_mint.key, false),
        AccountMeta::new_readonly(*accounts.quote_mint.key, false),
        AccountMeta::new(*accounts.user_base_token_account.key, false),
        AccountMeta::new(*accounts.user_quote_token_account.key, false),
        AccountMeta::new(*accounts.pool_base_token_account.key, false),
        AccountMeta::new(*accounts.pool_quote_token_account.key, false),
        AccountMeta::new_readonly(*accounts.protocol_fee_recipient.key, false),
        AccountMeta::new(*accounts.protocol_fee_recipient_token_account.key, false),
        AccountMeta::new_readonly(*accounts.base_token_program.key, false),
        AccountMeta::new_readonly(*accounts.quote_token_program.key, false),
        AccountMeta::new_readonly(*accounts.system_program.key, false),
        AccountMeta::new_readonly(*accounts.associated_token_program.key, false),
        AccountMeta::new_readonly(*accounts.event_authority.key, false),
        AccountMeta::new_readonly(*accounts.program.key, false),
        AccountMeta::new(*accounts.coin_creator_vault_ata.key, false),
        AccountMeta::new_readonly(*accounts.coin_creator_vault_authority.key, false),
        AccountMeta::new_readonly(*accounts.global_volume_accumulator.key, false),
        AccountMeta::new(*accounts.user_volume_accumulator.key, false),
        AccountMeta::new_readonly(*accounts.fee_config.key, false),
        AccountMeta::new_readonly(*accounts.fee_program.key, false),
    ];
    append_current_remaining_accounts(accounts, &mut metas)?;
    invoke(accounts, metas, data, true)
}

pub fn sell(
    accounts: &PumpSwapAccounts<'_>,
    base_amount_in: u64,
    min_quote_amount_out: u64,
) -> Result<()> {
    validate(accounts)?;
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&PUMP_SELL_DISCRIMINATOR);
    data.extend_from_slice(&base_amount_in.to_le_bytes());
    data.extend_from_slice(&min_quote_amount_out.to_le_bytes());

    let mut metas = vec![
        AccountMeta::new(*accounts.pool.key, false),
        AccountMeta::new(*accounts.user.key, true),
        AccountMeta::new_readonly(*accounts.global_config.key, false),
        AccountMeta::new_readonly(*accounts.base_mint.key, false),
        AccountMeta::new_readonly(*accounts.quote_mint.key, false),
        AccountMeta::new(*accounts.user_base_token_account.key, false),
        AccountMeta::new(*accounts.user_quote_token_account.key, false),
        AccountMeta::new(*accounts.pool_base_token_account.key, false),
        AccountMeta::new(*accounts.pool_quote_token_account.key, false),
        AccountMeta::new_readonly(*accounts.protocol_fee_recipient.key, false),
        AccountMeta::new(*accounts.protocol_fee_recipient_token_account.key, false),
        AccountMeta::new_readonly(*accounts.base_token_program.key, false),
        AccountMeta::new_readonly(*accounts.quote_token_program.key, false),
        AccountMeta::new_readonly(*accounts.system_program.key, false),
        AccountMeta::new_readonly(*accounts.associated_token_program.key, false),
        AccountMeta::new_readonly(*accounts.event_authority.key, false),
        AccountMeta::new_readonly(*accounts.program.key, false),
        AccountMeta::new(*accounts.coin_creator_vault_ata.key, false),
        AccountMeta::new_readonly(*accounts.coin_creator_vault_authority.key, false),
        AccountMeta::new_readonly(*accounts.fee_config.key, false),
        AccountMeta::new_readonly(*accounts.fee_program.key, false),
    ];
    append_current_remaining_accounts(accounts, &mut metas)?;
    invoke(accounts, metas, data, false)
}

fn append_current_remaining_accounts(
    accounts: &PumpSwapAccounts<'_>,
    metas: &mut Vec<AccountMeta>,
) -> Result<()> {
    let pool = parse_pump_pool(&accounts.pool.try_borrow_data()?)?;
    if pool.coin_creator != Pubkey::default() {
        metas.push(AccountMeta::new_readonly(*accounts.pool_v2.key, false));
    }
    metas.push(AccountMeta::new_readonly(
        *accounts.buyback_fee_recipient.key,
        false,
    ));
    metas.push(AccountMeta::new(
        *accounts.buyback_fee_recipient_token_account.key,
        false,
    ));
    Ok(())
}

fn invoke(
    accounts: &PumpSwapAccounts<'_>,
    metas: Vec<AccountMeta>,
    data: Vec<u8>,
    include_volume_accounts: bool,
) -> Result<()> {
    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: PUMP_SWAP_PROGRAM_ID,
        accounts: metas,
        data,
    };
    let mut infos = vec![
        accounts.pool.clone(),
        accounts.user.clone(),
        accounts.global_config.clone(),
        accounts.base_mint.clone(),
        accounts.quote_mint.clone(),
        accounts.user_base_token_account.clone(),
        accounts.user_quote_token_account.clone(),
        accounts.pool_base_token_account.clone(),
        accounts.pool_quote_token_account.clone(),
        accounts.protocol_fee_recipient.clone(),
        accounts.protocol_fee_recipient_token_account.clone(),
        accounts.base_token_program.clone(),
        accounts.quote_token_program.clone(),
        accounts.system_program.clone(),
        accounts.associated_token_program.clone(),
        accounts.event_authority.clone(),
        accounts.program.clone(),
        accounts.coin_creator_vault_ata.clone(),
        accounts.coin_creator_vault_authority.clone(),
    ];
    if include_volume_accounts {
        infos.push(accounts.global_volume_accumulator.clone());
        infos.push(accounts.user_volume_accumulator.clone());
    }
    infos.push(accounts.fee_config.clone());
    infos.push(accounts.fee_program.clone());
    let pool = parse_pump_pool(&accounts.pool.try_borrow_data()?)?;
    if pool.coin_creator != Pubkey::default() {
        infos.push(accounts.pool_v2.clone());
    }
    infos.push(accounts.buyback_fee_recipient.clone());
    infos.push(accounts.buyback_fee_recipient_token_account.clone());
    anchor_lang::solana_program::program::invoke(&instruction, &infos).map_err(Into::into)
}
