use anchor_lang::prelude::*;

#[error_code]
pub enum ArbError {
    #[msg("A supplied CPI program does not match the pinned protocol program ID")]
    InvalidProgramId,
    #[msg("A token mint does not match the route or pool")]
    InvalidTokenMint,
    #[msg("A user token account is not owned by the signing trader")]
    InvalidTokenAccountOwner,
    #[msg("A DEX pool account or one of its vault relationships is invalid")]
    InvalidPool,
    #[msg("Meteora remaining accounts are empty, too numerous, or malformed")]
    InvalidRemainingAccounts,
    #[msg("A Meteora bin array has the wrong owner, discriminator, or lb_pair")]
    InvalidBinArray,
    #[msg("The expected output balance did not increase during a swap leg")]
    BalanceDidNotIncreaseAsExpected,
    #[msg("Checked integer arithmetic failed")]
    ArithmeticOverflow,
    #[msg("The token program is unsupported or does not own the supplied mint/account")]
    UnsupportedTokenProgram,
    #[msg("The Token-2022 mint contains an unsupported extension")]
    UnsupportedTokenExtension,
    #[msg("The fixed route accounts are inconsistent with the selected direction")]
    InvalidRouteAccounts,
    #[msg("A foreign protocol account is shorter than its verified IDL layout")]
    InvalidAccountData,
}
