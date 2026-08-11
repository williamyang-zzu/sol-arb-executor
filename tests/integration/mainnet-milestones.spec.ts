import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfirmedTransactionMeta, Connection } from "@solana/web3.js";
import { expect } from "chai";

interface SuccessFixture {
  signature: string;
  slot: number;
  wsolProfitLamports: string;
  feeLamports: number;
  computeUnitsConsumed: number;
}

interface RollbackFixture {
  signature: string;
  slot: number;
  feeLamports: number;
  computeUnitsConsumed: number;
}

interface MilestoneFixture {
  programId: string;
  trader: string;
  wsolMint: string;
  successes: SuccessFixture[];
  rollback: RollbackFixture;
}

const fixture = JSON.parse(
  readFileSync(
    resolve("tests/fixtures/mainnet-execution-milestones.json"),
    "utf8",
  ),
) as MilestoneFixture;

function requiredRpcUrl(): string {
  const value =
    process.env.MAINNET_ARCHIVE_RPC_URL ??
    process.env.SURFPOOL_MAINNET_RPC_URL ??
    process.env.RPC_URL;
  if (!value) {
    throw new Error(
      "Set MAINNET_ARCHIVE_RPC_URL (or SURFPOOL_MAINNET_RPC_URL/RPC_URL) to an RPC that serves historical transactions",
    );
  }
  return value;
}

function ownedTokenBalances(
  balances: ConfirmedTransactionMeta["preTokenBalances"],
): Map<number, bigint> {
  return new Map(
    (balances ?? [])
      .filter((balance) => balance.owner === fixture.trader)
      .map((balance) => [
        balance.accountIndex,
        BigInt(balance.uiTokenAmount.amount),
      ]),
  );
}

function expectNonWsolBalancesUnchanged(meta: ConfirmedTransactionMeta): void {
  const pre = new Map(
    (meta.preTokenBalances ?? [])
      .filter(
        (balance) =>
          balance.owner === fixture.trader && balance.mint !== fixture.wsolMint,
      )
      .map((balance) => [
        balance.accountIndex,
        BigInt(balance.uiTokenAmount.amount),
      ]),
  );
  const post = new Map(
    (meta.postTokenBalances ?? [])
      .filter(
        (balance) =>
          balance.owner === fixture.trader && balance.mint !== fixture.wsolMint,
      )
      .map((balance) => [
        balance.accountIndex,
        BigInt(balance.uiTokenAmount.amount),
      ]),
  );
  expect(post).to.deep.equal(pre);
}

describe("mainnet execution milestone evidence", function () {
  this.timeout(60_000);

  const connection = new Connection(requiredRpcUrl(), "confirmed");

  for (const success of fixture.successes) {
    it(`preserves successful execution evidence at slot ${success.slot}`, async () => {
      const transaction = await connection.getTransaction(success.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      expect(transaction, "historical transaction is unavailable").not.to.equal(
        null,
      );
      expect(transaction!.slot).to.equal(success.slot);
      expect(transaction!.meta?.err).to.equal(null);
      expect(transaction!.meta?.fee).to.equal(success.feeLamports);
      expect(transaction!.meta?.computeUnitsConsumed).to.equal(
        success.computeUnitsConsumed,
      );
      expect(
        transaction!.meta?.logMessages?.some((line) =>
          line.includes(`Program ${fixture.programId} invoke`),
        ),
      ).to.equal(true);

      const pre = ownedTokenBalances(transaction!.meta!.preTokenBalances);
      const post = ownedTokenBalances(transaction!.meta!.postTokenBalances);
      const wsolIndex = transaction!.meta!.preTokenBalances?.find(
        (balance) =>
          balance.owner === fixture.trader && balance.mint === fixture.wsolMint,
      )?.accountIndex;
      expect(wsolIndex).not.to.equal(undefined);
      expect(post.get(wsolIndex!)! - pre.get(wsolIndex!)!).to.equal(
        BigInt(success.wsolProfitLamports),
      );
      expectNonWsolBalancesUnchanged(transaction!.meta!);
    });
  }

  it("preserves atomic rollback evidence when the profit condition fails", async () => {
    const rollback = fixture.rollback;
    const transaction = await connection.getTransaction(rollback.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(transaction, "historical transaction is unavailable").not.to.equal(
      null,
    );
    expect(transaction!.slot).to.equal(rollback.slot);
    expect(transaction!.meta?.err).not.to.equal(null);
    expect(transaction!.meta?.fee).to.equal(rollback.feeLamports);
    expect(transaction!.meta?.computeUnitsConsumed).to.equal(
      rollback.computeUnitsConsumed,
    );
    expect(
      transaction!.meta?.logMessages?.some((line) =>
        line.includes(`Program ${fixture.programId} invoke`),
      ),
    ).to.equal(true);
    expect(
      ownedTokenBalances(transaction!.meta!.postTokenBalances),
    ).to.deep.equal(ownedTokenBalances(transaction!.meta!.preTokenBalances));
  });
});
