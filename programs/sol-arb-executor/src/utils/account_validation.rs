use anchor_lang::prelude::*;

use crate::{
    constants::{
        METEORA_BIN_ARRAY_DISCRIMINATOR, METEORA_DLMM_PROGRAM_ID, METEORA_LB_PAIR_DISCRIMINATOR,
        PUMP_POOL_DISCRIMINATOR,
    },
    errors::ArbError,
};

const DISCRIMINATOR_LEN: usize = 8;

// Stable Borsh prefix offsets in PumpSwap Pool, including the account discriminator.
const PUMP_BASE_MINT_OFFSET: usize = 43;
const PUMP_QUOTE_MINT_OFFSET: usize = 75;
const PUMP_BASE_VAULT_OFFSET: usize = 139;
const PUMP_QUOTE_VAULT_OFFSET: usize = 171;
const PUMP_COIN_CREATOR_OFFSET: usize = 211;
const PUMP_IS_CASHBACK_COIN_OFFSET: usize = 244;
const PUMP_REQUIRED_PREFIX_LEN: usize = PUMP_COIN_CREATOR_OFFSET + 32;

// Stable repr(C) prefix offsets in Meteora LbPair, including the discriminator.
const METEORA_TOKEN_X_MINT_OFFSET: usize = 88;
const METEORA_TOKEN_Y_MINT_OFFSET: usize = 120;
const METEORA_RESERVE_X_OFFSET: usize = 152;
const METEORA_RESERVE_Y_OFFSET: usize = 184;
const METEORA_REQUIRED_PREFIX_LEN: usize = METEORA_RESERVE_Y_OFFSET + 32;

// BinArray: discriminator + i64 index + u8 version + [u8; 7] padding.
const METEORA_BIN_ARRAY_LB_PAIR_OFFSET: usize = 24;
const METEORA_BIN_ARRAY_REQUIRED_PREFIX_LEN: usize = METEORA_BIN_ARRAY_LB_PAIR_OFFSET + 32;

