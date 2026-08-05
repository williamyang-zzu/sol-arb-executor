#![allow(unexpected_cfgs)]

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, program::invoke_signed,
    program_error::ProgramError, pubkey::Pubkey,
};
use spl_token::solana_program::program_pack::Pack;

const PUMP_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const METEORA_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const PUMP_BUY: [u8; 8] = [198, 46, 21, 82, 180, 217, 232, 112];
const PUMP_SELL: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];
const METEORA_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
const AUTHORITY_SEED: &[u8] = b"vault-authority";
const FIXTURE_WRITE: &[u8; 8] = b"fixture!";

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.starts_with(FIXTURE_WRITE) {
        let target = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
        if target.owner != program_id || !target.is_writable {
            return Err(ProgramError::IllegalOwner);
        }
        let payload = &data[FIXTURE_WRITE.len()..];
        let mut target_data = target.try_borrow_mut_data()?;
        if payload.len() != target_data.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        target_data.copy_from_slice(payload);
        return Ok(());
    }
    if program_id == &PUMP_PROGRAM_ID {
        process_pump(accounts, data)
    } else if program_id == &METEORA_PROGRAM_ID {
        process_meteora(accounts, data)
    } else {
        // The same fixture is loaded as Pump's fee program. It is executable
        // but is not invoked by the mock swap paths.
        Ok(())
    }
}
fn read_u64(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    let bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .ok_or(ProgramError::InvalidInstructionData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes))
}

fn transfer<'a>(
    token_program: AccountInfo<'a>,
    source: AccountInfo<'a>,
    destination: AccountInfo<'a>,
    authority: AccountInfo<'a>,
    amount: u64,
    signer_seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    let ix = spl_token::instruction::transfer(
        token_program.key,
        source.key,
        destination.key,
        authority.key,
        &[],
        amount,
    )?;
    let infos = [source, destination, authority, token_program];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, &[seeds]),
        None => invoke_signed(&ix, &infos, &[]),
    }
}

fn process_pump(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 21 || data.len() < 24 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let discriminator: [u8; 8] = data[..8]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let amount_in = read_u64(data, 8)?;
    let min_out = read_u64(data, 16)?;
    let amount_out = amount_in
        .checked_mul(2)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if amount_out < min_out {
        return Err(ProgramError::Custom(1));
    }

    let token_program = accounts[11].clone();
    let user = accounts[1].clone();
    let vault_authority = accounts[18].clone();
    let bump = Pubkey::find_program_address(&[AUTHORITY_SEED], &PUMP_PROGRAM_ID).1;
    let bump_seed = [bump];
    let signer_seeds: &[&[u8]] = &[AUTHORITY_SEED, &bump_seed];

    if discriminator == PUMP_BUY {
        transfer(
            token_program.clone(),
            accounts[6].clone(),
            accounts[8].clone(),
            user,
            amount_in,
            None,
        )?;
        transfer(
            token_program,
            accounts[7].clone(),
            accounts[5].clone(),
            vault_authority,
            amount_out,
            Some(signer_seeds),
        )
    } else if discriminator == PUMP_SELL {
        transfer(
            token_program.clone(),
            accounts[5].clone(),
            accounts[7].clone(),
            user,
            amount_in,
            None,
        )?;
        transfer(
            token_program,
            accounts[8].clone(),
            accounts[6].clone(),
            vault_authority,
            amount_out,
            Some(signer_seeds),
        )
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

fn process_meteora(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 17 || data.len() < 24 || data[..8] != METEORA_SWAP2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_in = read_u64(data, 8)?;
    let min_out = read_u64(data, 16)?;
    let amount_out = amount_in
        .checked_mul(2)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if amount_out < min_out {
        return Err(ProgramError::Custom(2));
    }

    let input = spl_token::state::Account::unpack(&accounts[4].try_borrow_data()?)?;
    let reserve_x = spl_token::state::Account::unpack(&accounts[2].try_borrow_data()?)?;
    let (input_reserve, output_reserve) = if input.mint == reserve_x.mint {
        (accounts[2].clone(), accounts[3].clone())
    } else {
        (accounts[3].clone(), accounts[2].clone())
    };

    transfer(
        accounts[11].clone(),
        accounts[4].clone(),
        input_reserve,
        accounts[10].clone(),
        amount_in,
        None,
    )?;
    let bump = Pubkey::find_program_address(&[AUTHORITY_SEED], &METEORA_PROGRAM_ID).1;
    let bump_seed = [bump];
    let signer_seeds: &[&[u8]] = &[AUTHORITY_SEED, &bump_seed];
    transfer(
        accounts[11].clone(),
        output_reserve,
        accounts[5].clone(),
        accounts[14].clone(),
        amount_out,
        Some(signer_seeds),
    )
}
