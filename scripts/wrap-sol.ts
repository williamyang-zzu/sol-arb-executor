import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Commitment,
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_COMMITMENT: Commitment = "confirmed";

export interface WrapSolOptions {
  amountLamports: bigint;
  execute: boolean;
  help: boolean;
  walletPath?: string;
}

function usage(): string {
  return `Usage:
  npm run wrap-sol -- --amount-lamports <lamports> [--wallet <keypair.json>]
  npm run wrap-sol -- --amount-lamports <lamports> [--wallet <keypair.json>] --execute

The default mode performs a signed RPC simulation without broadcasting.
Add --execute only after reviewing the preview.

RPC lookup order (values are never printed):
  WRAP_SOL_RPC_URL, EXECUTOR_RPC_URL, RPC_URL

Wallet lookup order:
  --wallet, WRAP_SOL_WALLET_PATH, WALLET_PATH, ~/.config/solana/id.json

Example for adding exactly 0.24 WSOL:
  npm run wrap-sol -- --amount-lamports 240000000 --wallet /path/to/trader.json
  npm run wrap-sol -- --amount-lamports 240000000 --wallet /path/to/trader.json --execute`;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(args: string[]): WrapSolOptions {
  let amountLamports: bigint | undefined;
  let execute = false;
  let help = false;
  let walletPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--amount-lamports": {
        const raw = requireValue(args, index, argument);
        if (!/^[1-9][0-9]*$/.test(raw)) {
          throw new Error("--amount-lamports must be a positive integer");
        }
        amountLamports = BigInt(raw);
        if (amountLamports > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(
            `--amount-lamports must not exceed ${Number.MAX_SAFE_INTEGER}`,
          );
        }
        index += 1;
        break;
      }
      case "--wallet":
        walletPath = requireValue(args, index, argument);
        index += 1;
        break;
      case "--execute":
        execute = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!help && amountLamports === undefined) {
    throw new Error("--amount-lamports is required");
  }

  return {
    amountLamports: amountLamports ?? 0n,
    execute,
    help,
    walletPath,
  };
}

function rpcUrlFromEnvironment(): string {
  const rpcUrl =
    process.env.WRAP_SOL_RPC_URL ??
    process.env.EXECUTOR_RPC_URL ??
    process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "Set WRAP_SOL_RPC_URL, EXECUTOR_RPC_URL, or RPC_URL before running this tool",
    );
  }
  return rpcUrl;
}

function walletPathFor(options: WrapSolOptions): string {
  return resolve(
    options.walletPath ??
      process.env.WRAP_SOL_WALLET_PATH ??
      process.env.WALLET_PATH ??
      `${homedir()}/.config/solana/id.json`,
  );
}