#[derive(Debug, Eq, PartialEq)]
pub struct PumpPoolPrefix {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub coin_creator: Pubkey,
    pub is_cashback_coin: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub struct MeteoraPairPrefix {
    pub token_x_mint: Pubkey,
    pub token_y_mint: Pubkey,
    pub reserve_x: Pubkey,
    pub reserve_y: Pubkey,
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes: [u8; 32] = data
        .get(offset..offset + 32)
        .ok_or(error!(ArbError::InvalidAccountData))?
        .try_into()
        .map_err(|_| error!(ArbError::InvalidAccountData))?;
    Ok(Pubkey::new_from_array(bytes))
}

fn check_discriminator(data: &[u8], expected: &[u8; 8]) -> Result<()> {
    require!(
        data.get(..DISCRIMINATOR_LEN) == Some(expected.as_slice()),
        ArbError::InvalidAccountData
    );
    Ok(())
}

pub fn parse_pump_pool(data: &[u8]) -> Result<PumpPoolPrefix> {
    require!(
        data.len() >= PUMP_REQUIRED_PREFIX_LEN,
        ArbError::InvalidAccountData
    );
    check_discriminator(data, &PUMP_POOL_DISCRIMINATOR)?;
    // The cashback flag was appended after legacy Pool fields. Pools whose
    // accounts predate the extension are necessarily non-cashback pools.
    let is_cashback_coin = match data.get(PUMP_IS_CASHBACK_COIN_OFFSET) {
        None | Some(0) => false,
        Some(1) => true,
        Some(_) => return err!(ArbError::InvalidAccountData),
    };
    Ok(PumpPoolPrefix {
        base_mint: read_pubkey(data, PUMP_BASE_MINT_OFFSET)?,
        quote_mint: read_pubkey(data, PUMP_QUOTE_MINT_OFFSET)?,
        base_vault: read_pubkey(data, PUMP_BASE_VAULT_OFFSET)?,
        quote_vault: read_pubkey(data, PUMP_QUOTE_VAULT_OFFSET)?,
        coin_creator: read_pubkey(data, PUMP_COIN_CREATOR_OFFSET)?,
        is_cashback_coin,
    })
}

pub fn parse_meteora_pair(data: &[u8]) -> Result<MeteoraPairPrefix> {
    require!(
        data.len() >= METEORA_REQUIRED_PREFIX_LEN,
        ArbError::InvalidAccountData
    );
    check_discriminator(data, &METEORA_LB_PAIR_DISCRIMINATOR)?;
    Ok(MeteoraPairPrefix {
        token_x_mint: read_pubkey(data, METEORA_TOKEN_X_MINT_OFFSET)?,
        token_y_mint: read_pubkey(data, METEORA_TOKEN_Y_MINT_OFFSET)?,
        reserve_x: read_pubkey(data, METEORA_RESERVE_X_OFFSET)?,
        reserve_y: read_pubkey(data, METEORA_RESERVE_Y_OFFSET)?,
    })
}

pub fn validate_bin_array_data(data: &[u8], expected_lb_pair: &Pubkey) -> Result<()> {
    require!(
        data.len() >= METEORA_BIN_ARRAY_REQUIRED_PREFIX_LEN,
        ArbError::InvalidBinArray
    );
    require!(
        data.get(..DISCRIMINATOR_LEN) == Some(METEORA_BIN_ARRAY_DISCRIMINATOR.as_slice()),
        ArbError::InvalidBinArray
    );
    require_keys_eq!(
        read_pubkey(data, METEORA_BIN_ARRAY_LB_PAIR_OFFSET)?,
        *expected_lb_pair,
        ArbError::InvalidBinArray
    );
    Ok(())
}

pub fn validate_bin_arrays(accounts: &[AccountInfo<'_>], lb_pair: &Pubkey) -> Result<()> {
    validate_bin_array_count(accounts.len())?;
    for (position, account) in accounts.iter().enumerate() {
        require_keys_eq!(
            *account.owner,
            METEORA_DLMM_PROGRAM_ID,
            ArbError::InvalidBinArray
        );
        require!(
            account.is_writable && !account.is_signer,
            ArbError::InvalidBinArray
        );
        validate_bin_array_data(&account.try_borrow_data()?, lb_pair)?;
        let data = account.try_borrow_data()?;
        let index = i64::from_le_bytes(
            data.get(8..16)
                .ok_or(error!(ArbError::InvalidBinArray))?
                .try_into()
                .map_err(|_| error!(ArbError::InvalidBinArray))?,
        );
        for previous in &accounts[..position] {
            let previous_data = previous.try_borrow_data()?;
            let previous_index = i64::from_le_bytes(
                previous_data
                    .get(8..16)
                    .ok_or(error!(ArbError::InvalidBinArray))?
                    .try_into()
                    .map_err(|_| error!(ArbError::InvalidBinArray))?,
            );
            require!(index != previous_index, ArbError::InvalidBinArray);
        }
    }
    Ok(())
}

pub fn validate_bin_array_count(count: usize) -> Result<()> {
    require!(count > 0, ArbError::InvalidRemainingAccounts);
    require!(
        count <= crate::constants::MAX_METEORA_BIN_ARRAYS,
        ArbError::InvalidRemainingAccounts
    );
    Ok(())
}

pub fn validate_user_token_fields(
    actual_owner: &Pubkey,
    actual_mint: &Pubkey,
    expected_owner: &Pubkey,
    expected_mint: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *actual_owner,
        *expected_owner,
        ArbError::InvalidTokenAccountOwner
    );
    require_keys_eq!(*actual_mint, *expected_mint, ArbError::InvalidTokenMint);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_pubkey(data: &mut [u8], offset: usize, key: Pubkey) {
        data[offset..offset + 32].copy_from_slice(key.as_ref());
    }

    #[test]
    fn parses_pump_pool_prefix() {
        let mut data = vec![0_u8; PUMP_REQUIRED_PREFIX_LEN];
        data[..8].copy_from_slice(&PUMP_POOL_DISCRIMINATOR);
        let keys = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        put_pubkey(&mut data, PUMP_BASE_MINT_OFFSET, keys[0]);
        put_pubkey(&mut data, PUMP_QUOTE_MINT_OFFSET, keys[1]);
        put_pubkey(&mut data, PUMP_BASE_VAULT_OFFSET, keys[2]);
        put_pubkey(&mut data, PUMP_QUOTE_VAULT_OFFSET, keys[3]);
        put_pubkey(&mut data, PUMP_COIN_CREATOR_OFFSET, keys[4]);
        let parsed = parse_pump_pool(&data).unwrap();
        assert_eq!(parsed.base_mint, keys[0]);
        assert_eq!(parsed.quote_mint, keys[1]);
        assert_eq!(parsed.base_vault, keys[2]);
        assert_eq!(parsed.quote_vault, keys[3]);
        assert_eq!(parsed.coin_creator, keys[4]);
        assert!(!parsed.is_cashback_coin);
    }

    #[test]
    fn parses_cashback_flag_from_extended_pump_pool() {
        let mut data = vec![0_u8; PUMP_IS_CASHBACK_COIN_OFFSET + 1];
        data[..8].copy_from_slice(&PUMP_POOL_DISCRIMINATOR);
        data[PUMP_IS_CASHBACK_COIN_OFFSET] = 1;
        assert!(parse_pump_pool(&data).unwrap().is_cashback_coin);

        data[PUMP_IS_CASHBACK_COIN_OFFSET] = 2;
        assert!(parse_pump_pool(&data).is_err());
    }

    #[test]
    fn rejects_bad_discriminator_and_short_data() {
        assert!(parse_pump_pool(&[]).is_err());
        assert!(parse_meteora_pair(&vec![0_u8; METEORA_REQUIRED_PREFIX_LEN]).is_err());
    }

    #[test]
    fn validates_bin_array_membership() {
        let pair = Pubkey::new_unique();
        let mut data = vec![0_u8; METEORA_BIN_ARRAY_REQUIRED_PREFIX_LEN];
        data[..8].copy_from_slice(&METEORA_BIN_ARRAY_DISCRIMINATOR);
        put_pubkey(&mut data, METEORA_BIN_ARRAY_LB_PAIR_OFFSET, pair);
        assert!(validate_bin_array_data(&data, &pair).is_ok());
        assert!(validate_bin_array_data(&data, &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn validates_remaining_account_group_size() {
        assert!(validate_bin_array_count(0).is_err());
        assert!(validate_bin_array_count(1).is_ok());
        assert!(validate_bin_array_count(crate::constants::MAX_METEORA_BIN_ARRAYS + 1).is_err());
    }

    #[test]
    fn validates_user_token_mint_and_owner() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert!(validate_user_token_fields(&owner, &mint, &owner, &mint).is_ok());
        assert!(validate_user_token_fields(&Pubkey::new_unique(), &mint, &owner, &mint).is_err());
        assert!(validate_user_token_fields(&owner, &Pubkey::new_unique(), &owner, &mint).is_err());
    }
}
