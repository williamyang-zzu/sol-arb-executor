import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

export type Direction = "pump-to-meteora" | "meteora-to-pump";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function readKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(resolve(path), "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function readRouteAccounts(path: string): Record<string, PublicKey> {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<
    string,
    string
  >;
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, new PublicKey(value)]),
  );
}

function readBinArrays(): PublicKey[] {
  return required("METEORA_BIN_ARRAYS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new PublicKey(value));
}

export async function simulate(direction: Direction): Promise<void> {
  const rpcUrl = required("RPC_URL");
  const wallet = readKeypair(required("WALLET_PATH"));
  const routeAccounts = readRouteAccounts(required("ROUTE_ACCOUNTS_FILE"));
  const connection = new Connection(rpcUrl, "processed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "processed",
    preflightCommitment: "processed",
  });
  const idl = JSON.parse(
    readFileSync(resolve("target/idl/sol_arb_executor.json"), "utf8"),
  ) as Idl;
  const program = new Program(idl, provider);
  const binArrays = readBinArrays();
  const lookupTableAddress = new PublicKey(required("ADDRESS_LOOKUP_TABLE"));
  const lookupTableResponse =
    await connection.getAddressLookupTable(lookupTableAddress);
  if (!lookupTableResponse.value) {
    throw new Error(`Address lookup table ${lookupTableAddress} was not found`);
  }

  // These explicit environment values provide a visible sanity check against
  // accidental reuse of a route-accounts file for a different opportunity.
  const summary = {
    direction,
    tokenMint: required("TOKEN_MINT"),
    pumpPool: required("PUMP_POOL"),
    meteoraPool: required("METEORA_POOL"),
    userWsolAccount: required("USER_WSOL_ACCOUNT"),
    userTokenAccount: required("USER_TOKEN_ACCOUNT"),
    addressLookupTable: lookupTableAddress.toBase58(),
    binArrays: binArrays.map(String),
  };

  let routeIx: TransactionInstruction;
  if (direction === "pump-to-meteora") {
    routeIx = await program.methods
      .executePumpToMeteora({
        wsolAmountIn: new BN(required("WSOL_AMOUNT_IN")),
        minProfitLamports: new BN(required("MIN_PROFIT_LAMPORTS")),
      })
      .accounts(routeAccounts)
      .remainingAccounts(
        binArrays.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();
  } else {
    routeIx = await program.methods
      .executeMeteoraToPump({
        wsolAmountIn: new BN(required("WSOL_AMOUNT_IN")),
        minProfitLamports: new BN(required("MIN_PROFIT_LAMPORTS")),
      })
      .accounts(routeAccounts)
      .remainingAccounts(
        binArrays.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();
  }

  const latest = await connection.getLatestBlockhash("processed");
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      routeIx,
    ],
  }).compileToV0Message([lookupTableResponse.value]);
  const transaction = new VersionedTransaction(message);
  transaction.sign([wallet]);

  console.log("Route summary", summary);
  console.log(
    "Instruction accounts",
    routeIx.keys.map((meta, index) => ({
      index,
      pubkey: meta.pubkey.toBase58(),
      signer: meta.isSigner,
      writable: meta.isWritable,
    })),
  );

  const result = await connection.simulateTransaction(transaction);
  console.log("Simulation error", result.value.err);
  console.log("Units consumed", result.value.unitsConsumed);
  console.log("Simulation logs");
  for (const line of result.value.logs ?? []) console.log(line);

  if (process.env.SEND_REAL_TRANSACTION === "true") {
    console.warn(
      "WARNING: SEND_REAL_TRANSACTION=true; broadcasting a real transaction",
    );
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        maxRetries: 0,
      },
    );
    console.log("Sent transaction", signature);
  } else {
    console.log(
      "Simulation only. Set SEND_REAL_TRANSACTION=true to broadcast explicitly.",
    );
  }
}
