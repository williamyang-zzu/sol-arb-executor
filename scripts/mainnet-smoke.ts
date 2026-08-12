import "dotenv/config";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  Wallet,
  utils,
} from "@coral-xyz/anchor";
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
  BlockhashWithExpiryBlockHeight,
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
import {
  AsyncManifestWriter,
  ConcurrencyGate,
  computeBudgetInstructions,
  reserveUniqueSignature,
  sanitizedErrorMessage,
  scheduledBroadcastTimestamp,
  sleep,
} from "./sender-pipeline";

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
const DESIRED_WSOL_BALANCE = 12_000_000n;
const TRANSACTION_COUNT = Number(process.env.TRANSACTION_COUNT ?? "0");
const TRANSACTION_INTERVAL_MS = Number(
  process.env.TRANSACTION_INTERVAL_MS ?? "3000",
);
const TRANSACTION_DIRECTION =
  process.env.TRANSACTION_DIRECTION ?? "pump-to-meteora";
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? "300000");
const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = Number(
  process.env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS ?? "300",
);
const SENDER_MAX_IN_FLIGHT = Number(process.env.SENDER_MAX_IN_FLIGHT ?? "3");
const TRANSACTION_SIGN_AHEAD_MS = Number(
  process.env.TRANSACTION_SIGN_AHEAD_MS ?? "150",
);
const BLOCKHASH_REFRESH_MS = Number(process.env.BLOCKHASH_REFRESH_MS ?? "400");
const BLOCKHASH_MAX_AGE_MS = Number(process.env.BLOCKHASH_MAX_AGE_MS ?? "1500");
const ROUTE_SNAPSHOT_REFRESH_MS = Number(
  process.env.ROUTE_SNAPSHOT_REFRESH_MS ?? "750",
);

type FixedDirection = "pump-to-meteora" | "meteora-to-pump";
type TransactionMode = FixedDirection | "best-direction";

type BatchRecord = {
  ordinal: number;
  direction: TransactionMode;
  signature: string;
  broadcastAt: string;
  broadcastTimestampMs: number;
  blockhashContextSlot: number;
  broadcastObservedSlot: number | null;
  lastValidBlockHeight: number;
  scheduledBroadcastAt: string;
  scheduledBroadcastTimestampMs: number;
  buildStartedTimestampMs: number;
  signedTimestampMs: number;
  buildAndSignDurationMs: number;
  scheduleDelayMs: number;
  rpcAcknowledgedAt: string | null;
  rpcAckDurationMs: number | null;
  rpcError: string | null;
  routeSnapshotVersion: number;
  routeSnapshotAgeMs: number;
  blockhashAgeMs: number;
  status: "broadcast";
};

type BuiltRoute = {
  instruction: TransactionInstruction;
  bins: PublicKey[];
  quote: Record<string, string>;
};

type RouteSnapshot = {
  version: number;
  refreshedAtMs: number;
  builds: Map<TransactionMode, BuiltRoute>;
};

