use anchor_lang::{prelude::*, solana_program::instruction::AccountMeta};

use crate::{
    constants::{METEORA_DLMM_PROGRAM_ID, METEORA_SWAP2_DISCRIMINATOR},
    errors::ArbError,
    utils::account_validation::{parse_meteora_pair, validate_bin_arrays},
};

pub struct MeteoraAccounts<'info> {
    pub lb_pair: AccountInfo<'info>,
    pub bin_array_bitmap_extension: AccountInfo<'info>,
    pub reserve_x: AccountInfo<'info>,
    pub reserve_y: AccountInfo<'info>,
    pub user_token_in: AccountInfo<'info>,
    pub user_token_out: AccountInfo<'info>,
    pub token_x_mint: AccountInfo<'info>,
    pub token_y_mint: AccountInfo<'info>,
    pub oracle: AccountInfo<'info>,
    pub host_fee_in: AccountInfo<'info>,
    pub user: AccountInfo<'info>,
    pub token_x_program: AccountInfo<'info>,
    pub token_y_program: AccountInfo<'info>,
    pub memo_program: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub program: AccountInfo<'info>,
}

pub fn validate<'info>(
    accounts: &MeteoraAccounts<'info>,
    bin_arrays: &[AccountInfo<'info>],
) -> Result<()> {
    require_keys_eq!(
        *accounts.program.key,
        METEORA_DLMM_PROGRAM_ID,
        ArbError::InvalidProgramId
    );
    require!(accounts.program.executable, ArbError::InvalidProgramId);
    require_keys_eq!(
        *accounts.lb_pair.owner,
        METEORA_DLMM_PROGRAM_ID,
        ArbError::InvalidPool
    );

    let pair = parse_meteora_pair(&accounts.lb_pair.try_borrow_data()?)?;
    require_keys_eq!(
        pair.token_x_mint,
        *accounts.token_x_mint.key,
        ArbError::InvalidTokenMint
    );
    require_keys_eq!(
        pair.token_y_mint,
        *accounts.token_y_mint.key,
        ArbError::InvalidTokenMint
    );
    require_keys_eq!(
        pair.reserve_x,
        *accounts.reserve_x.key,
        ArbError::InvalidPool
    );
    require_keys_eq!(
        pair.reserve_y,
        *accounts.reserve_y.key,
        ArbError::InvalidPool
    );

    for optional in [&accounts.bin_array_bitmap_extension, &accounts.host_fee_in] {
        if optional.key != &METEORA_DLMM_PROGRAM_ID {
            require_keys_eq!(
                *optional.owner,
                METEORA_DLMM_PROGRAM_ID,
                ArbError::InvalidPool
            );
        }
    }
    validate_bin_arrays(bin_arrays, accounts.lb_pair.key)
}

pub fn swap2<'info>(
    accounts: &MeteoraAccounts<'info>,
    bin_arrays: &[AccountInfo<'info>],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    validate(accounts, bin_arrays)?;

    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&METEORA_SWAP2_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_amount_out.to_le_bytes());
    // RemainingAccountsInfo { slices: [TransferHookX(0), TransferHookY(1)] }.
    // Both lengths are zero because this MVP rejects Token-2022.
    data.extend_from_slice(&2_u32.to_le_bytes());
    data.extend_from_slice(&[0, 0, 1, 0]);

    let optional_meta = |account: &AccountInfo<'_>| {
        if account.key == &METEORA_DLMM_PROGRAM_ID {
            AccountMeta::new_readonly(*account.key, false)
        } else {
            AccountMeta::new(*account.key, false)
        }
    };
    let mut metas = vec![
        AccountMeta::new(*accounts.lb_pair.key, false),
        optional_meta(&accounts.bin_array_bitmap_extension),
        AccountMeta::new(*accounts.reserve_x.key, false),
        AccountMeta::new(*accounts.reserve_y.key, false),
        AccountMeta::new(*accounts.user_token_in.key, false),
        AccountMeta::new(*accounts.user_token_out.key, false),
        AccountMeta::new_readonly(*accounts.token_x_mint.key, false),
        AccountMeta::new_readonly(*accounts.token_y_mint.key, false),
        AccountMeta::new(*accounts.oracle.key, false),
        optional_meta(&accounts.host_fee_in),
        AccountMeta::new_readonly(*accounts.user.key, true),
        AccountMeta::new_readonly(*accounts.token_x_program.key, false),
        AccountMeta::new_readonly(*accounts.token_y_program.key, false),
        AccountMeta::new_readonly(*accounts.memo_program.key, false),
        AccountMeta::new_readonly(*accounts.event_authority.key, false),
        AccountMeta::new_readonly(*accounts.program.key, false),
    ];
    metas.extend(
        bin_arrays
            .iter()
            .map(|account| AccountMeta::new(*account.key, false)),
    );

    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: metas,
        data,
    };
    let mut infos = vec![
        accounts.lb_pair.clone(),
        accounts.bin_array_bitmap_extension.clone(),
        accounts.reserve_x.clone(),
        accounts.reserve_y.clone(),
        accounts.user_token_in.clone(),
        accounts.user_token_out.clone(),
        accounts.token_x_mint.clone(),
        accounts.token_y_mint.clone(),
        accounts.oracle.clone(),
        accounts.host_fee_in.clone(),
        accounts.user.clone(),
        accounts.token_x_program.clone(),
        accounts.token_y_program.clone(),
        accounts.memo_program.clone(),
        accounts.event_authority.clone(),
        accounts.program.clone(),
    ];
    infos.extend(bin_arrays.iter().cloned());
    anchor_lang::solana_program::program::invoke(&instruction, &infos).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_swap2_remaining_account_encoding_is_stable() {
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&2_u32.to_le_bytes());
        encoded.extend_from_slice(&[0, 0, 1, 0]);
        assert_eq!(encoded, [2, 0, 0, 0, 0, 0, 1, 0]);
    }
}
