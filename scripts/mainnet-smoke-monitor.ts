import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Connection } from "@solana/web3.js";

type Direction = "pump-to-meteora" | "meteora-to-pump" | "best-direction";
type Status = "broadcast" | "success" | "reverted" | "expired";

type BroadcastRecord = {
  ordinal: number;
  direction: Direction;
  signature: string;
  broadcastAt: string;
  broadcastTimestampMs: number;
  lastValidBlockHeight: number;
  status: "broadcast";
};

type Manifest = {
  generatedAt: string;
  programId: string;
  trader: string;
  targetMint: string;
  pumpPool: string;
  meteoraPool: string;
  direction: string;
  requestedBroadcasts: number;
  intervalMs: number;
  wsolAmountIn: string;
  minProfitLamports: string;
  sendErrors: number;
  sendingComplete: boolean;
  records: BroadcastRecord[];
};

type MonitoredRecord = Omit<BroadcastRecord, "status"> & {
  status: Status;
  landedSlot: number | null;
  transactionPosition: number | null;
  confirmationStatus: string | null;
  confirmedAt: string | null;
  errorType: string | null;
  error: unknown;
  computeUnitsConsumed: number | null;
  feeLamports: number | null;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function errorTypeFromLogs(logs: string[], error: unknown): string | null {
  const anchorError = logs.find((line) => line.includes("Error Code:"));
  const anchorCode = anchorError?.match(/Error Code: ([^.]+)\./)?.[1];
  if (anchorCode) return anchorCode;
  const failedProgram = logs.find((line) => line.includes(" failed:"));
  if (failedProgram) return failedProgram;
  return error ? JSON.stringify(error) : null;
}

async function blockSignatures(
  connection: Connection,
  slot: number,
): Promise<string[]> {
  const rpc = connection as unknown as {
    _rpcRequest: (
      method: string,
      args: unknown[],
    ) => Promise<{ result?: { signatures?: string[] }; error?: unknown }>;
  };
  const response = await rpc._rpcRequest("getBlock", [
    slot,
    {
      commitment: "confirmed",
      transactionDetails: "signatures",
      rewards: false,
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (response.error) {
    throw new Error(
      `getBlock(${slot}) failed: ${JSON.stringify(response.error)}`,
    );
  }
  return response.result?.signatures ?? [];
}

function readManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const connection = new Connection(required("RPC_URL"), "confirmed");
  const manifestPath = resolve(required("BROADCAST_MANIFEST_FILE"));
  const reportPath = resolve(
    process.env.MONITOR_REPORT_FILE ??
      manifestPath.replace(/\.json$/, "-results.json"),
  );
  if (manifestPath === reportPath) {
    throw new Error("MONITOR_REPORT_FILE must differ from the manifest file");
  }
  const pollMs = Number(process.env.MONITOR_POLL_MS ?? "1000");
  if (!Number.isSafeInteger(pollMs) || pollMs < 250) {
    throw new Error("MONITOR_POLL_MS must be an integer of at least 250");
  }
  mkdirSync(dirname(reportPath), { recursive: true });

  const records = new Map<string, MonitoredRecord>();
  const blockPositions = new Map<number, Map<string, number>>();
  let manifest: Manifest | null = null;

  const persist = () => {
    const values = [...records.values()].sort((a, b) => a.ordinal - b.ordinal);
    const succeeded = values.filter((record) => record.status === "success");
    const reverted = values.filter((record) => record.status === "reverted");
    const expired = values.filter((record) => record.status === "expired");
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceManifest: manifestPath,
          manifest,
          summary: {
            observed: values.length,
            pending: values.filter((record) => record.status === "broadcast")
              .length,
            succeeded: succeeded.length,
            reverted: reverted.length,
            expired: expired.length,
            totalFeeLamports: values.reduce(
              (total, record) => total + (record.feeLamports ?? 0),
              0,
            ),
          },
          records: values,
        },
        null,
        2,
      )}\n`,
    );
  };

  for (;;) {
    const latestManifest = readManifest(manifestPath);
    if (!latestManifest) {
      await sleep(pollMs);
      continue;
    }
    manifest = latestManifest;
    for (const source of manifest.records) {
      if (!records.has(source.signature)) {
        records.set(source.signature, {
          ...source,
          status: "broadcast",
          landedSlot: null,
          transactionPosition: null,
          confirmationStatus: null,
          confirmedAt: null,
          errorType: null,
          error: null,
          computeUnitsConsumed: null,
          feeLamports: null,
        });
      }
    }

    const pending = [...records.values()].filter(
      (record) => record.status === "broadcast",
    );
    if (pending.length > 0) {
      try {
        const currentBlockHeight = await connection.getBlockHeight("confirmed");
        for (let offset = 0; offset < pending.length; offset += 256) {
          const group = pending.slice(offset, offset + 256);
          const response = await connection.getSignatureStatuses(
            group.map((record) => record.signature),
            { searchTransactionHistory: true },
          );
          for (let index = 0; index < group.length; index += 1) {
            const record = group[index];
            const status = response.value[index];
            if (!status) {
              if (currentBlockHeight > record.lastValidBlockHeight) {
                record.status = "expired";
                record.errorType = "BlockhashExpiredWithoutLanding";
                record.confirmedAt = new Date().toISOString();
              }
              continue;
            }
            const transaction = await connection.getTransaction(
              record.signature,
              {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              },
            );
            if (!transaction) continue;
            let positions = blockPositions.get(status.slot);
            if (!positions) {
              positions = new Map(
                (await blockSignatures(connection, status.slot)).map(
                  (signature, position) => [signature, position + 1],
                ),
              );
              blockPositions.set(status.slot, positions);
            }
            const logs = transaction.meta?.logMessages ?? [];
            record.status = status.err === null ? "success" : "reverted";
            record.landedSlot = status.slot;
            record.transactionPosition =
              positions.get(record.signature) ?? null;
            record.confirmationStatus = status.confirmationStatus ?? null;
            record.confirmedAt = new Date().toISOString();
            record.error = status.err;
            record.errorType = errorTypeFromLogs(logs, status.err);
            record.computeUnitsConsumed = Number(
              transaction.meta?.computeUnitsConsumed ?? 0,
            );
            record.feeLamports = transaction.meta?.fee ?? null;
            console.log("Transaction status", {
              ordinal: record.ordinal,
              direction: record.direction,
              signature: record.signature,
              status: record.status,
              slot: record.landedSlot,
              transactionPosition: record.transactionPosition,
              errorType: record.errorType,
              computeUnitsConsumed: record.computeUnitsConsumed,
              feeLamports: record.feeLamports,
            });
          }
        }
      } catch (error) {
        console.error("Monitor poll error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    persist();

    const complete =
      manifest.sendingComplete &&
      records.size >= manifest.requestedBroadcasts &&
      [...records.values()].every((record) => record.status !== "broadcast");
    if (complete) {
      console.log("Monitoring complete", { reportPath });
      return;
    }
    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
