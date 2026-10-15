import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";

interface DynamicSelection {
  direction: string;
  minWsolAmountIn: string;
  maxWsolAmountIn: string;
  balanceLimitedMax: string;
  largestCompleteAmount: string;
  actualWsolAmountIn: string;
  expectedWsolAmountOut: string;
  expectedProfitLamports: string;
  visitedBins: number;
  boundaryCandidates: number;
  interiorCandidates: number;
  earlyStopUsed: boolean;
  eventBase64: string;
}

interface Success {
  signature: string;
  slot: number;
  wsolProfitLamports: string;
  feeLamports: number;
  tipLamports?: number;
  netProfitLamports?: string;
  nativePayerDebitLamports?: string;
  preWsolBalance?: string;
  postWsolBalance?: string;
  transactionIndex?: number | null;
  targetTokenBalancesUnchanged?: boolean;
  clientAcceptance?: { broadcastMode: string; targetTps: number };
  evidence?: { historicalPrestateAvailable: boolean };
  dynamicSelection?: DynamicSelection;
}

// Deliberately no dotenv import, Connection, wallet loading or RPC access.
const fixture = JSON.parse(
  readFileSync(
    resolve("tests/fixtures/mainnet-execution-milestones.json"),
    "utf8",
  ),
) as { successes: Success[] };

describe("offline mainnet milestone fixture consistency", () => {
  it("keeps transaction identities unique", () => {
    expect(
      new Set(fixture.successes.map((row) => row.signature)).size,
    ).to.equal(fixture.successes.length);
  });

  for (const row of fixture.successes) {
    it(`preserves recorded cost and event arithmetic at slot ${row.slot}`, () => {
      const gross = BigInt(row.wsolProfitLamports);
      const tip = BigInt(row.tipLamports ?? 0);
      const net = gross - BigInt(row.feeLamports) - tip;
      expect(gross > 0n).to.equal(true);
      expect(net > 0n).to.equal(true);
      if (row.netProfitLamports !== undefined) {
        expect(net).to.equal(BigInt(row.netProfitLamports));
      }
      if (row.nativePayerDebitLamports !== undefined) {
        expect(BigInt(row.nativePayerDebitLamports)).to.equal(
          BigInt(row.feeLamports) + tip,
        );
      }
      if (row.preWsolBalance !== undefined) {
        expect(row.postWsolBalance).to.be.a("string");
        expect(
          BigInt(row.postWsolBalance!) - BigInt(row.preWsolBalance),
        ).to.equal(gross);
      }

      const selection = row.dynamicSelection;
      if (!selection) return;
      const event = Buffer.from(selection.eventBase64, "base64");
      // Published Anchor DynamicAmountSelected layout: discriminator, enum,
      // seven u64s, three u8 counters and a bool. This is evidence validation,
      // not a second quote/search implementation.
      expect(event.length).to.equal(69);
      expect([...event.subarray(0, 8)]).to.deep.equal([
        50, 13, 43, 161, 51, 237, 241, 38,
      ]);
      expect(event[8]).to.be.oneOf([0, 1]);
      expect(selection.direction).to.equal(
        event[8] === 0 ? "pump-to-meteora" : "meteora-to-pump",
      );
      const amounts = [
        "minWsolAmountIn",
        "maxWsolAmountIn",
        "balanceLimitedMax",
        "largestCompleteAmount",
        "actualWsolAmountIn",
        "expectedWsolAmountOut",
        "expectedProfitLamports",
      ] as const;
      amounts.forEach((name, index) => {
        expect(event.readBigUInt64LE(9 + index * 8)).to.equal(
          BigInt(selection[name]),
        );
      });
      expect(event[65]).to.equal(selection.visitedBins);
      expect(event[66]).to.equal(selection.boundaryCandidates);
      expect(event[67]).to.equal(selection.interiorCandidates);
      expect(event[68]).to.be.oneOf([0, 1]);
      expect(event[68] === 1).to.equal(selection.earlyStopUsed);
      const input = BigInt(selection.actualWsolAmountIn);
      expect(input >= BigInt(selection.minWsolAmountIn)).to.equal(true);
      expect(input <= BigInt(selection.maxWsolAmountIn)).to.equal(true);
      expect(input <= BigInt(selection.balanceLimitedMax)).to.equal(true);
      expect(input <= BigInt(selection.largestCompleteAmount)).to.equal(true);
      expect(BigInt(selection.expectedWsolAmountOut) - input).to.equal(gross);
      expect(BigInt(selection.expectedProfitLamports)).to.equal(gross);
    });
  }

  it("retains the Sender acceptance label without inventing historical state", () => {
    const row = fixture.successes.find(
      (sample) =>
        sample.signature ===
        "2xCLXgW2xtSRXZ8nv6HAPZMYmnqgVJUpHqy6GmastzAS3uvV4ZhieXgNXMzxLYJCJMefpZMuxuasmM8Urn3jFUGA",
    );
    expect(row).not.to.equal(undefined);
    expect(row!.clientAcceptance?.broadcastMode).to.equal("helius-swqos");
    expect(row!.clientAcceptance?.targetTps).to.equal(50);
    expect(row!.tipLamports).to.equal(5_000);
    expect(row!.netProfitLamports).to.equal("6225");
    expect(row!.targetTokenBalancesUnchanged).to.equal(true);
    expect(row!.transactionIndex).to.equal(null);
    expect(row!.evidence?.historicalPrestateAvailable).to.equal(false);
  });
});
