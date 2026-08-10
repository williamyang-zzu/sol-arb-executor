import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import {
  GLOBAL_CONFIG_PDA,
  OnlinePumpAmmSdk,
  buyQuoteInput,
  poolV2Pda,
  sellBaseInput,
} from "@pump-fun/pump-swap-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
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
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const EXECUTOR = new PublicKey("RoroSC7cukdtr1WFantguWKcZ9KTwqjnMRJYo9EcL51");
const METEORA_PROGRAM = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const TARGET_MINT = new PublicKey(required("TARGET_MINT"));
const PUMP_POOL = new PublicKey(
  process.env.PUMP_POOL ?? "CkhpkGsmbVAV5hMrFJNri9PjcSMubSgiDFFaKMYBisy3",
);
const METEORA_POOL = new PublicKey(
  process.env.METEORA_POOL ?? "GsKmn6qcL13MctorxXfKeUsVLz2c91uPFWMPXPU4Whni",
);
const WSOL_AMOUNT_IN = new BN(required("WSOL_AMOUNT_IN"));
const MIN_PROFIT_LAMPORTS = new BN(process.env.MIN_PROFIT_LAMPORTS ?? "10000");
const SLIPPAGE_PERCENT = 5;
const METEORA_SLIPPAGE_BPS = new BN(SLIPPAGE_PERCENT * 100);
const DESIRED_WSOL_BALANCE = 12_000_000n;
const TRANSACTION_COUNT = Number(process.env.TRANSACTION_COUNT ?? "0");
const TRANSACTION_INTERVAL_MS = Number(
  process.env.TRANSACTION_INTERVAL_MS ?? "3000",
);
const TRANSACTION_DIRECTION =
  process.env.TRANSACTION_DIRECTION ?? "pump-to-meteora";

type Direction = "pump-to-meteora" | "meteora-to-pump";

type BatchRecord = {
  ordinal: number;
  direction: Direction;
  signature: string;
  broadcastAt: string;
  broadcastTimestampMs: number;
  lastValidBlockHeight: number;
  status: "broadcast";
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function readKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function sendLegacy(
  connection: Connection,
  signer: Keypair,
  instructions: TransactionInstruction[],
): Promise<string> {
  return sendAndConfirmTransaction(
    connection,
    new Transaction().add(...instructions),
    [signer],
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      maxRetries: 5,
    },
  );
}

async function prepareTokenAccounts(
  connection: Connection,
  signer: Keypair,
  userWsol: PublicKey,
  userTarget: PublicKey,
  targetTokenProgram: PublicKey,
): Promise<string | null> {
  const instructions: TransactionInstruction[] = [];
  const [wsolInfo, targetInfo] = await connection.getMultipleAccountsInfo([
    userWsol,
    userTarget,
  ]);
  if (!wsolInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        userWsol,
        signer.publicKey,
        NATIVE_MINT,
      ),
    );
  }
  if (!targetInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        userTarget,
        signer.publicKey,
        TARGET_MINT,
        targetTokenProgram,
      ),
    );
  }
  let currentWsol = 0n;
  try {
    currentWsol = (await getAccount(connection, userWsol)).amount;
  } catch {
    currentWsol = 0n;
  }
  if (currentWsol < DESIRED_WSOL_BALANCE) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: userWsol,
        lamports: Number(DESIRED_WSOL_BALANCE - currentWsol),
      }),
      createSyncNativeInstruction(userWsol),
    );
  }
  if (instructions.length === 0) return null;
  return sendLegacy(connection, signer, instructions);
}