function readKeypair(path: string): Keypair {
  if (!existsSync(path)) {
    throw new Error("Wallet keypair file does not exist");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Wallet keypair file is not valid JSON");
  }

  if (
    !Array.isArray(decoded) ||
    decoded.length !== 64 ||
    decoded.some(
      (value) =>
        !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255,
    )
  ) {
    throw new Error("Wallet keypair file must contain 64 byte values");
  }

  return Keypair.fromSecretKey(Uint8Array.from(decoded as number[]));
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`;
}

function sanitizedMessage(error: unknown, rpcUrl: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutConfiguredRpc = rpcUrl
    ? raw.split(rpcUrl).join("[redacted-rpc-url]")
    : raw;
  return withoutConfiguredRpc.replace(/https?:\/\/[^\s]+/g, "[redacted-url]");
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  loadDotenv();
  const rpcUrl = rpcUrlFromEnvironment();
  const signer = readKeypair(walletPathFor(options));
  const connection = new Connection(rpcUrl, DEFAULT_COMMITMENT);
  const userWsol = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    signer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const accountInfo = await connection.getAccountInfo(
    userWsol,
    DEFAULT_COMMITMENT,
  );
  let currentWsol = 0n;
  if (accountInfo) {
    const account = await getAccount(
      connection,
      userWsol,
      DEFAULT_COMMITMENT,
      TOKEN_PROGRAM_ID,
    );
    if (!account.owner.equals(signer.publicKey)) {
      throw new Error("Derived WSOL ATA has an unexpected token owner");
    }
    if (!account.mint.equals(NATIVE_MINT) || !account.isNative) {
      throw new Error("Derived account is not a native WSOL token account");
    }
    currentWsol = account.amount;
  }

  const instructions = [];
  if (!accountInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        userWsol,
        signer.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  instructions.push(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: userWsol,
      lamports: Number(options.amountLamports),
    }),
    createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(DEFAULT_COMMITMENT);
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);
  const feeLamports =
    (
      await connection.getFeeForMessage(
        transaction.compileMessage(),
        DEFAULT_COMMITMENT,
      )
    ).value ?? 0;
  const ataRentLamports = accountInfo
    ? 0
    : await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const nativeBalance = BigInt(
    await connection.getBalance(signer.publicKey, DEFAULT_COMMITMENT),
  );
  const requiredNativeBalance =
    options.amountLamports + BigInt(feeLamports + ataRentLamports);

  console.log(`Signer public key: ${signer.publicKey.toBase58()}`);
  console.log(`WSOL ATA: ${userWsol.toBase58()}`);
  console.log(
    `WSOL ATA status: ${accountInfo ? "existing" : "will be created"}`,
  );
  console.log(
    `Current WSOL balance: ${currentWsol} lamports (${formatSol(currentWsol)} WSOL)`,
  );
  console.log(
    `Requested increase: ${options.amountLamports} lamports (${formatSol(options.amountLamports)} WSOL)`,
  );
  console.log(
    `Expected WSOL balance: ${currentWsol + options.amountLamports} lamports (${formatSol(currentWsol + options.amountLamports)} WSOL)`,
  );
  console.log(`Estimated network fee: ${feeLamports} lamports`);
  console.log(`Additional ATA rent: ${ataRentLamports} lamports`);
  console.log("RPC URL: configured (redacted)");

  if (nativeBalance < requiredNativeBalance) {
    throw new Error(
      `Insufficient native SOL: need at least ${requiredNativeBalance} lamports for amount, estimated fee, and rent`,
    );
  }

  if (!options.execute) {
    const simulation = await connection.simulateTransaction(transaction, [
      signer,
    ]);
    if (simulation.value.err) {
      throw new Error(
        `Simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
    }
    console.log("Simulation passed; nothing was broadcast and no SOL moved.");
    console.log("Re-run the same command with --execute to broadcast.");
    return;
  }

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [signer],
    {
      commitment: DEFAULT_COMMITMENT,
      preflightCommitment: DEFAULT_COMMITMENT,
      maxRetries: 5,
      skipPreflight: false,
    },
  );
  console.log(`Confirmed signature: ${signature}`);

  const updated = await getAccount(
    connection,
    userWsol,
    DEFAULT_COMMITMENT,
    TOKEN_PROGRAM_ID,
  );
  const expectedMinimum = currentWsol + options.amountLamports;
  if (updated.amount < expectedMinimum) {
    throw new Error(
      "Transaction confirmed, but the observed WSOL balance is below the expected increase; inspect the public signature",
    );
  }
  console.log(
    `Updated WSOL balance: ${updated.amount} lamports (${formatSol(updated.amount)} WSOL)`,
  );
}

if (require.main === module) {
  run().catch((error: unknown) => {
    const rpcUrl =
      process.env.WRAP_SOL_RPC_URL ??
      process.env.EXECUTOR_RPC_URL ??
      process.env.RPC_URL ??
      "";
    console.error(`wrap-sol failed: ${sanitizedMessage(error, rpcUrl)}`);
    process.exitCode = 1;
  });
}
