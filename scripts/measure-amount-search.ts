// Offline-only Surfpool experiment. No .env, wallet files, or remote RPC reads.
import { Surfnet } from "@solana/surfpool";
import {
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";

const fixtureBytes = readFileSync("tests/fixtures/quote-parity-mainnet.json");
const fixture = JSON.parse(fixtureBytes.toString());
const amounts = [
  1_000_000n,
  5_000_000n,
  10_000_000n,
  25_000_000n,
  50_000_000n,
  100_000_000n,
  250_000_000n,
  500_000_000n,
  1_000_000_000n,
];
const programId = new PublicKey("7eyYjYoZz83xabxoxjf5GfNVZjpqXHNA4W2vRrmcEV4Y");
const keys: string[] = [
  "pumpPool",
  "pumpGlobalConfig",
  "pumpFeeConfig",
  "targetMint",
  "pumpBaseVault",
  "pumpQuoteVault",
  "meteoraPool",
].map((n) => fixture.addresses[n]);
keys.push(
  ...new Set<string>([
    ...fixture.addresses.forwardBinArrays,
    ...fixture.addresses.reverseBinArrays,
  ]),
);

async function main() {
  // start() explicitly uses offline mode and an ephemeral, locally funded payer.
  const surfnet = Surfnet.start();
  try {
    surfnet.deploy({
      programId: programId.toBase58(),
      soPath: resolve("target/quote-probe/quote_probe.so"),
    });
    const connection = new Connection(surfnet.rpcUrl, "processed");
    assert.equal(new URL(surfnet.rpcUrl).hostname, "127.0.0.1");
    const results: unknown[] = [];
    for (const scenario of [
      "original-snapshot",
      "controlled-pump-cheaper",
      "controlled-pump-dearer",
      "controlled-empty-bins",
      "controlled-limited-bins",
    ]) {
      for (const account of fixture.accounts) {
        if (account.address.startsWith("Sysvar")) continue;
        const data = Buffer.from(account.dataBase64, "base64");
        if (scenario !== "original-snapshot") {
          // Controlled benchmark, not a historical counterfactual: shallow Pump
          // reserves and +/-10% price dislocation; DLMM/fee parameters retained.
          if (account.address === fixture.addresses.pumpBaseVault)
            data.writeBigUInt64LE(data.readBigUInt64LE(64) / 1000n, 64);
          if (account.address === fixture.addresses.pumpQuoteVault)
            data.writeBigUInt64LE(
              (data.readBigUInt64LE(64) *
                (scenario === "controlled-pump-dearer" ? 110n : 90n)) /
                100_000n,
              64,
            );
          if (account.address === fixture.addresses.pumpPool) {
            assert.equal(data.readBigInt64LE(253), 0n);
            data.writeBigInt64LE(
              (data.readBigInt64LE(245) *
                (scenario === "controlled-pump-dearer" ? 110n : 90n)) /
                100_000n,
              245,
            );
          }
          if (
            ["controlled-empty-bins", "controlled-limited-bins"].includes(
              scenario,
            ) &&
            keys.slice(7).includes(account.address)
          ) {
            for (let i = 0; i < 70; i++) {
              const o = 56 + 144 * i;
              for (const offset of [0, 8, 112, 128])
                data.writeBigUInt64LE(0n, o + offset);
            }
            if (scenario === "controlled-limited-bins") {
              const pairAccount = fixture.accounts.find(
                (a: { address: string }) =>
                  a.address === fixture.addresses.meteoraPool,
              );
              const active = Buffer.from(
                pairAccount.dataBase64,
                "base64",
              ).readInt32LE(76);
              const arrayIndex = data.readBigInt64LE(8);
              const binIndex = active - Number(arrayIndex) * 70;
              if (binIndex >= 0 && binIndex < 70) {
                data.writeBigUInt64LE(100_000_000n, 56 + 144 * binIndex);
                data.writeBigUInt64LE(20_000_000n, 64 + 144 * binIndex);
              }
            }
          }
        }
        surfnet.setAccount(account.address, 1_000_000_000, data, account.owner);
      }
      for (const trialAmounts of [
        [5_000_000n],
        amounts.slice(0, 4),
        amounts.slice(0, 8),
        amounts,
      ]) {
        const data = Buffer.alloc(10 + trialAmounts.length * 8);
        data[0] = 4;
        data.writeBigInt64LE(
          BigInt(Math.floor(fixture.quoteTimestampMs / 1000)),
          1,
        );
        data[9] = trialAmounts.length;
        trialAmounts.forEach((amount, i) =>
          data.writeBigUInt64LE(amount, 10 + i * 8),
        );
        const ix = new TransactionInstruction({
          programId,
          data,
          keys: keys.map((k) => ({
            pubkey: new PublicKey(k),
            isSigner: false,
            isWritable: false,
          })),
        });
        const timings: number[] = [];
        let last:
          | Awaited<ReturnType<Connection["simulateTransaction"]>>
          | undefined;
        let txBytes = 0;
        for (let repetition = 0; repetition < 3; repetition++) {
          const blockhash = await connection.getLatestBlockhash();
          const tx = new VersionedTransaction(
            new TransactionMessage({
              payerKey: new PublicKey(surfnet.payer),
              recentBlockhash: blockhash.blockhash,
              instructions: [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
                ix,
              ],
            }).compileToV0Message(),
          );
          txBytes = tx.serialize().length;
          const started = performance.now();
          last = await connection.simulateTransaction(tx, {
            sigVerify: false,
            replaceRecentBlockhash: true,
          });
          timings.push(performance.now() - started);
          assert.equal(last.value.err, null, JSON.stringify(last.value.logs));
        }
        const logs = last!.value.logs ?? [];
        const rows = logs.filter((l) => l.includes("amount-probe row="));
        assert.equal(rows.length, trialAmounts.length);
        const best = logs.find((l) => l.includes("amount-probe best="));
        const curve = rows.map((line) => {
          const match = line.match(
            /row=(\d+) forward=(Ok\(\d+\)|Err\(\w+\)) reverse=(Ok\(\d+\)|Err\(\w+\))/,
          );
          assert.ok(match, line);
          const input = BigInt(match[1]);
          const quote = (s: string) =>
            s.startsWith("Ok")
              ? {
                  complete: true,
                  outputLamports: s.slice(3, -1),
                  profitLamports: (BigInt(s.slice(3, -1)) - input).toString(),
                }
              : { complete: false, error: s.slice(4, -1) };
          return {
            inputLamports: input.toString(),
            forward: quote(match[2]),
            reverse: quote(match[3]),
          };
        });
        if (scenario === "controlled-empty-bins")
          assert.ok(best?.endsWith("None"));
        if (trialAmounts.length === 9) {
          if (scenario === "controlled-pump-cheaper")
            assert.ok(
              best?.includes(
                "input: 100000000, output: 106661306, reverse: false",
              ),
            );
          if (scenario === "controlled-pump-dearer")
            assert.ok(
              best?.includes(
                "input: 50000000, output: 51505964, reverse: true",
              ),
            );
          if (scenario === "controlled-limited-bins") {
            assert.ok(
              curve.find((row) => row.inputLamports === "5000000")?.forward
                .complete,
            );
            assert.equal(curve.at(-1)?.forward.complete, false);
            assert.equal(curve.at(-1)?.reverse.complete, false);
            assert.ok(best?.includes("Some"));
          }
        }
        if (scenario === "original-snapshot" && trialAmounts.length === 1) {
          assert.ok(
            rows[0].includes(
              `forward=Ok(${fixture.expected.forwardDlmmWsolOut})`,
            ),
          );
          assert.ok(
            rows[0].includes(`reverse=Ok(${fixture.expected.pumpSellWsolOut})`),
          );
        }
        const result = {
          scenario,
          trials: trialAmounts.length,
          amounts: trialAmounts.map(String),
          transactionCu: last!.value.unitsConsumed,
          transactionBytes: txBytes,
          accountCount: keys.length + 3,
          simulationMedianMs: timings.sort((a, b) => a - b)[1],
          rows,
          curve,
          best,
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
    mkdirSync("target/amount-search", { recursive: true });
    writeFileSync(
      "target/amount-search/surfpool-report.json",
      JSON.stringify(
        {
          provenance:
            "offline fixture and explicitly controlled states; NOT the seven successful transaction prestates",
          fixtureSha256: createHash("sha256")
            .update(fixtureBytes)
            .digest("hex"),
          programSha256: createHash("sha256")
            .update(readFileSync("target/quote-probe/quote_probe.so"))
            .digest("hex"),
          limitations: [
            "quote only; no DEX CPI or complete executor validation",
            "no bitmap extension in fixture",
            "production per-direction caps retained",
            "CU includes diagnostic logs",
            "best only within tested amounts",
          ],
          results,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    surfnet.stop();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