async function createLookupTable(
  connection: Connection,
  signer: Keypair,
  addresses: PublicKey[],
): Promise<{ table: AddressLookupTableAccount; signatures: string[] }> {
  const signatures: string[] = [];
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({
    authority: signer.publicKey,
    payer: signer.publicKey,
    recentSlot,
  });
  signatures.push(await sendLegacy(connection, signer, [createIx]));
  const unique = [...new Set(addresses.map(String))]
    .map((value) => new PublicKey(value))
    .filter((value) => !value.equals(signer.publicKey));
  for (let index = 0; index < unique.length; index += 20) {
    signatures.push(
      await sendLegacy(connection, signer, [
        AddressLookupTableProgram.extendLookupTable({
          authority: signer.publicKey,
          payer: signer.publicKey,
          lookupTable: address,
          addresses: unique.slice(index, index + 20),
        }),
      ]),
    );
  }
  while ((await connection.getSlot("confirmed")) <= recentSlot) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const response = await connection.getAddressLookupTable(address, {
    commitment: "confirmed",
  });
  if (!response.value) throw new Error(`Lookup table ${address} was not found`);
  return { table: response.value, signatures };
}

async function main(): Promise<void> {
  const connection = new Connection(required("RPC_URL"), "confirmed");
  const signer = readKeypair(
    process.env.WALLET_PATH ?? "/Users/bitlayer/.config/solana/id.json",
  );
  const provider = new AnchorProvider(connection, new Wallet(signer), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = JSON.parse(
    readFileSync("target/idl/sol_arb_executor.json", "utf8"),
  ) as Idl;
  const program = new Program(idl, provider);
  if (!program.programId.equals(EXECUTOR)) {
    throw new Error(`IDL program ID mismatch: ${program.programId}`);
  }

  const targetMintAccount = await connection.getAccountInfo(
    TARGET_MINT,
    "confirmed",
  );
  if (!targetMintAccount)
    throw new Error(`Target mint ${TARGET_MINT} was not found`);
  const targetTokenProgram = targetMintAccount.owner;
  if (
    !targetTokenProgram.equals(TOKEN_PROGRAM_ID) &&
    !targetTokenProgram.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(`Unsupported target token program ${targetTokenProgram}`);
  }
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, signer.publicKey);
  const userTarget = getAssociatedTokenAddressSync(
    TARGET_MINT,
    signer.publicKey,
    false,
    targetTokenProgram,
  );
  console.log("Trader", signer.publicKey.toBase58());
  console.log("Input per direction", WSOL_AMOUNT_IN.toString(), "lamports");
  const setupSignature = await prepareTokenAccounts(
    connection,
    signer,
    userWsol,
    userTarget,
    targetTokenProgram,
  );
  if (setupSignature) console.log("Account setup signature", setupSignature);

  const pumpProgram = getPumpAmmProgram(connection);
  const pumpPool = await pumpProgram.account.pool.fetch(PUMP_POOL);
  const pumpGlobal =
    await pumpProgram.account.globalConfig.fetch(GLOBAL_CONFIG_PDA);
  if (
    !pumpPool.baseMint.equals(TARGET_MINT) ||
    !pumpPool.quoteMint.equals(NATIVE_MINT)
  ) {
    throw new Error("Pump pool mint relationship mismatch");
  }
  const protocolFeeRecipient = pumpGlobal.protocolFeeRecipients[0];
  const buybackFeeRecipient = pumpGlobal.buybackFeeRecipients[0];
  const coinCreatorVaultAuthority = ammCreatorVaultPda(pumpPool.coinCreator);
  const pumpFeeConfig = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), PUMP_AMM_PROGRAM_ID.toBuffer()],
    PUMP_FEE_PROGRAM_ID,
  )[0];

  const dlmm = await DLMM.create(connection, METEORA_POOL);
  if (
    !dlmm.lbPair.tokenXMint.equals(TARGET_MINT) ||
    !dlmm.lbPair.tokenYMint.equals(NATIVE_MINT)
  ) {
    throw new Error("Meteora pool mint relationship mismatch");
  }
  const pumpOnline = new OnlinePumpAmmSdk(connection);

  const routeAccounts: Record<string, PublicKey> = {
    trader: signer.publicKey,
    wsolMint: NATIVE_MINT,
    targetMint: TARGET_MINT,
    userWsol,
    userTarget,
    wsolTokenProgram: TOKEN_PROGRAM_ID,
    targetTokenProgram,
    systemProgram: SystemProgram.programId,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    pumpProgram: PUMP_AMM_PROGRAM_ID,
    pumpPool: PUMP_POOL,
    pumpGlobalConfig: GLOBAL_CONFIG_PDA,
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
      signer.publicKey,
      PUMP_AMM_PROGRAM_ID,
    ),
    pumpFeeConfig,
    pumpFeeProgram: PUMP_FEE_PROGRAM_ID,
    pumpPoolV2: poolV2Pda(TARGET_MINT),
    pumpBuybackFeeRecipient: buybackFeeRecipient,
    pumpBuybackFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
      NATIVE_MINT,
      buybackFeeRecipient,
      true,
    ),
    meteoraProgram: METEORA_PROGRAM,
    meteoraLbPair: METEORA_POOL,
    meteoraBinArrayBitmapExtension:
      dlmm.binArrayBitmapExtension?.publicKey ?? METEORA_PROGRAM,
    meteoraReserveX: dlmm.lbPair.reserveX,
    meteoraReserveY: dlmm.lbPair.reserveY,
    meteoraOracle: dlmm.lbPair.oracle,
    meteoraHostFeeIn: METEORA_PROGRAM,
    memoProgram: MEMO_PROGRAM_ID,
    meteoraEventAuthority: deriveEventAuthority(METEORA_PROGRAM)[0],
  };

  async function build(direction: Direction): Promise<{
    instruction: TransactionInstruction;
    bins: PublicKey[];
    quote: Record<string, string>;
  }> {
    await dlmm.refetchStates();
    const pumpState = await pumpOnline.swapSolanaState(
      PUMP_POOL,
      signer.publicKey,
      userTarget,
      userWsol,
    );
    if (direction === "pump-to-meteora") {
      const pumpQuote = buyQuoteInput({
        quote: WSOL_AMOUNT_IN,
        slippage: SLIPPAGE_PERCENT,
        baseReserve: pumpState.poolBaseAmount,
        quoteReserve: pumpState.poolQuoteAmount,
        virtualQuoteReserves: pumpState.pool.virtualQuoteReserves,
        globalConfig: pumpState.globalConfig,
        feeConfig: pumpState.feeConfig,
        baseMintAccount: pumpState.baseMintAccount,
        baseMint: pumpState.baseMint,
        coinCreator: pumpState.pool.coinCreator,
        creator: pumpState.pool.creator,
      });
      const arrays = await dlmm.getBinArrayForSwap(true, 20);
      const meteoraQuote = dlmm.swapQuote(
        pumpQuote.base,
        true,
        METEORA_SLIPPAGE_BPS,
        arrays,
      );
      const instruction = await program.methods
        .executePumpToMeteora({
          wsolAmountIn: WSOL_AMOUNT_IN,
          minProfitLamports: MIN_PROFIT_LAMPORTS,
        })
        .accounts(routeAccounts)
        .remainingAccounts(
          meteoraQuote.binArraysPubkey.map((pubkey) => ({
            pubkey,
            isSigner: false,
            isWritable: true,
          })),
        )
        .instruction();
      return {
        instruction,
        bins: meteoraQuote.binArraysPubkey,
        quote: {
          pumpTargetOut: pumpQuote.base.toString(),
          finalWsolOut: meteoraQuote.outAmount.toString(),
          minFinalWsolOut: meteoraQuote.minOutAmount.toString(),
        },
      };
    }

    const arrays = await dlmm.getBinArrayForSwap(false, 20);
    const meteoraQuote = dlmm.swapQuote(
      WSOL_AMOUNT_IN,
      false,
      METEORA_SLIPPAGE_BPS,
      arrays,
    );
    const pumpQuote = sellBaseInput({
      base: meteoraQuote.outAmount,
      slippage: SLIPPAGE_PERCENT,
      baseReserve: pumpState.poolBaseAmount,
      quoteReserve: pumpState.poolQuoteAmount,
      virtualQuoteReserves: pumpState.pool.virtualQuoteReserves,
      globalConfig: pumpState.globalConfig,
      feeConfig: pumpState.feeConfig,
      baseMintAccount: pumpState.baseMintAccount,
      baseMint: pumpState.baseMint,
      coinCreator: pumpState.pool.coinCreator,
      creator: pumpState.pool.creator,
    });
    const instruction = await program.methods
      .executeMeteoraToPump({
        wsolAmountIn: WSOL_AMOUNT_IN,
        minProfitLamports: MIN_PROFIT_LAMPORTS,
      })
      .accounts(routeAccounts)
      .remainingAccounts(
        meteoraQuote.binArraysPubkey.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();
    return {
      instruction,
      bins: meteoraQuote.binArraysPubkey,
      quote: {
        meteoraTargetOut: meteoraQuote.outAmount.toString(),
        finalWsolOut: pumpQuote.uiQuote.toString(),
        minFinalWsolOut: pumpQuote.minQuote.toString(),
      },
    };
  }

  if (!Number.isSafeInteger(TRANSACTION_COUNT) || TRANSACTION_COUNT < 0) {
    throw new Error("TRANSACTION_COUNT must be a non-negative safe integer");
  }
  if (TRANSACTION_INTERVAL_MS < 1_000) {
    throw new Error("TRANSACTION_INTERVAL_MS must be at least 1000");
  }
  if (
    TRANSACTION_DIRECTION !== "pump-to-meteora" &&
    TRANSACTION_DIRECTION !== "meteora-to-pump" &&
    TRANSACTION_DIRECTION !== "alternate"
  ) {
    throw new Error("TRANSACTION_DIRECTION is invalid");
  }
  const directionFor = (ordinal: number): Direction => {
    if (TRANSACTION_DIRECTION === "alternate") {
      return ordinal % 2 === 1 ? "pump-to-meteora" : "meteora-to-pump";
    }
    return TRANSACTION_DIRECTION as Direction;
  };

  const initialForward = await build("pump-to-meteora");
  const initialReverse =
    TRANSACTION_COUNT === 0 || TRANSACTION_DIRECTION !== "pump-to-meteora"
      ? await build("meteora-to-pump")
      : null;
  let table: AddressLookupTableAccount;
  let altSignatures: string[] = [];
  if (process.env.ADDRESS_LOOKUP_TABLE) {
    const response = await connection.getAddressLookupTable(
      new PublicKey(process.env.ADDRESS_LOOKUP_TABLE),
      { commitment: "confirmed" },
    );
    if (!response.value) {
      throw new Error(
        `Lookup table ${process.env.ADDRESS_LOOKUP_TABLE} was not found`,
      );
    }
    table = response.value;
  } else {
    const created = await createLookupTable(connection, signer, [
      EXECUTOR,
      ...Object.values(routeAccounts),
      ...initialForward.bins,
      ...(initialReverse?.bins ?? []),
    ]);
    table = created.table;
    altSignatures = created.signatures;
  }
  console.log("Lookup table", table.key.toBase58());
  console.log("Lookup table setup signatures", altSignatures);

  async function transactionFor(instruction: TransactionInstruction) {
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        instruction,
      ],
    }).compileToV0Message([table]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    return { transaction, latest };
  }

  if (TRANSACTION_COUNT > 0) {
    if (process.env.SEND_REAL_TRANSACTION !== "true") {
      throw new Error(
        "Repeated sender mode requires SEND_REAL_TRANSACTION=true",
      );
    }
    const reportPath = resolve(
      process.env.BROADCAST_MANIFEST_FILE ??
        `target/mainnet-smoke-broadcasts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    const records: BatchRecord[] = [];
    let sendErrors = 0;
    let sendingComplete = false;
    const persist = () => {
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            programId: EXECUTOR.toBase58(),
            trader: signer.publicKey.toBase58(),
            targetMint: TARGET_MINT.toBase58(),
            pumpPool: PUMP_POOL.toBase58(),
            meteoraPool: METEORA_POOL.toBase58(),
            direction: TRANSACTION_DIRECTION,
            requestedBroadcasts: TRANSACTION_COUNT,
            intervalMs: TRANSACTION_INTERVAL_MS,
            wsolAmountIn: WSOL_AMOUNT_IN.toString(),
            minProfitLamports: MIN_PROFIT_LAMPORTS.toString(),
            sendErrors,
            sendingComplete,
            records,
          },
          null,
          2,
        )}\n`,
      );
    };

    let nextBroadcastNotBefore = Date.now();
    for (let ordinal = 1; ordinal <= TRANSACTION_COUNT; ordinal += 1) {
      await sleep(Math.max(0, nextBroadcastNotBefore - Date.now()));
      let accepted = false;
      while (!accepted) {
        try {
          const direction = directionFor(ordinal);
          const built = await build(direction);
          const { transaction, latest } = await transactionFor(
            built.instruction,
          );
          const broadcastTimestampMs = Date.now();
          const signature = await connection.sendRawTransaction(
            transaction.serialize(),
            { skipPreflight: true, maxRetries: 5 },
          );
          records.push({
            ordinal,
            direction,
            signature,
            broadcastAt: new Date(broadcastTimestampMs).toISOString(),
            broadcastTimestampMs,
            lastValidBlockHeight: latest.lastValidBlockHeight,
            status: "broadcast",
          });
          persist();
          console.log("Batch broadcast", {
            ordinal,
            direction,
            signature,
            broadcastAt: new Date(broadcastTimestampMs).toISOString(),
            lastValidBlockHeight: latest.lastValidBlockHeight,
          });
          nextBroadcastNotBefore =
            broadcastTimestampMs + TRANSACTION_INTERVAL_MS;
          accepted = true;
        } catch (error) {
          sendErrors += 1;
          persist();
          console.error("Batch send error", {
            ordinal,
            sendErrors,
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(TRANSACTION_INTERVAL_MS);
        }
      }
    }
    sendingComplete = true;
    persist();
    console.log("Broadcasting complete", {
      broadcast: records.length,
      sendErrors,
      manifestPath: reportPath,
    });
    return;
  }

  for (const direction of ["pump-to-meteora", "meteora-to-pump"] as const) {
    const built =
      direction === "pump-to-meteora" ? initialForward : initialReverse!;
    const { transaction } = await transactionFor(built.instruction);
    const result = await connection.simulateTransaction(transaction, {
      commitment: "confirmed",
      sigVerify: true,
    });
    console.log("Simulation", direction, {
      quote: built.quote,
      error: result.value.err,
      unitsConsumed: result.value.unitsConsumed,
    });
    if (result.value.err) {
      console.log("Simulation logs", result.value.logs);
      throw new Error(`${direction} simulation failed`);
    }
  }

  if (process.env.SEND_REAL_TRANSACTION !== "true") {
    console.log(
      "Both simulations passed. SEND_REAL_TRANSACTION is not true; stopping.",
    );
    return;
  }

  for (const direction of ["pump-to-meteora", "meteora-to-pump"] as const) {
    let confirmed = false;
    for (let attempt = 1; attempt <= 3 && !confirmed; attempt += 1) {
      const built = await build(direction);
      const { transaction, latest } = await transactionFor(built.instruction);
      let signature: string | undefined;
      try {
        signature = await connection.sendRawTransaction(
          transaction.serialize(),
          {
            skipPreflight: false,
            maxRetries: 5,
          },
        );
        const confirmation = await connection.confirmTransaction(
          { signature, ...latest },
          "confirmed",
        );
        if (confirmation.value.err) {
          throw new Error(
            `${direction} transaction failed: ${JSON.stringify(confirmation.value.err)}`,
          );
        }
      } catch (error) {
        if (signature) {
          const status = (
            await connection.getSignatureStatuses([signature], {
              searchTransactionHistory: true,
            })
          ).value[0];
          if (status?.err) throw error;
          if (
            status?.confirmationStatus === "confirmed" ||
            status?.confirmationStatus === "finalized"
          ) {
            confirmed = true;
          }
        }
        if (!confirmed && attempt === 3) throw error;
        if (!confirmed) {
          console.log(`Retrying ${direction} with a fresh blockhash`, {
            attempt,
            previousSignature: signature,
          });
          continue;
        }
      }
      if (!signature)
        throw new Error(`${direction} did not return a signature`);
      confirmed = true;
      const details = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      console.log("Confirmed transaction", direction, {
        signature,
        unitsConsumed: details?.meta?.computeUnitsConsumed,
        quote: built.quote,
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
