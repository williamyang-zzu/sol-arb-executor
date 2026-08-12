import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import {
  AsyncManifestWriter,
  ConcurrencyGate,
  computeBudgetInstructions,
  reserveUniqueSignature,
  sanitizedErrorMessage,
  scheduledBroadcastTimestamp,
} from "../scripts/sender-pipeline";

describe("smoke sender pipeline", () => {
  it("rejects a duplicate locally signed transaction signature", () => {
    const signatures = new Set<string>();
    expect(reserveUniqueSignature(signatures, "first")).to.equal(true);
    expect(reserveUniqueSignature(signatures, "first")).to.equal(false);
    expect(reserveUniqueSignature(signatures, "second")).to.equal(true);
  });

  it("redacts RPC URLs and API keys before logging or persistence", () => {
    const message = sanitizedErrorMessage(
      new Error(
        "request failed https://rpc.example/?api-key=do-not-store-me token=also-secret",
      ),
    );
    expect(message).not.to.include("do-not-store-me");
    expect(message).not.to.include("also-secret");
    expect(message).not.to.include("rpc.example");
  });

  it("encodes the configured CU price and CU limit", () => {
    const [price, limit] = computeBudgetInstructions(300_000, 300);
    expect(price.data[0]).to.equal(3);
    expect(price.data.readBigUInt64LE(1)).to.equal(300n);
    expect(limit.data[0]).to.equal(2);
    expect(limit.data.readUInt32LE(1)).to.equal(300_000);
  });

  it("uses an absolute schedule without accumulating prior delays", () => {
    expect(scheduledBroadcastTimestamp(10_000, 4, 4, 1_000)).to.equal(10_000);
    expect(scheduledBroadcastTimestamp(10_000, 4, 9, 1_000)).to.equal(15_000);
  });

  it("caps concurrent work at the configured limit", async () => {
    const gate = new ConcurrencyGate(3);
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const blocker = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tasks = Array.from({ length: 8 }, () =>
      gate.run(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await blocker;
        active -= 1;
      }),
    );
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(maximumActive).to.equal(3);
    release();
    await Promise.all(tasks);
  });

  it("coalesces asynchronous manifest writes and flushes the latest state", async () => {
    const directory = resolve("target/sender-pipeline-tests");
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, `manifest-${process.pid}.json`);
    let version = 1;
    const writer = new AsyncManifestWriter(path, () =>
      JSON.stringify({ version }),
    );
    writer.request();
    version = 2;
    writer.request();
    await writer.flush();
    expect(existsSync(path)).to.equal(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).to.deep.equal({
      version: 2,
    });
  });
});
