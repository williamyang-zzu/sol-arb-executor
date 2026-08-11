import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";

const rpcUrl = process.env.QUOTE_PROBE_RPC_URL ?? "http://127.0.0.1:18900";
const programId = new PublicKey(
  process.env.QUOTE_PROBE_PROGRAM_ID ??
    "7eyYjYoZz83xabxoxjf5GfNVZjpqXHNA4W2vRrmcEV4Y",
);
const connection = new Connection(rpcUrl, "processed");
const payer = Keypair.generate();
let baselineTransactionCu = 0;

function writeU64(buffer: Buffer, offset: number, value: bigint): void {
  buffer.writeBigUInt64LE(value, offset);
}

function pumpData(): Buffer {
  const data = Buffer.alloc(39);
  data[0] = 0;
  writeU64(data, 1, 5_000_000n);
  writeU64(data, 9, 800_000_000_000n);
  writeU64(data, 17, 20_000_000_000n);
  writeU64(data, 25, 1_000_000_000n);
  data.writeUInt16LE(20, 33);
  data.writeUInt16LE(5, 35);
  data.writeUInt16LE(5, 37);
  return data;
}

function dlmmData(binCount: number): Buffer {
  const data = Buffer.alloc(25 + binCount * 32);
  data[0] = 1;
  writeU64(data, 1, 5_000_000n);
  data[9] = binCount;
  data[10] = 1; // swap X for Y
  data[11] = 1; // fee on input
  data.writeUInt16LE(10, 12); // bin step
  data.writeUInt16LE(200, 14); // base factor
  data[16] = 0; // base fee power factor
  data.writeUInt32LE(100, 17); // variable fee control
  data.writeUInt32LE(1_000, 21); // volatility accumulator

  const q64 = 1n << 64n;
  for (let index = 0; index < binCount; index += 1) {
    const offset = 25 + index * 32;
    // Slight price gradient; only the final bin has enough liquidity to force
    // the loop to inspect and consume every preceding bin.
    const price = (q64 * BigInt(10_000 - Math.min(index, 500))) / 10_000n;
    data.writeBigUInt64LE(price & ((1n << 64n) - 1n), offset);
    data.writeBigUInt64LE(price >> 64n, offset + 8);
    writeU64(data, offset + 16, 0n);
    writeU64(data, offset + 24, index === binCount - 1 ? 10_000_000n : 1n);
  }
  return data;
}

function syntheticDlmmData(binCount: number): Buffer {
  return Buffer.from([2, binCount]);
}

function realSnapshotInstruction(): TransactionInstruction {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/quote-parity-mainnet.json", "utf8"),
  ) as {
    quoteTimestampMs: number;
    inputLamports: string;
    addresses: Record<string, string | string[]>;
  };
  const data = Buffer.alloc(17);
  data[0] = 3;
  data.writeBigInt64LE(BigInt(Math.floor(fixture.quoteTimestampMs / 1_000)), 1);
  writeU64(data, 9, BigInt(fixture.inputLamports));
  const address = (name: string): PublicKey =>
    new PublicKey(fixture.addresses[name] as string);
  const binArray = (fixture.addresses.forwardBinArrays as string[])[0];
  return new TransactionInstruction({
    programId,
    keys: [
      "pumpPool",
      "pumpGlobalConfig",
      "pumpFeeConfig",
      "targetMint",
      "pumpBaseVault",
      "pumpQuoteVault",
      "meteoraPool",
    ]
      .map((name) => ({
        pubkey: address(name),
        isSigner: false,
        isWritable: false,
      }))
      .concat([
        {
          pubkey: new PublicKey(binArray),
          isSigner: false,
          isWritable: false,
        },
      ]),
    data,
  });
}

async function measure(
  label: string,
  dataOrInstruction: Buffer | TransactionInstruction,
): Promise<void> {
  const latest = await connection.getLatestBlockhash("processed");
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        Buffer.isBuffer(dataOrInstruction)
          ? new TransactionInstruction({
              programId,
              keys: [],
              data: dataOrInstruction,
            })
          : dataOrInstruction,
      ],
    }).compileToV0Message(),
  );
  transaction.sign([payer]);
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    throw new Error(
      `${label}: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join("\n")}`,
    );
  }
  const transactionCu = simulation.value.unitsConsumed ?? 0;
  if (label === "noop") {
    baselineTransactionCu = transactionCu;
  }
  console.log(
    JSON.stringify({
      label,
      transactionCu,
      estimatedProbeCu: Math.max(0, transactionCu - baselineTransactionCu),
    }),
  );
}

async function main(): Promise<void> {
  const airdrop = await connection.requestAirdrop(
    payer.publicKey,
    1_000_000_000,
  );
  const latest = await connection.getLatestBlockhash("processed");
  await connection.confirmTransaction(
    { signature: airdrop, ...latest },
    "processed",
  );
  await measure("noop", Buffer.from([255]));
  await measure("pump", pumpData());
  for (const binCount of [1, 2, 8]) {
    await measure(`dlmm-${binCount}-bins`, dlmmData(binCount));
  }
  for (const binCount of [1, 2, 8, 70, 140]) {
    await measure(
      `dlmm-synthetic-${binCount}-bins`,
      syntheticDlmmData(binCount),
    );
  }
  await measure("real-snapshot-two-directions", realSnapshotInstruction());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