type CachedBlockhash = {
  contextSlot: number;
  value: BlockhashWithExpiryBlockHeight;
  fetchedAtMs: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function assertIntegerAtLeast(name: string, value: number, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  }
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

  async function buildFromCurrentState(
    direction: TransactionMode,
  ): Promise<BuiltRoute> {
    if (direction === "best-direction") {
      const [forwardArrays, reverseArrays] = await Promise.all([
        dlmm.getBinArrayForSwap(true, 2),
        dlmm.getBinArrayForSwap(false, 2),
      ]);
      const arrays = [
        ...new Map(
          [...forwardArrays, ...reverseArrays].map((array) => [
            array.publicKey.toBase58(),
            array,
          ]),
        ).values(),
      ];
      if (arrays.length === 0 || arrays.length > 4) {
        throw new Error(
          `best-direction requires 1-4 unique Meteora bin arrays, received ${arrays.length}`,
        );
      }
      const instruction = await program.methods
        .executeBestDirection({
          wsolAmountIn: WSOL_AMOUNT_IN,
          minProfitLamports: MIN_PROFIT_LAMPORTS,
        })
        .accounts(routeAccounts)
        .remainingAccounts(
          arrays.map(({ publicKey }) => ({
            pubkey: publicKey,
            isSigner: false,
            isWritable: true,
          })),
        )
        .instruction();
      return {
        instruction,
        bins: arrays.map(({ publicKey }) => publicKey),
        quote: { selection: "on-chain" },
      };
    }

    if (direction === "pump-to-meteora") {
      const pumpState = await pumpOnline.swapSolanaState(
        PUMP_POOL,
        signer.publicKey,
        userTarget,
        userWsol,
      );
      const pumpQuote = buyQuoteInput({
        quote: WSOL_AMOUNT_IN,
        slippage: 0,
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
        new BN(0),
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
        },
      };
    }

    const arrays = await dlmm.getBinArrayForSwap(false, 20);
    const meteoraQuote = dlmm.swapQuote(
      WSOL_AMOUNT_IN,
      false,
      new BN(0),
      arrays,
    );
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
    TRANSACTION_DIRECTION !== "best-direction" &&
    TRANSACTION_DIRECTION !== "alternate"
  ) {
    throw new Error("TRANSACTION_DIRECTION is invalid");
  }
  assertIntegerAtLeast("COMPUTE_UNIT_LIMIT", COMPUTE_UNIT_LIMIT, 1);
  if (COMPUTE_UNIT_LIMIT > 1_400_000) {
    throw new Error("COMPUTE_UNIT_LIMIT must not exceed 1400000");
  }
  assertIntegerAtLeast(
    "COMPUTE_UNIT_PRICE_MICRO_LAMPORTS",
    COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
    0,
  );
  assertIntegerAtLeast("SENDER_MAX_IN_FLIGHT", SENDER_MAX_IN_FLIGHT, 1);
  assertIntegerAtLeast(
    "TRANSACTION_SIGN_AHEAD_MS",
    TRANSACTION_SIGN_AHEAD_MS,
    0,
  );
  assertIntegerAtLeast("BLOCKHASH_REFRESH_MS", BLOCKHASH_REFRESH_MS, 100);
  assertIntegerAtLeast("BLOCKHASH_MAX_AGE_MS", BLOCKHASH_MAX_AGE_MS, 100);
  assertIntegerAtLeast(
    "ROUTE_SNAPSHOT_REFRESH_MS",
    ROUTE_SNAPSHOT_REFRESH_MS,
    250,
  );
  const directionFor = (ordinal: number): TransactionMode => {
    if (TRANSACTION_DIRECTION === "alternate") {
      return ordinal % 2 === 1 ? "pump-to-meteora" : "meteora-to-pump";
    }
    return TRANSACTION_DIRECTION as TransactionMode;
  };

  const initialModes: TransactionMode[] =
    TRANSACTION_COUNT === 0
      ? TRANSACTION_DIRECTION === "best-direction"
        ? ["best-direction"]
        : ["pump-to-meteora", "meteora-to-pump"]
      : TRANSACTION_DIRECTION === "alternate"
        ? ["pump-to-meteora", "meteora-to-pump"]
        : [TRANSACTION_DIRECTION as TransactionMode];
  let routeSnapshotVersion = 0;
  let routeSnapshot: RouteSnapshot | null = null;
  let routeRefreshInFlight: Promise<RouteSnapshot> | null = null;
  const refreshRouteSnapshot = (): Promise<RouteSnapshot> => {
    if (routeRefreshInFlight) return routeRefreshInFlight;
    routeRefreshInFlight = (async () => {
      await dlmm.refetchStates();
      const builds = new Map<TransactionMode, BuiltRoute>();
      for (const mode of initialModes) {
        builds.set(mode, await buildFromCurrentState(mode));
      }
      const refreshed: RouteSnapshot = {
        version: routeSnapshotVersion + 1,
        refreshedAtMs: Date.now(),
        builds,
      };
      routeSnapshotVersion = refreshed.version;
      routeSnapshot = refreshed;
      return refreshed;
    })().finally(() => {
      routeRefreshInFlight = null;
    });
    return routeRefreshInFlight;
  };
  const initialSnapshot = await refreshRouteSnapshot();
  const initialBuilds = initialSnapshot.builds;
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
    if (TRANSACTION_COUNT > 0) {
      throw new Error(
        "Repeated sender mode requires ADDRESS_LOOKUP_TABLE; refusing to create and fund a new ALT during a batch",
      );
    }
    const created = await createLookupTable(connection, signer, [
      EXECUTOR,
      ...Object.values(routeAccounts),
      ...[...initialBuilds.values()].flatMap(({ bins }) => bins),
    ]);
    table = created.table;
    altSignatures = created.signatures;
  }
  console.log("Lookup table", table.key.toBase58());
  console.log("Lookup table setup signatures", altSignatures);

  let blockhashCache: CachedBlockhash | null = null;
  let blockhashRefreshInFlight: Promise<CachedBlockhash> | null = null;
  const refreshBlockhash = (): Promise<CachedBlockhash> => {
    if (blockhashRefreshInFlight) return blockhashRefreshInFlight;
    blockhashRefreshInFlight = connection
      .getLatestBlockhashAndContext("confirmed")
      .then(({ context, value }) => {
        const refreshed = {
          contextSlot: context.slot,
          value,
          fetchedAtMs: Date.now(),
        };
        blockhashCache = refreshed;
        return refreshed;
      })
      .finally(() => {
        blockhashRefreshInFlight = null;
      });
    return blockhashRefreshInFlight;
  };
  const freshBlockhash = async (): Promise<CachedBlockhash> => {
    if (
      !blockhashCache ||
      Date.now() - blockhashCache.fetchedAtMs > BLOCKHASH_MAX_AGE_MS
    ) {
      return refreshBlockhash();
    }
    return blockhashCache;
  };

  async function transactionFor(
    instruction: TransactionInstruction,
    cachedBlockhash?: CachedBlockhash,
  ) {
    const selectedBlockhash = cachedBlockhash ?? (await refreshBlockhash());
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: selectedBlockhash.value.blockhash,
      instructions: [
        ...computeBudgetInstructions(
          COMPUTE_UNIT_LIMIT,
          COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
        ),
        instruction,
      ],
    }).compileToV0Message([table]);
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    return {
      transaction,
      latest: selectedBlockhash.value,
      blockhashContextSlot: selectedBlockhash.contextSlot,
      blockhashFetchedAtMs: selectedBlockhash.fetchedAtMs,
    };
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
    const existingManifest = existsSync(reportPath)
      ? (JSON.parse(readFileSync(reportPath, "utf8")) as {
          targetMint: string;
          pumpPool: string;
          meteoraPool: string;
          requestedBroadcasts: number;
          direction: string;
          intervalMs: number;
          wsolAmountIn: string;
          minProfitLamports: string;
          computeUnitLimit?: number;
          computeUnitPriceMicroLamports?: number;
          senderMaxInFlight?: number;
          sendErrors?: number;
          records: BatchRecord[];
        })
      : null;
    if (
      existingManifest &&
      (existingManifest.targetMint !== TARGET_MINT.toBase58() ||
        existingManifest.pumpPool !== PUMP_POOL.toBase58() ||
        existingManifest.meteoraPool !== METEORA_POOL.toBase58() ||
        existingManifest.requestedBroadcasts !== TRANSACTION_COUNT ||
        existingManifest.direction !== TRANSACTION_DIRECTION ||
        existingManifest.intervalMs !== TRANSACTION_INTERVAL_MS ||
        existingManifest.wsolAmountIn !== WSOL_AMOUNT_IN.toString() ||
        existingManifest.minProfitLamports !== MIN_PROFIT_LAMPORTS.toString() ||
        existingManifest.computeUnitLimit !== COMPUTE_UNIT_LIMIT ||
        existingManifest.computeUnitPriceMicroLamports !==
          COMPUTE_UNIT_PRICE_MICRO_LAMPORTS ||
        existingManifest.senderMaxInFlight !== SENDER_MAX_IN_FLIGHT)
    ) {
      throw new Error("Existing broadcast manifest configuration mismatch");
    }
    const records: BatchRecord[] = existingManifest?.records ?? [];
    let sendErrors = existingManifest?.sendErrors ?? 0;
    let sendingComplete = false;
    const renderManifest = () =>
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
          computeUnitLimit: COMPUTE_UNIT_LIMIT,
          computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
          senderMaxInFlight: SENDER_MAX_IN_FLIGHT,
          transactionSignAheadMs: TRANSACTION_SIGN_AHEAD_MS,
          blockhashRefreshMs: BLOCKHASH_REFRESH_MS,
          blockhashMaxAgeMs: BLOCKHASH_MAX_AGE_MS,
          routeSnapshotRefreshMs: ROUTE_SNAPSHOT_REFRESH_MS,
          sendErrors,
          sendingComplete,
          records: [...records].sort((a, b) => a.ordinal - b.ordinal),
        },
        null,
        2,
      )}\n`;
    const manifestWriter = new AsyncManifestWriter(reportPath, renderManifest);
    await manifestWriter.flush();

    await refreshBlockhash();
    const blockhashTimer = setInterval(() => {
      void refreshBlockhash().catch((error) =>
        console.warn("Blockhash refresh failed", {
          error: sanitizedErrorMessage(error),
        }),
      );
    }, BLOCKHASH_REFRESH_MS);
    const routeSnapshotTimer = setInterval(() => {
      void refreshRouteSnapshot().catch((error) =>
        console.warn("Route snapshot refresh failed", {
          error: sanitizedErrorMessage(error),
        }),
      );
    }, ROUTE_SNAPSHOT_REFRESH_MS);
    const gate = new ConcurrencyGate(SENDER_MAX_IN_FLIGHT);
    const issuedSignatures = new Set(records.map(({ signature }) => signature));
    const firstOrdinal = records.length + 1;
    const scheduleStartedAtMs = Date.now();
    const scheduledTasks: Promise<void>[] = [];

    for (
      let ordinal = firstOrdinal;
      ordinal <= TRANSACTION_COUNT;
      ordinal += 1
    ) {
      const scheduledBroadcastTimestampMs = scheduledBroadcastTimestamp(
        scheduleStartedAtMs,
        firstOrdinal,
        ordinal,
        TRANSACTION_INTERVAL_MS,
      );
      scheduledTasks.push(
        (async () => {
          await sleep(
            Math.max(
              0,
              scheduledBroadcastTimestampMs -
                TRANSACTION_SIGN_AHEAD_MS -
                Date.now(),
            ),
          );
          let recorded = false;
          while (!recorded) {
            try {
              const prepared = await gate.run(async () => {
                const direction = directionFor(ordinal);
                const buildStartedTimestampMs = Date.now();
                const selectedSnapshot = routeSnapshot;
                if (!selectedSnapshot) {
                  throw new Error("Route snapshot is not initialized");
                }
                const built = selectedSnapshot.builds.get(direction);
                if (!built) {
                  throw new Error(
                    `Route snapshot does not contain ${direction}`,
                  );
                }
                let transaction: VersionedTransaction;
                let latest: BlockhashWithExpiryBlockHeight;
                let blockhashContextSlot: number;
                let blockhashFetchedAtMs: number;
                let signedTimestampMs: number;
                let signature: string;
                for (;;) {
                  const selectedBlockhash = await freshBlockhash();
                  const builtTransaction = await transactionFor(
                    built.instruction,
                    selectedBlockhash,
                  );
                  transaction = builtTransaction.transaction;
                  latest = builtTransaction.latest;
                  blockhashContextSlot = builtTransaction.blockhashContextSlot;
                  blockhashFetchedAtMs = builtTransaction.blockhashFetchedAtMs;
                  signedTimestampMs = Date.now();
                  signature = utils.bytes.bs58.encode(
                    transaction.signatures[0],
                  );
                  if (reserveUniqueSignature(issuedSignatures, signature)) {
                    break;
                  }
                  await sleep(50);
                  await refreshBlockhash();
                }
                const serialized = transaction.serialize();
                await sleep(
                  Math.max(0, scheduledBroadcastTimestampMs - Date.now()),
                );
                const broadcastTimestampMs = Date.now();
                const broadcastObservedSlotPromise = connection
                  .getSlot("processed")
                  .catch((error) => {
                    console.warn("Broadcast slot sample failed", {
                      ordinal,
                      error: sanitizedErrorMessage(error),
                    });
                    return null;
                  });
                let rpcAcknowledgedAt: string | null = null;
                let rpcAckDurationMs: number | null = null;
                let rpcError: string | null = null;
                try {
                  const returnedSignature = await connection.sendRawTransaction(
                    serialized,
                    {
                      skipPreflight: true,
                      maxRetries: 5,
                    },
                  );
                  const acknowledgedTimestampMs = Date.now();
                  rpcAcknowledgedAt = new Date(
                    acknowledgedTimestampMs,
                  ).toISOString();
                  rpcAckDurationMs =
                    acknowledgedTimestampMs - broadcastTimestampMs;
                  if (returnedSignature !== signature) {
                    rpcError = `RPC returned unexpected signature ${returnedSignature}`;
                    sendErrors += 1;
                  }
                } catch (error) {
                  rpcError = sanitizedErrorMessage(error);
                  rpcAckDurationMs = Date.now() - broadcastTimestampMs;
                  sendErrors += 1;
                }
                return {
                  direction,
                  signature,
                  broadcastTimestampMs,
                  broadcastObservedSlotPromise,
                  buildStartedTimestampMs,
                  signedTimestampMs,
                  blockhashContextSlot,
                  blockhashFetchedAtMs,
                  latest,
                  rpcAcknowledgedAt,
                  rpcAckDurationMs,
                  rpcError,
                  routeSnapshotVersion: selectedSnapshot.version,
                  routeSnapshotAgeMs:
                    buildStartedTimestampMs - selectedSnapshot.refreshedAtMs,
                };
              });
              const broadcastObservedSlot =
                await prepared.broadcastObservedSlotPromise;
              const record: BatchRecord = {
                ordinal,
                direction: prepared.direction,
                signature: prepared.signature,
                broadcastAt: new Date(
                  prepared.broadcastTimestampMs,
                ).toISOString(),
                broadcastTimestampMs: prepared.broadcastTimestampMs,
                blockhashContextSlot: prepared.blockhashContextSlot,
                broadcastObservedSlot,
                lastValidBlockHeight: prepared.latest.lastValidBlockHeight,
                scheduledBroadcastAt: new Date(
                  scheduledBroadcastTimestampMs,
                ).toISOString(),
                scheduledBroadcastTimestampMs,
                buildStartedTimestampMs: prepared.buildStartedTimestampMs,
                signedTimestampMs: prepared.signedTimestampMs,
                buildAndSignDurationMs:
                  prepared.signedTimestampMs - prepared.buildStartedTimestampMs,
                scheduleDelayMs:
                  prepared.broadcastTimestampMs - scheduledBroadcastTimestampMs,
                rpcAcknowledgedAt: prepared.rpcAcknowledgedAt,
                rpcAckDurationMs: prepared.rpcAckDurationMs,
                rpcError: prepared.rpcError,
                routeSnapshotVersion: prepared.routeSnapshotVersion,
                routeSnapshotAgeMs: prepared.routeSnapshotAgeMs,
                blockhashAgeMs:
                  prepared.signedTimestampMs - prepared.blockhashFetchedAtMs,
                status: "broadcast",
              };
              records.push(record);
              manifestWriter.request();
              console.log("Batch broadcast", {
                ordinal,
                direction: record.direction,
                signature: record.signature,
                scheduledBroadcastAt: record.scheduledBroadcastAt,
                broadcastAt: record.broadcastAt,
                scheduleDelayMs: record.scheduleDelayMs,
                rpcAckDurationMs: record.rpcAckDurationMs,
                rpcError: record.rpcError,
                blockhashContextSlot: record.blockhashContextSlot,
                broadcastObservedSlot: record.broadcastObservedSlot,
                blockhashAgeMs: record.blockhashAgeMs,
                routeSnapshotVersion: record.routeSnapshotVersion,
                routeSnapshotAgeMs: record.routeSnapshotAgeMs,
              });
              recorded = true;
            } catch (error) {
              sendErrors += 1;
              manifestWriter.request();
              console.error("Batch preparation error", {
                ordinal,
                sendErrors,
                error: sanitizedErrorMessage(error),
              });
              await sleep(100);
            }
          }
        })(),
      );
    }

    try {
      await Promise.all(scheduledTasks);
    } finally {
      clearInterval(blockhashTimer);
      clearInterval(routeSnapshotTimer);
    }
    sendingComplete = true;
    await manifestWriter.flush();
    console.log("Broadcasting complete", {
      broadcast: records.length,
      sendErrors,
      manifestPath: reportPath,
    });
    return;
  }

  for (const mode of initialModes) {
    const built = initialBuilds.get(mode)!;
    const { transaction } = await transactionFor(built.instruction);
    const result = await connection.simulateTransaction(transaction, {
      commitment: "confirmed",
      sigVerify: true,
    });
    console.log("Simulation", mode, {
      quote: built.quote,
      error: result.value.err,
      unitsConsumed: result.value.unitsConsumed,
    });
    if (result.value.err) {
      console.log("Simulation logs", result.value.logs);
      throw new Error(`${mode} simulation failed`);
    }
  }

  if (process.env.SEND_REAL_TRANSACTION !== "true") {
    console.log(
      "Configured simulations passed. SEND_REAL_TRANSACTION is not true; stopping.",
    );
    return;
  }

  for (const direction of initialModes) {
    let confirmed = false;
    for (let attempt = 1; attempt <= 3 && !confirmed; attempt += 1) {
      const built = (await refreshRouteSnapshot()).builds.get(direction)!;
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
  console.error(sanitizedErrorMessage(error));
  process.exit(1);
});
