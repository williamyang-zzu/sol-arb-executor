use anchor_lang::prelude::*;
use anchor_spl::token_interface::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint,
};

use crate::errors::ArbError;

const LEGACY_TOKEN_PROGRAM_ID: Pubkey = anchor_spl::token::ID;
const TOKEN_2022_PROGRAM_ID: Pubkey = anchor_spl::token_2022::ID;

fn is_supported_token_program(program: &Pubkey) -> bool {
    program == &LEGACY_TOKEN_PROGRAM_ID || program == &TOKEN_2022_PROGRAM_ID
}

pub fn validate_route_token_programs(
    wsol_mint: &AccountInfo<'_>,
    target_mint: &AccountInfo<'_>,
    user_wsol: &AccountInfo<'_>,
    user_target: &AccountInfo<'_>,
    wsol_token_program: &Pubkey,
    target_token_program: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *wsol_token_program,
        LEGACY_TOKEN_PROGRAM_ID,
        ArbError::UnsupportedTokenProgram
    );
    require!(
        is_supported_token_program(target_token_program),
        ArbError::UnsupportedTokenProgram
    );
    require_keys_eq!(
        *wsol_mint.owner,
        *wsol_token_program,
        ArbError::UnsupportedTokenProgram
    );
    require_keys_eq!(
        *user_wsol.owner,
        *wsol_token_program,
        ArbError::UnsupportedTokenProgram
    );
    require_keys_eq!(
        *target_mint.owner,
        *target_token_program,
        ArbError::UnsupportedTokenProgram
    );
    require_keys_eq!(
        *user_target.owner,
        *target_token_program,
        ArbError::UnsupportedTokenProgram
    );
    Ok(())
}

pub fn validate_supported_target_mint(target_mint: &AccountInfo<'_>) -> Result<()> {
    if target_mint.owner == &LEGACY_TOKEN_PROGRAM_ID {
        return Ok(());
    }
    require_keys_eq!(
        *target_mint.owner,
        TOKEN_2022_PROGRAM_ID,
        ArbError::UnsupportedTokenProgram
    );

    let data = target_mint.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&data)
        .map_err(|_| error!(ArbError::InvalidAccountData))?;
    for extension in mint
        .get_extension_types()
        .map_err(|_| error!(ArbError::InvalidAccountData))?
    {
        require!(
            matches!(
                extension,
                ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
            ),
            ArbError::UnsupportedTokenExtension
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_two_supported_token_programs() {
        assert!(is_supported_token_program(&LEGACY_TOKEN_PROGRAM_ID));
        assert!(is_supported_token_program(&TOKEN_2022_PROGRAM_ID));
        assert!(!is_supported_token_program(&Pubkey::new_unique()));
    }

    #[test]
    fn extension_allowlist_is_intentionally_narrow() {
        for extension in [ExtensionType::MetadataPointer, ExtensionType::TokenMetadata] {
            assert!(matches!(
                extension,
                ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
            ));
        }
        for extension in [
            ExtensionType::TransferFeeConfig,
            ExtensionType::TransferHook,
            ExtensionType::NonTransferable,
            ExtensionType::PermanentDelegate,
        ] {
            assert!(!matches!(
                extension,
                ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
            ));
        }
    }
}
