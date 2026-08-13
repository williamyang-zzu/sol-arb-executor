import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  ammCreatorVaultPda,
  getPumpAmmProgram,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-sdk";
import { GLOBAL_CONFIG_PDA, poolV2Pda } from "@pump-fun/pump-swap-sdk";
import { Surfnet } from "@solana/surfpool";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import DLMM, { MEMO_PROGRAM_ID, deriveEventAuthority } from "@meteora-ag/dlmm";
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
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { computeBudgetInstructions } from "../../scripts/sender-pipeline";

const METEORA_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const EXECUTOR_PROGRAM_ID = new PublicKey(
  "RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51",
);
const SUCCESS_PATH_CU_LIMIT = 300_000;
const SUCCESS_PATH_CU_PRICE_MICRO_LAMPORTS = 300;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

describe("Surfpool real-protocol CPI compatibility", function () {
  this.timeout(180_000);

  let surfnet: Surfnet;
  let connection: Connection;
  let trader: Keypair;
  let program: Program;

  beforeEach(() => {
    const payer = Surfnet.newKeypair();
    trader = Keypair.fromSecretKey(Uint8Array.from(payer.secretKey));
    surfnet = Surfnet.startWithConfig({
      remoteRpcUrl:
        process.env.SURFPOOL_MAINNET_RPC_URL ??
        process.env.RPC_URL ??
        "https://api.mainnet-beta.solana.com",
      blockProductionMode: "transaction",
      payerSecretKey: Array.from(trader.secretKey),
      airdropSol: 100_000_000_000,
    });
    surfnet.deploy({
      programId: EXECUTOR_PROGRAM_ID.toBase58(),
      soPath: resolve("target/deploy/sol_arb_executor.so"),
      idlPath: resolve("target/idl/sol_arb_executor.json"),
    });
    connection = new Connection(surfnet.rpcUrl, "processed");
    const provider = new AnchorProvider(connection, new Wallet(trader), {
      commitment: "processed",
      preflightCommitment: "processed",
    });
    const idl = JSON.parse(
      readFileSync(resolve("target/idl/sol_arb_executor.json"), "utf8"),
    ) as Idl;
    program = new Program(idl, provider);
  });

  afterEach(() => {
    surfnet?.stop();
  });

  async function sendLegacy(
    ...instructions: TransactionInstruction[]
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await sendAndConfirmTransaction(
          connection,
          new Transaction().add(...instructions),
          [trader],
          { commitment: "processed", preflightCommitment: "processed" },
        );
      } catch (error) {
        const blockhashExpired = String(error).includes("Blockhash not found");
        if (!blockhashExpired || attempt === 2) throw error;
      }
    }
    throw new Error("unreachable Surfpool transaction retry state");
  }

  async function createLookupTable(
    addresses: PublicKey[],
  ): Promise<AddressLookupTableAccount> {
    const recentSlot = await connection.getSlot("processed");
    const [createIx, address] = AddressLookupTableProgram.createLookupTable({
      authority: trader.publicKey,
      payer: trader.publicKey,
      recentSlot,
    });
    await sendLegacy(createIx);
    const unique = [...new Set(addresses.map(String))]
      .map((value) => new PublicKey(value))
      .filter((value) => !value.equals(trader.publicKey));
    for (let index = 0; index < unique.length; index += 20) {
      await sendLegacy(
        AddressLookupTableProgram.extendLookupTable({
          authority: trader.publicKey,
          payer: trader.publicKey,
          lookupTable: address,
          addresses: unique.slice(index, index + 20),
        }),
      );
    }
    await sendLegacy(
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: trader.publicKey,
        lamports: 0,
      }),
    );
    const response = await connection.getAddressLookupTable(address, {
      commitment: "processed",
    });
    if (!response.value)
      throw new Error("Surfpool did not create the address table");
    return response.value;
  }

  async function tokenProgramForMint(mint: PublicKey): Promise<PublicKey> {
    const mintAccount = await connection.getAccountInfo(mint, "processed");
    if (!mintAccount) throw new Error(`Mint ${mint} was not found`);
    expect(
      mintAccount.owner.equals(TOKEN_PROGRAM_ID) ||
        mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID),
    ).to.equal(true);
    return mintAccount.owner;
  }

  async function buildBestDirectionFixture() {
    const pumpPoolAddress = new PublicKey(required("SURFPOOL_PUMP_POOL"));
    const pumpGlobalAddress = process.env.SURFPOOL_PUMP_GLOBAL_CONFIG
      ? new PublicKey(process.env.SURFPOOL_PUMP_GLOBAL_CONFIG)
      : GLOBAL_CONFIG_PDA;
    const meteoraPoolAddress = new PublicKey(required("SURFPOOL_METEORA_POOL"));
    const pumpProgram = getPumpAmmProgram(connection);
    const pumpPool = await pumpProgram.account.pool.fetch(pumpPoolAddress);
    const targetMint = process.env.SURFPOOL_TARGET_MINT
      ? new PublicKey(process.env.SURFPOOL_TARGET_MINT)
      : pumpPool.baseMint;
    const targetTokenProgram = await tokenProgramForMint(targetMint);

    surfnet.fundToken(
      trader.publicKey.toBase58(),
      NATIVE_MINT.toBase58(),
      2_000_000_000,
    );
    surfnet.fundToken(
      trader.publicKey.toBase58(),
      targetMint.toBase58(),
      1_000_000_000,
      targetTokenProgram.toBase58(),
    );
    const userWsol = new PublicKey(
      surfnet.getAta(trader.publicKey.toBase58(), NATIVE_MINT.toBase58()),
    );
    const userTarget = new PublicKey(
      surfnet.getAta(
        trader.publicKey.toBase58(),
        targetMint.toBase58(),
        targetTokenProgram.toBase58(),
      ),
    );
    const pumpGlobal =
      await pumpProgram.account.globalConfig.fetch(pumpGlobalAddress);
    const protocolFeeRecipient = pumpGlobal.protocolFeeRecipients[0];
    const buybackFeeRecipient = pumpGlobal.buybackFeeRecipients[0];
    const coinCreatorVaultAuthority = ammCreatorVaultPda(pumpPool.coinCreator);
    const pumpFeeConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), PUMP_AMM_PROGRAM_ID.toBuffer()],
      PUMP_FEE_PROGRAM_ID,
    )[0];
    const dlmm = await DLMM.create(connection, meteoraPoolAddress);
    const targetIsX = dlmm.lbPair.tokenXMint.equals(targetMint);
    expect(
      targetIsX
        ? dlmm.lbPair.tokenYMint.equals(NATIVE_MINT)
        : dlmm.lbPair.tokenXMint.equals(NATIVE_MINT),
    ).to.equal(true);
    const forwardArrays = await dlmm.getBinArrayForSwap(targetIsX, 2);
    const reverseArrays = await dlmm.getBinArrayForSwap(!targetIsX, 2);
    const binArrays = [
      ...new Map(
        [...forwardArrays, ...reverseArrays].map((array) => [
          array.publicKey.toBase58(),
          array,
        ]),
      ).values(),
    ];
    expect(binArrays.length).to.be.greaterThan(0).and.at.most(4);

    const routeAccounts: Record<string, PublicKey> = {
      trader: trader.publicKey,
      wsolMint: NATIVE_MINT,
      targetMint,
      userWsol,
      userTarget,
      wsolTokenProgram: TOKEN_PROGRAM_ID,
      targetTokenProgram,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      pumpProgram: PUMP_AMM_PROGRAM_ID,
      pumpPool: pumpPoolAddress,
      pumpGlobalConfig: pumpGlobalAddress,
      pumpPoolBaseTokenAccount: pumpPool.poolBaseTokenAccount,
      pumpPoolQuoteTokenAccount: pumpPool.poolQuoteTokenAccount,
      pumpProtocolFeeRecipient: protocolFeeRecipient,
      pumpProtocolFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        protocolFeeRecipient,
        true,
      ),
      pumpEventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      pumpCoinCreatorVaultAta: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        coinCreatorVaultAuthority,
        true,
      ),
      pumpCoinCreatorVaultAuthority: coinCreatorVaultAuthority,
      pumpGlobalVolumeAccumulator: AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
      pumpUserVolumeAccumulator: userVolumeAccumulatorPda(
        trader.publicKey,
        PUMP_AMM_PROGRAM_ID,
      ),
      pumpFeeConfig,
      pumpFeeProgram: PUMP_FEE_PROGRAM_ID,
      pumpPoolV2: poolV2Pda(targetMint),
      pumpBuybackFeeRecipient: buybackFeeRecipient,
      pumpBuybackFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        buybackFeeRecipient,
        true,
      ),
      meteoraProgram: METEORA_PROGRAM_ID,
      meteoraLbPair: meteoraPoolAddress,
      meteoraBinArrayBitmapExtension:
        dlmm.binArrayBitmapExtension?.publicKey ?? METEORA_PROGRAM_ID,
      meteoraReserveX: dlmm.lbPair.reserveX,
      meteoraReserveY: dlmm.lbPair.reserveY,
      meteoraOracle: dlmm.lbPair.oracle,
      meteoraHostFeeIn: METEORA_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      meteoraEventAuthority: deriveEventAuthority(METEORA_PROGRAM_ID)[0],
    };
    return {
      routeAccounts,
      binArrays,
      forwardArrays,
      reverseArrays,
      userWsol,
      userTarget,
      targetTokenProgram,
      targetIsX,
      pumpQuoteVault: pumpPool.poolQuoteTokenAccount,
    };
  }

  async function setTokenAccountAmount(address: PublicKey, amount: bigint) {
    const account = await connection.getAccountInfo(address, "processed");
    if (!account) throw new Error(`Token account ${address} was not found`);
    const data = Buffer.from(account.data);
    data.writeBigUInt64LE(amount, 64);
    surfnet.setAccount(
      address.toBase58(),
      account.lamports,
      data,
      account.owner.toBase58(),
    );
  }

  async function clearDlmmOutputLiquidity(
    addresses: PublicKey[],
    swapForY: boolean,
  ) {
    const binArrayHeaderSize = 8 + 48;
    const binSize = 144;
    const outputAmountOffset = swapForY ? 8 : 0;
    for (const address of addresses) {
      const account = await connection.getAccountInfo(address, "processed");
      if (!account) throw new Error(`Bin array ${address} was not found`);
      const data = Buffer.from(account.data);
      for (let index = 0; index < 70; index += 1) {
        data.writeBigUInt64LE(
          0n,
          binArrayHeaderSize + index * binSize + outputAmountOffset,
        );
      }
      surfnet.setAccount(
        address.toBase58(),
        account.lamports,
        data,
        account.owner.toBase58(),
      );
    }
  }

  async function executeBestDirection(
    fixture: Awaited<ReturnType<typeof buildBestDirectionFixture>>,
    expectedFirstProgram: PublicKey,
  ) {
    const amountIn = new BN(process.env.SURFPOOL_WSOL_INPUT ?? "1000000");
    const route = await program.methods
      .executeBestDirection({
        wsolAmountIn: amountIn,
        minProfitLamports: new BN(process.env.SURFPOOL_MIN_PROFIT ?? "1"),
      })
      .accounts(fixture.routeAccounts)
      .remainingAccounts(
        fixture.binArrays.map(({ publicKey }) => ({
          pubkey: publicKey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();
    const lookupTable = await createLookupTable([
      ...Object.values(fixture.routeAccounts),
      ...fixture.binArrays.map(({ publicKey }) => publicKey),
    ]);
    const initialWsol = (await getAccount(connection, fixture.userWsol)).amount;
    const initialTarget = (
      await getAccount(
        connection,
        fixture.userTarget,
        undefined,
        fixture.targetTokenProgram,
      )
    ).amount;
    const latest = await connection.getLatestBlockhash("processed");
    const message = new TransactionMessage({
      payerKey: trader.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [
        ...computeBudgetInstructions(
          SUCCESS_PATH_CU_LIMIT,
          SUCCESS_PATH_CU_PRICE_MICRO_LAMPORTS,
        ),
        route,
      ],
    }).compileToV0Message([lookupTable]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([trader]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "processed",
    });
    const result = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(result?.meta?.err).to.equal(null);
    const logs = result?.meta?.logMessages ?? [];
    const pumpInvocation = logs.findIndex((line) =>
      line.includes(`Program ${PUMP_AMM_PROGRAM_ID.toBase58()} invoke [2]`),
    );
    const meteoraInvocation = logs.findIndex((line) =>
      line.includes(`Program ${METEORA_PROGRAM_ID.toBase58()} invoke [2]`),
    );
    expect(pumpInvocation).to.be.greaterThan(-1);
    expect(meteoraInvocation).to.be.greaterThan(-1);
    if (expectedFirstProgram.equals(PUMP_AMM_PROGRAM_ID)) {
      expect(pumpInvocation).to.be.lessThan(meteoraInvocation);
    } else {
      expect(meteoraInvocation).to.be.lessThan(pumpInvocation);
    }
    const finalWsol = (await getAccount(connection, fixture.userWsol)).amount;
    const finalTarget = (
      await getAccount(
        connection,
        fixture.userTarget,
        undefined,
        fixture.targetTokenProgram,
      )
    ).amount;
    const computeUnits = Number(result?.meta?.computeUnitsConsumed ?? 0);
    expect(finalWsol > initialWsol).to.equal(true);
    expect(finalTarget).to.equal(initialTarget);
    expect(computeUnits)
      .to.be.greaterThan(0)
      .and.lessThan(SUCCESS_PATH_CU_LIMIT);
    return { signature, computeUnits, profit: finalWsol - initialWsol };
  }

  async function executeFixedDirection(
    fixture: Awaited<ReturnType<typeof buildBestDirectionFixture>>,
    direction: "pump-to-meteora" | "meteora-to-pump",
  ) {
    const amountIn = new BN(process.env.SURFPOOL_WSOL_INPUT ?? "1000000");
    const args = {
      wsolAmountIn: amountIn,
      minProfitLamports: new BN(process.env.SURFPOOL_MIN_PROFIT ?? "1"),
    };
    const route = await (
      direction === "pump-to-meteora"
        ? program.methods.executePumpToMeteora(args)
        : program.methods.executeMeteoraToPump(args)
    )
      .accounts(fixture.routeAccounts)
      .remainingAccounts(
        (direction === "pump-to-meteora"
          ? fixture.forwardArrays
          : fixture.reverseArrays
        ).map(({ publicKey }) => ({
          pubkey: publicKey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();
    const selectedArrays =
      direction === "pump-to-meteora"
        ? fixture.forwardArrays
        : fixture.reverseArrays;
    const lookupTable = await createLookupTable([
      ...Object.values(fixture.routeAccounts),
      ...selectedArrays.map(({ publicKey }) => publicKey),
    ]);
    const initialWsol = (await getAccount(connection, fixture.userWsol)).amount;
    const initialTarget = (
      await getAccount(
        connection,
        fixture.userTarget,
        undefined,
        fixture.targetTokenProgram,
      )
    ).amount;
    const latest = await connection.getLatestBlockhash("processed");
    const message = new TransactionMessage({
      payerKey: trader.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [
        ...computeBudgetInstructions(
          SUCCESS_PATH_CU_LIMIT,
          SUCCESS_PATH_CU_PRICE_MICRO_LAMPORTS,
        ),
        route,
      ],
    }).compileToV0Message([lookupTable]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([trader]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "processed",
    });
    const result = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(result?.meta?.err).to.equal(null);
    const logs = result?.meta?.logMessages ?? [];
    const pumpInvocation = logs.findIndex((line) =>
      line.includes(`Program ${PUMP_AMM_PROGRAM_ID.toBase58()} invoke [2]`),
    );
    const meteoraInvocation = logs.findIndex((line) =>
      line.includes(`Program ${METEORA_PROGRAM_ID.toBase58()} invoke [2]`),
    );
    expect(pumpInvocation).to.be.greaterThan(-1);
    expect(meteoraInvocation).to.be.greaterThan(-1);
    if (direction === "pump-to-meteora") {
      expect(pumpInvocation).to.be.lessThan(meteoraInvocation);
    } else {
      expect(meteoraInvocation).to.be.lessThan(pumpInvocation);
    }
    const finalWsol = (await getAccount(connection, fixture.userWsol)).amount;
    const finalTarget = (
      await getAccount(
        connection,
        fixture.userTarget,
        undefined,
        fixture.targetTokenProgram,
      )
    ).amount;
    const computeUnits = Number(result?.meta?.computeUnitsConsumed ?? 0);
    expect(
      finalWsol - initialWsol >= BigInt(args.minProfitLamports.toString()),
    ).to.equal(true);
    expect(finalTarget).to.equal(initialTarget);
    expect(computeUnits)
      .to.be.greaterThan(0)
      .and.lessThan(SUCCESS_PATH_CU_LIMIT);
    return { signature, computeUnits, profit: finalWsol - initialWsol };
  }

  it("executes PumpSwap buy followed by Meteora DLMM swap2", async () => {
    const pumpPoolAddress = new PublicKey(required("SURFPOOL_PUMP_POOL"));
    const pumpGlobalAddress = process.env.SURFPOOL_PUMP_GLOBAL_CONFIG
      ? new PublicKey(process.env.SURFPOOL_PUMP_GLOBAL_CONFIG)
      : GLOBAL_CONFIG_PDA;
    const meteoraPoolAddress = new PublicKey(required("SURFPOOL_METEORA_POOL"));
    const spendableWsol = Number(process.env.SURFPOOL_WSOL_INPUT ?? "1000000");

    const pumpProgram = getPumpAmmProgram(connection);
    const pumpPool = await pumpProgram.account.pool.fetch(pumpPoolAddress);
    const targetMint = process.env.SURFPOOL_TARGET_MINT
      ? new PublicKey(process.env.SURFPOOL_TARGET_MINT)
      : pumpPool.baseMint;
    const targetTokenProgram = await tokenProgramForMint(targetMint);

    surfnet.fundToken(
      trader.publicKey.toBase58(),
      NATIVE_MINT.toBase58(),
      2_000_000_000,
    );
    surfnet.fundToken(
      trader.publicKey.toBase58(),
      targetMint.toBase58(),
      1_000_000_000,
      targetTokenProgram.toBase58(),
    );
    const userWsol = new PublicKey(
      surfnet.getAta(trader.publicKey.toBase58(), NATIVE_MINT.toBase58()),
    );
    const userTarget = new PublicKey(
      surfnet.getAta(
        trader.publicKey.toBase58(),
        targetMint.toBase58(),
        targetTokenProgram.toBase58(),
      ),
    );

    const pumpGlobal =
      await pumpProgram.account.globalConfig.fetch(pumpGlobalAddress);
    expect(pumpPool.baseMint.equals(targetMint)).to.equal(true);
    expect(pumpPool.quoteMint.equals(NATIVE_MINT)).to.equal(true);

    const protocolFeeRecipient = pumpGlobal.protocolFeeRecipients[0];
    const buybackFeeRecipient = pumpGlobal.buybackFeeRecipients[0];
    const coinCreatorVaultAuthority = ammCreatorVaultPda(pumpPool.coinCreator);
    const pumpFeeConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), PUMP_AMM_PROGRAM_ID.toBuffer()],
      PUMP_FEE_PROGRAM_ID,
    )[0];

    const dlmm = await DLMM.create(connection, meteoraPoolAddress);
    expect(dlmm.lbPair.tokenXMint.equals(targetMint)).to.equal(true);
    expect(dlmm.lbPair.tokenYMint.equals(NATIVE_MINT)).to.equal(true);
    const binArrays = await dlmm.getBinArrayForSwap(true, 4);
    expect(binArrays.length).to.be.greaterThan(0);

    const routeAccounts: Record<string, PublicKey> = {
      trader: trader.publicKey,
      wsolMint: NATIVE_MINT,
      targetMint,
      userWsol,
      userTarget,
      wsolTokenProgram: TOKEN_PROGRAM_ID,
      targetTokenProgram,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      pumpProgram: PUMP_AMM_PROGRAM_ID,
      pumpPool: pumpPoolAddress,
      pumpGlobalConfig: pumpGlobalAddress,
      pumpPoolBaseTokenAccount: pumpPool.poolBaseTokenAccount,
      pumpPoolQuoteTokenAccount: pumpPool.poolQuoteTokenAccount,
      pumpProtocolFeeRecipient: protocolFeeRecipient,
      pumpProtocolFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        protocolFeeRecipient,
        true,
      ),
      pumpEventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      pumpCoinCreatorVaultAta: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        coinCreatorVaultAuthority,
        true,
      ),
      pumpCoinCreatorVaultAuthority: coinCreatorVaultAuthority,
      pumpGlobalVolumeAccumulator: AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
      pumpUserVolumeAccumulator: userVolumeAccumulatorPda(
        trader.publicKey,
        PUMP_AMM_PROGRAM_ID,
      ),
      pumpFeeConfig,
      pumpFeeProgram: PUMP_FEE_PROGRAM_ID,
      pumpPoolV2: poolV2Pda(targetMint),
      pumpBuybackFeeRecipient: buybackFeeRecipient,
      pumpBuybackFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        buybackFeeRecipient,
        true,
      ),
      meteoraProgram: METEORA_PROGRAM_ID,
      meteoraLbPair: meteoraPoolAddress,
      meteoraBinArrayBitmapExtension:
        dlmm.binArrayBitmapExtension?.publicKey ?? METEORA_PROGRAM_ID,
      meteoraReserveX: dlmm.lbPair.reserveX,
      meteoraReserveY: dlmm.lbPair.reserveY,
      meteoraOracle: dlmm.lbPair.oracle,
      meteoraHostFeeIn: METEORA_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      meteoraEventAuthority: deriveEventAuthority(METEORA_PROGRAM_ID)[0],
    };

    const route = await program.methods
      .executePumpToMeteora({
        wsolAmountIn: new BN(spendableWsol),
        minProfitLamports: new BN(process.env.SURFPOOL_MIN_PROFIT ?? "1"),
      })
      .accounts(routeAccounts)
      .remainingAccounts(
        binArrays.map(({ publicKey }) => ({
          pubkey: publicKey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();
    const lookupTable = await createLookupTable([
      ...Object.values(routeAccounts),
      ...binArrays.map(({ publicKey }) => publicKey),
    ]);
    const initialWsol = (await getAccount(connection, userWsol)).amount;
    const latest = await connection.getLatestBlockhash("processed");
    const message = new TransactionMessage({
      payerKey: trader.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        route,
      ],
    }).compileToV0Message([lookupTable]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([trader]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "processed",
    });
    const result = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(result?.meta?.err).to.equal(null);
    const logs = result?.meta?.logMessages ?? [];
    expect(
      logs.some((line) =>
        line.includes(`Program ${PUMP_AMM_PROGRAM_ID.toBase58()} invoke`),
      ),
    ).to.equal(true);
    expect(
      logs.some((line) =>
        line.includes(`Program ${METEORA_PROGRAM_ID.toBase58()} invoke`),
      ),
    ).to.equal(true);
    expect(Number(result?.meta?.computeUnitsConsumed ?? 0)).to.be.greaterThan(
      0,
    );
    expect((await getAccount(connection, userWsol)).amount).not.to.equal(
      initialWsol,
    );
    console.log(
      `Surfpool real CPI consumed ${String(result?.meta?.computeUnitsConsumed)} CU`,
    );
  });

  it("executes Meteora DLMM swap2 followed by PumpSwap sell", async () => {
    const pumpPoolAddress = new PublicKey(required("SURFPOOL_PUMP_POOL"));
    const pumpGlobalAddress = process.env.SURFPOOL_PUMP_GLOBAL_CONFIG
      ? new PublicKey(process.env.SURFPOOL_PUMP_GLOBAL_CONFIG)
      : GLOBAL_CONFIG_PDA;
    const meteoraPoolAddress = new PublicKey(required("SURFPOOL_METEORA_POOL"));
    const wsolInput = Number(process.env.SURFPOOL_WSOL_INPUT ?? "1000000");

    const pumpProgram = getPumpAmmProgram(connection);
    const pumpPool = await pumpProgram.account.pool.fetch(pumpPoolAddress);
    const targetMint = process.env.SURFPOOL_TARGET_MINT
      ? new PublicKey(process.env.SURFPOOL_TARGET_MINT)
      : pumpPool.baseMint;
    const targetTokenProgram = await tokenProgramForMint(targetMint);

    surfnet.fundToken(
      trader.publicKey.toBase58(),
      NATIVE_MINT.toBase58(),
      2_000_000_000,
    );
    surfnet.fundToken(
      trader.publicKey.toBase58(),
      targetMint.toBase58(),
      1_000_000_000,
      targetTokenProgram.toBase58(),
    );
    const userWsol = new PublicKey(
      surfnet.getAta(trader.publicKey.toBase58(), NATIVE_MINT.toBase58()),
    );
    const userTarget = new PublicKey(
      surfnet.getAta(
        trader.publicKey.toBase58(),
        targetMint.toBase58(),
        targetTokenProgram.toBase58(),
      ),
    );

    const pumpGlobal =
      await pumpProgram.account.globalConfig.fetch(pumpGlobalAddress);
    expect(pumpPool.baseMint.equals(targetMint)).to.equal(true);
    expect(pumpPool.quoteMint.equals(NATIVE_MINT)).to.equal(true);

    const protocolFeeRecipient = pumpGlobal.protocolFeeRecipients[0];
    const buybackFeeRecipient = pumpGlobal.buybackFeeRecipients[0];
    const coinCreatorVaultAuthority = ammCreatorVaultPda(pumpPool.coinCreator);
    const pumpFeeConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), PUMP_AMM_PROGRAM_ID.toBuffer()],
      PUMP_FEE_PROGRAM_ID,
    )[0];

    const dlmm = await DLMM.create(connection, meteoraPoolAddress);
    expect(dlmm.lbPair.tokenXMint.equals(targetMint)).to.equal(true);
    expect(dlmm.lbPair.tokenYMint.equals(NATIVE_MINT)).to.equal(true);
    // token X is the target mint and token Y is WSOL, so false selects Y -> X.
    const binArrays = await dlmm.getBinArrayForSwap(false, 4);
    expect(binArrays.length).to.be.greaterThan(0);

    const routeAccounts: Record<string, PublicKey> = {
      trader: trader.publicKey,
      wsolMint: NATIVE_MINT,
      targetMint,
      userWsol,
      userTarget,
      wsolTokenProgram: TOKEN_PROGRAM_ID,
      targetTokenProgram,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      pumpProgram: PUMP_AMM_PROGRAM_ID,
      pumpPool: pumpPoolAddress,
      pumpGlobalConfig: pumpGlobalAddress,
      pumpPoolBaseTokenAccount: pumpPool.poolBaseTokenAccount,
      pumpPoolQuoteTokenAccount: pumpPool.poolQuoteTokenAccount,
      pumpProtocolFeeRecipient: protocolFeeRecipient,
      pumpProtocolFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        protocolFeeRecipient,
        true,
      ),
      pumpEventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      pumpCoinCreatorVaultAta: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        coinCreatorVaultAuthority,
        true,
      ),
      pumpCoinCreatorVaultAuthority: coinCreatorVaultAuthority,
      pumpGlobalVolumeAccumulator: AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
      pumpUserVolumeAccumulator: userVolumeAccumulatorPda(
        trader.publicKey,
        PUMP_AMM_PROGRAM_ID,
      ),
      pumpFeeConfig,
      pumpFeeProgram: PUMP_FEE_PROGRAM_ID,
      pumpPoolV2: poolV2Pda(targetMint),
      pumpBuybackFeeRecipient: buybackFeeRecipient,
      pumpBuybackFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        buybackFeeRecipient,
        true,
      ),
      meteoraProgram: METEORA_PROGRAM_ID,
      meteoraLbPair: meteoraPoolAddress,
      meteoraBinArrayBitmapExtension:
        dlmm.binArrayBitmapExtension?.publicKey ?? METEORA_PROGRAM_ID,
      meteoraReserveX: dlmm.lbPair.reserveX,
      meteoraReserveY: dlmm.lbPair.reserveY,
      meteoraOracle: dlmm.lbPair.oracle,
      meteoraHostFeeIn: METEORA_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      meteoraEventAuthority: deriveEventAuthority(METEORA_PROGRAM_ID)[0],
    };

    const route = await program.methods
      .executeMeteoraToPump({
        wsolAmountIn: new BN(wsolInput),
        minProfitLamports: new BN(process.env.SURFPOOL_MIN_PROFIT ?? "1"),
      })
      .accounts(routeAccounts)
      .remainingAccounts(
        binArrays.map(({ publicKey }) => ({
          pubkey: publicKey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();
    const lookupTable = await createLookupTable([
      ...Object.values(routeAccounts),
      ...binArrays.map(({ publicKey }) => publicKey),
    ]);
    const initialWsol = (await getAccount(connection, userWsol)).amount;
    const initialTarget = (
      await getAccount(connection, userTarget, undefined, targetTokenProgram)
    ).amount;
    const latest = await connection.getLatestBlockhash("processed");
    const message = new TransactionMessage({
      payerKey: trader.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        route,
      ],
    }).compileToV0Message([lookupTable]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([trader]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "processed",
    });
    const result = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(result?.meta?.err).to.equal(null);
    const logs = result?.meta?.logMessages ?? [];
    expect(
      logs.some((line) =>
        line.includes(`Program ${METEORA_PROGRAM_ID.toBase58()} invoke`),
      ),
    ).to.equal(true);
    expect(
      logs.some((line) =>
        line.includes(`Program ${PUMP_AMM_PROGRAM_ID.toBase58()} invoke`),
      ),
    ).to.equal(true);
    expect(Number(result?.meta?.computeUnitsConsumed ?? 0)).to.be.greaterThan(
      0,
    );
    expect((await getAccount(connection, userWsol)).amount).not.to.equal(
      initialWsol,
    );
    expect(
      (await getAccount(connection, userTarget, undefined, targetTokenProgram))
        .amount,
    ).to.equal(initialTarget);
    console.log(
      `Surfpool reverse real CPI consumed ${String(result?.meta?.computeUnitsConsumed)} CU`,
    );
  });

  it("fixed-direction succeeds for Pump -> Meteora on a controlled real-protocol state", async () => {
    const fixture = await buildBestDirectionFixture();
    const quoteVault = await connection.getAccountInfo(
      fixture.pumpQuoteVault,
      "processed",
    );
    if (!quoteVault) throw new Error("Pump quote vault was not found");
    const currentAmount = quoteVault.data.readBigUInt64LE(64);
    await setTokenAccountAmount(fixture.pumpQuoteVault, currentAmount / 2n);

    const result = await executeFixedDirection(fixture, "pump-to-meteora");
    console.log(
      `Surfpool fixed forward consumed ${result.computeUnits} CU, profit=${result.profit}`,
    );
  });

  it("fixed-direction succeeds for Meteora -> Pump on a controlled real-protocol state", async () => {
    const fixture = await buildBestDirectionFixture();
    const quoteVault = await connection.getAccountInfo(
      fixture.pumpQuoteVault,
      "processed",
    );
    if (!quoteVault) throw new Error("Pump quote vault was not found");
    const currentAmount = quoteVault.data.readBigUInt64LE(64);
    await setTokenAccountAmount(fixture.pumpQuoteVault, currentAmount * 4n);

    const result = await executeFixedDirection(fixture, "meteora-to-pump");
    console.log(
      `Surfpool fixed reverse consumed ${result.computeUnits} CU, profit=${result.profit}`,
    );
  });

  it("best-direction selects Pump -> Meteora on a controlled real-protocol state", async () => {
    const fixture = await buildBestDirectionFixture();
    const quoteVault = await connection.getAccountInfo(
      fixture.pumpQuoteVault,
      "processed",
    );
    if (!quoteVault) throw new Error("Pump quote vault was not found");
    const currentAmount = quoteVault.data.readBigUInt64LE(64);
    await setTokenAccountAmount(fixture.pumpQuoteVault, currentAmount / 2n);

    const result = await executeBestDirection(fixture, PUMP_AMM_PROGRAM_ID);
    console.log(
      `Surfpool best-direction forward consumed ${result.computeUnits} CU, profit=${result.profit}`,
    );
  });

  it("best-direction selects Meteora -> Pump on a controlled real-protocol state", async () => {
    const fixture = await buildBestDirectionFixture();
    const quoteVault = await connection.getAccountInfo(
      fixture.pumpQuoteVault,
      "processed",
    );
    if (!quoteVault) throw new Error("Pump quote vault was not found");
    const currentAmount = quoteVault.data.readBigUInt64LE(64);
    await setTokenAccountAmount(fixture.pumpQuoteVault, currentAmount * 4n);

    const result = await executeBestDirection(fixture, METEORA_PROGRAM_ID);
    console.log(
      `Surfpool best-direction reverse consumed ${result.computeUnits} CU, profit=${result.profit}`,
    );
  });

  it("best-direction continues to reverse when the forward quote is incomplete on a controlled real-protocol state", async () => {
    const fixture = await buildBestDirectionFixture();
    const quoteVault = await connection.getAccountInfo(
      fixture.pumpQuoteVault,
      "processed",
    );
    if (!quoteVault) throw new Error("Pump quote vault was not found");
    const currentAmount = quoteVault.data.readBigUInt64LE(64);
    await setTokenAccountAmount(fixture.pumpQuoteVault, currentAmount * 4n);
    await clearDlmmOutputLiquidity(
      fixture.binArrays.map(({ publicKey }) => publicKey),
      fixture.targetIsX,
    );

    const result = await executeBestDirection(fixture, METEORA_PROGRAM_ID);
    console.log(
      `Surfpool incomplete-forward fallback consumed ${result.computeUnits} CU, profit=${result.profit}`,
    );
  });
});
