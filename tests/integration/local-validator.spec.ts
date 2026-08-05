import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  createWrappedNativeAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

const RPC_URL = process.env.INTEGRATION_RPC_URL ?? "http://127.0.0.1:18899";
const PUMP_PROGRAM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);
const PUMP_FEE_PROGRAM = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);
const METEORA_PROGRAM = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const MEMO_PROGRAM = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const FIXTURE_WRITE = Buffer.from("fixture!");
const PUMP_POOL_DISCRIMINATOR = Buffer.from([
  241, 154, 109, 4, 17, 177, 109, 188,
]);
const METEORA_PAIR_DISCRIMINATOR = Buffer.from([
  33, 11, 49, 98, 181, 101, 177, 13,
]);
const METEORA_BIN_DISCRIMINATOR = Buffer.from([
  92, 142, 92, 220, 5, 148, 70, 181,
]);

type RouteAccounts = Record<string, PublicKey>;

describe("local-validator SBF CPI integration", function () {
  this.timeout(120_000);

  const connection = new Connection(RPC_URL, "confirmed");
  const trader = Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(trader), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = JSON.parse(
    readFileSync(resolve("target/idl/sol_arb_executor.json"), "utf8"),
  ) as Idl;
  const program = new Program(idl, provider);

  let accounts: RouteAccounts;
  let binArray: PublicKey;
  let wrongPairBinArray: PublicKey;
  let lookupTable: AddressLookupTableAccount;

  async function send(
    ...instructions: TransactionInstruction[]
  ): Promise<string> {
    return sendAndConfirmTransaction(
      connection,
      new Transaction().add(...instructions),
      [trader],
      { commitment: "confirmed" },
    );
  }

  async function sendV0(
    ...instructions: TransactionInstruction[]
  ): Promise<string> {
    const latest = await connection.getLatestBlockhash("finalized");
    const message = new TransactionMessage({
      payerKey: trader.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message([lookupTable]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([trader]);
    const signature = await connection.sendTransaction(transaction, {
      maxRetries: 5,
      preflightCommitment: "finalized",
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = (
        await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (status?.err) {
        throw new Error(`InstructionError: ${JSON.stringify(status.err)}`);
      }
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return signature;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error(`transaction ${signature} was not confirmed`);
  }

  async function createSystemAccount(space = 0): Promise<PublicKey> {
    const account = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: trader.publicKey,
          newAccountPubkey: account.publicKey,
          lamports: Math.max(lamports, 1),
          space,
          programId: SystemProgram.programId,
        }),
      ),
      [trader, account],
      { commitment: "confirmed" },
    );
    return account.publicKey;
  }

  async function createForeignAccount(
    owner: PublicKey,
    data: Buffer,
  ): Promise<PublicKey> {
    const account = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(
      data.length,
    );
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: trader.publicKey,
          newAccountPubkey: account.publicKey,
          lamports,
          space: data.length,
          programId: owner,
        }),
      ),
      [trader, account],
      { commitment: "confirmed" },
    );
    await send(
      new TransactionInstruction({
        programId: owner,
        keys: [
          { pubkey: account.publicKey, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([FIXTURE_WRITE, data]),
      }),
    );
    return account.publicKey;
  }

  async function fundAddress(address: PublicKey): Promise<void> {
    await send(
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: address,
        lamports: 1_000_000,
      }),
    );
  }

  before(async () => {
    const airdrop = await connection.requestAirdrop(
      trader.publicKey,
      100 * 1_000_000_000,
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: airdrop, ...latest },
      "confirmed",
    );

    const targetMint = await createMint(
      connection,
      trader,
      trader.publicKey,
      null,
      6,
    );
    const [pumpAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault-authority")],
      PUMP_PROGRAM,
    );
    const [meteoraAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault-authority")],
      METEORA_PROGRAM,
    );
    await fundAddress(pumpAuthority);
    await fundAddress(meteoraAuthority);

    const userWsol = await createWrappedNativeAccount(
      connection,
      trader,
      trader.publicKey,
      10_000_000,
    );
    const userTarget = await createAccount(
      connection,
      trader,
      targetMint,
      trader.publicKey,
    );
    await mintTo(connection, trader, targetMint, userTarget, trader, 1_000_000);

    const pumpBaseVault = await createAccount(
      connection,
      trader,
      targetMint,
      pumpAuthority,
      Keypair.generate(),
    );
    await mintTo(
      connection,
      trader,
      targetMint,
      pumpBaseVault,
      trader,
      20_000_000,
    );
    const pumpQuoteVault = await createWrappedNativeAccount(
      connection,
      trader,
      pumpAuthority,
      20_000_000,
      Keypair.generate(),
    );
    const meteoraReserveX = await createAccount(
      connection,
      trader,
      targetMint,
      meteoraAuthority,
      Keypair.generate(),
    );
    await mintTo(
      connection,
      trader,
      targetMint,
      meteoraReserveX,
      trader,
      20_000_000,
    );
    const meteoraReserveY = await createWrappedNativeAccount(
      connection,
      trader,
      meteoraAuthority,
      20_000_000,
      Keypair.generate(),
    );

    const pumpPoolData = Buffer.alloc(203);
    PUMP_POOL_DISCRIMINATOR.copy(pumpPoolData, 0);
    targetMint.toBuffer().copy(pumpPoolData, 43);
    NATIVE_MINT.toBuffer().copy(pumpPoolData, 75);
    pumpBaseVault.toBuffer().copy(pumpPoolData, 139);
    pumpQuoteVault.toBuffer().copy(pumpPoolData, 171);
    const pumpPool = await createForeignAccount(PUMP_PROGRAM, pumpPoolData);

    const pairData = Buffer.alloc(216);
    METEORA_PAIR_DISCRIMINATOR.copy(pairData, 0);
    targetMint.toBuffer().copy(pairData, 88);
    NATIVE_MINT.toBuffer().copy(pairData, 120);
    meteoraReserveX.toBuffer().copy(pairData, 152);
    meteoraReserveY.toBuffer().copy(pairData, 184);
    const meteoraLbPair = await createForeignAccount(METEORA_PROGRAM, pairData);

    const binData = Buffer.alloc(56);
    METEORA_BIN_DISCRIMINATOR.copy(binData, 0);
    meteoraLbPair.toBuffer().copy(binData, 24);
    binArray = await createForeignAccount(METEORA_PROGRAM, binData);
    const wrongPairBinData = Buffer.from(binData);
    Keypair.generate().publicKey.toBuffer().copy(wrongPairBinData, 24);
    wrongPairBinArray = await createForeignAccount(
      METEORA_PROGRAM,
      wrongPairBinData,
    );

    const pumpFeeRecipient = Keypair.generate().publicKey;
    const pumpFeeRecipientToken = await createWrappedNativeAccount(
      connection,
      trader,
      pumpFeeRecipient,
      1_000_000,
    );
    const pumpCreatorVault = await createAccount(
      connection,
      trader,
      targetMint,
      pumpAuthority,
      Keypair.generate(),
    );
    const meteoraBitmap = await createForeignAccount(
      METEORA_PROGRAM,
      Buffer.alloc(8),
    );
    const meteoraHostFee = await createForeignAccount(
      METEORA_PROGRAM,
      Buffer.alloc(8),
    );
    const meteoraOracle = await createForeignAccount(
      METEORA_PROGRAM,
      Buffer.alloc(8),
    );

    accounts = {
      trader: trader.publicKey,
      wsolMint: NATIVE_MINT,
      targetMint,
      userWsol,
      userTarget,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      pumpProgram: PUMP_PROGRAM,
      pumpPool,
      pumpGlobalConfig: await createSystemAccount(),
      pumpPoolBaseTokenAccount: pumpBaseVault,
      pumpPoolQuoteTokenAccount: pumpQuoteVault,
      pumpProtocolFeeRecipient: pumpFeeRecipient,
      pumpProtocolFeeRecipientTokenAccount: pumpFeeRecipientToken,
      pumpEventAuthority: await createSystemAccount(),
      pumpCoinCreatorVaultAta: pumpCreatorVault,
      pumpCoinCreatorVaultAuthority: pumpAuthority,
      pumpGlobalVolumeAccumulator: await createSystemAccount(),
      pumpUserVolumeAccumulator: await createSystemAccount(),
      pumpFeeConfig: await createSystemAccount(),
      pumpFeeProgram: PUMP_FEE_PROGRAM,
      meteoraProgram: METEORA_PROGRAM,
      meteoraLbPair,
      meteoraBinArrayBitmapExtension: meteoraBitmap,
      meteoraReserveX,
      meteoraReserveY,
      meteoraOracle,
      meteoraHostFeeIn: meteoraHostFee,
      memoProgram: MEMO_PROGRAM,
      meteoraEventAuthority: meteoraAuthority,
    };

    // ALT creation requires a slot already present in the SlotHashes sysvar;
    // an optimistic confirmed slot can be ahead of that on a fresh validator.
    const recentSlot = await connection.getSlot("finalized");
    const [createLookupTable, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: trader.publicKey,
        payer: trader.publicKey,
        recentSlot,
      });
    await send(createLookupTable);
    const lookupAddresses = [
      ...new Set([...Object.values(accounts), binArray].map(String)),
    ]
      .map((address) => new PublicKey(address))
      .filter((address) => !address.equals(trader.publicKey));
    for (let index = 0; index < lookupAddresses.length; index += 20) {
      await send(
        AddressLookupTableProgram.extendLookupTable({
          payer: trader.publicKey,
          authority: trader.publicKey,
          lookupTable: lookupTableAddress,
          addresses: lookupAddresses.slice(index, index + 20),
        }),
      );
    }
    const activationSlot = await connection.getSlot("confirmed");
    while ((await connection.getSlot("finalized")) <= activationSlot) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    const loadedLookupTable = await connection.getAddressLookupTable(
      lookupTableAddress,
      { commitment: "finalized" },
    );
    if (!loadedLookupTable.value) {
      throw new Error("failed to load integration address table");
    }
    lookupTable = loadedLookupTable.value;
  });

  async function assertInnerPrograms(signature: string): Promise<number> {
    const transaction = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(transaction).not.to.equal(null);
    const keys = transaction!.transaction.message.getAccountKeys({
      accountKeysFromLookups: transaction!.meta!.loadedAddresses,
    });
    const invoked = (transaction!.meta!.innerInstructions ?? []).flatMap(
      (group) =>
        group.instructions.map((ix) => keys.get(ix.programIdIndex)!.toBase58()),
    );
    expect(invoked).to.include(PUMP_PROGRAM.toBase58());
    expect(invoked).to.include(METEORA_PROGRAM.toBase58());
    return Number(transaction!.meta!.computeUnitsConsumed ?? 0);
  }

  it("executes Pump -> Meteora through two inner CPI programs", async () => {
    const beforeWsol = (await getAccount(connection, accounts.userWsol)).amount;
    const beforeTarget = (await getAccount(connection, accounts.userTarget))
      .amount;
    const route = await program.methods
      .executePumpToMeteora({
        pumpSpendableWsolIn: new BN(1_000),
        pumpMinTargetOut: new BN(1_900),
        meteoraMinWsolOut: new BN(3_900),
      })
      .accounts(accounts)
      .remainingAccounts([
        { pubkey: binArray, isSigner: false, isWritable: true },
      ])
      .instruction();
    const signature = await sendV0(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      route,
    );

    expect((await getAccount(connection, accounts.userWsol)).amount).to.equal(
      beforeWsol + 3_000n,
    );
    expect((await getAccount(connection, accounts.userTarget)).amount).to.equal(
      beforeTarget,
    );
    expect(await assertInnerPrograms(signature)).to.be.greaterThan(0);
  });

  it("executes Meteora -> Pump through two inner CPI programs", async () => {
    const beforeWsol = (await getAccount(connection, accounts.userWsol)).amount;
    const beforeTarget = (await getAccount(connection, accounts.userTarget))
      .amount;
    const route = await program.methods
      .executeMeteoraToPump({
        meteoraWsolIn: new BN(1_000),
        meteoraMinTargetOut: new BN(1_900),
        pumpMinWsolOut: new BN(3_900),
      })
      .accounts(accounts)
      .remainingAccounts([
        { pubkey: binArray, isSigner: false, isWritable: true },
      ])
      .instruction();
    const signature = await sendV0(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      route,
    );

    expect((await getAccount(connection, accounts.userWsol)).amount).to.equal(
      beforeWsol + 3_000n,
    );
    expect((await getAccount(connection, accounts.userTarget)).amount).to.equal(
      beforeTarget,
    );
    expect(await assertInnerPrograms(signature)).to.be.greaterThan(0);
  });

  it("rolls back the first CPI when the second CPI fails", async () => {
    const beforeWsol = (await getAccount(connection, accounts.userWsol)).amount;
    const beforeTarget = (await getAccount(connection, accounts.userTarget))
      .amount;
    const pumpBaseBefore = (
      await getAccount(connection, accounts.pumpPoolBaseTokenAccount)
    ).amount;
    const pumpQuoteBefore = (
      await getAccount(connection, accounts.pumpPoolQuoteTokenAccount)
    ).amount;
    const route = await program.methods
      .executePumpToMeteora({
        pumpSpendableWsolIn: new BN(1_000),
        pumpMinTargetOut: new BN(1_900),
        meteoraMinWsolOut: new BN(9_000),
      })
      .accounts(accounts)
      .remainingAccounts([
        { pubkey: binArray, isSigner: false, isWritable: true },
      ])
      .instruction();

    let failed = false;
    let failureMessage = "";
    try {
      await sendV0(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        route,
      );
    } catch (error) {
      failed = true;
      failureMessage = String(error);
    }
    expect(failed).to.equal(true);
    expect(failureMessage).to.match(
      /custom program error|0x2|InstructionError/,
    );
    expect((await getAccount(connection, accounts.userWsol)).amount).to.equal(
      beforeWsol,
    );
    expect((await getAccount(connection, accounts.userTarget)).amount).to.equal(
      beforeTarget,
    );
    expect(
      (await getAccount(connection, accounts.pumpPoolBaseTokenAccount)).amount,
    ).to.equal(pumpBaseBefore);
    expect(
      (await getAccount(connection, accounts.pumpPoolQuoteTokenAccount)).amount,
    ).to.equal(pumpQuoteBefore);
  });

  it("rejects a bin array that belongs to a different LB pair", async () => {
    const beforeWsol = (await getAccount(connection, accounts.userWsol)).amount;
    const beforeTarget = (await getAccount(connection, accounts.userTarget))
      .amount;
    const route = await program.methods
      .executeMeteoraToPump({
        meteoraWsolIn: new BN(1_000),
        meteoraMinTargetOut: new BN(1_900),
        pumpMinWsolOut: new BN(3_900),
      })
      .accounts(accounts)
      .remainingAccounts([
        { pubkey: wrongPairBinArray, isSigner: false, isWritable: true },
      ])
      .instruction();

    let failureMessage = "";
    try {
      await sendV0(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        route,
      );
    } catch (error) {
      failureMessage = String(error);
    }
    expect(failureMessage).to.match(/custom program error|InstructionError/);
    expect((await getAccount(connection, accounts.userWsol)).amount).to.equal(
      beforeWsol,
    );
    expect((await getAccount(connection, accounts.userTarget)).amount).to.equal(
      beforeTarget,
    );
  });
});
