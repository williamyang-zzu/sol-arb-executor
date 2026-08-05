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
import { poolV2Pda } from "@pump-fun/pump-swap-sdk";
import { Surfnet } from "@solana/surfpool";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
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

const METEORA_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const EXECUTOR_PROGRAM_ID = new PublicKey(
  "gi3C8ghCEhYS6D9SPuUW9VepPPtnL1sQ96ShyJ7GSsY",
);

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

  before(() => {
    const payer = Surfnet.newKeypair();
    trader = Keypair.fromSecretKey(Uint8Array.from(payer.secretKey));
    surfnet = Surfnet.startWithConfig({
      remoteRpcUrl:
        process.env.SURFPOOL_MAINNET_RPC_URL ??
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

  after(() => {
    surfnet?.stop();
  });

  async function sendLegacy(
    ...instructions: TransactionInstruction[]
  ): Promise<string> {
    return sendAndConfirmTransaction(
      connection,
      new Transaction().add(...instructions),
      [trader],
      { commitment: "processed", preflightCommitment: "processed" },
    );
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

  it("executes PumpSwap buy followed by Meteora DLMM swap2", async () => {
    const pumpPoolAddress = new PublicKey(required("SURFPOOL_PUMP_POOL"));
    const pumpGlobalAddress = new PublicKey(
      required("SURFPOOL_PUMP_GLOBAL_CONFIG"),
    );
    const meteoraPoolAddress = new PublicKey(required("SURFPOOL_METEORA_POOL"));
    const spendableWsol = Number(process.env.SURFPOOL_WSOL_INPUT ?? "1000000");

    const pumpProgram = getPumpAmmProgram(connection);
    const pumpPool = await pumpProgram.account.pool.fetch(pumpPoolAddress);
    const targetMint = process.env.SURFPOOL_TARGET_MINT
      ? new PublicKey(process.env.SURFPOOL_TARGET_MINT)
      : pumpPool.baseMint;

    surfnet.fundToken(
      trader.publicKey.toBase58(),
      NATIVE_MINT.toBase58(),
      2_000_000_000,
    );
    surfnet.fundToken(
      trader.publicKey.toBase58(),
      targetMint.toBase58(),
      1_000_000_000,
    );
    const userWsol = new PublicKey(
      surfnet.getAta(trader.publicKey.toBase58(), NATIVE_MINT.toBase58()),
    );
    const userTarget = new PublicKey(
      surfnet.getAta(trader.publicKey.toBase58(), targetMint.toBase58()),
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
      tokenProgram: TOKEN_PROGRAM_ID,
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
        pumpSpendableWsolIn: new BN(spendableWsol),
        pumpMinTargetOut: new BN(1),
        meteoraMinWsolOut: new BN(1),
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
});
