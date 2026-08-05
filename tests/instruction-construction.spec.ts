import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";

const idl = JSON.parse(
  readFileSync(resolve("target/idl/sol_arb_executor.json"), "utf8"),
) as Idl;
const payer = Keypair.generate();
const provider = new AnchorProvider(
  new Connection("http://127.0.0.1:8899", "processed"),
  new Wallet(payer),
  { commitment: "processed" },
);
const program = new Program(idl, provider);

function randomAccounts(): Record<string, PublicKey> {
  const names = [
    "trader",
    "wsolMint",
    "targetMint",
    "userWsol",
    "userTarget",
    "tokenProgram",
    "systemProgram",
    "associatedTokenProgram",
    "pumpProgram",
    "pumpPool",
    "pumpGlobalConfig",
    "pumpPoolBaseTokenAccount",
    "pumpPoolQuoteTokenAccount",
    "pumpProtocolFeeRecipient",
    "pumpProtocolFeeRecipientTokenAccount",
    "pumpEventAuthority",
    "pumpCoinCreatorVaultAta",
    "pumpCoinCreatorVaultAuthority",
    "pumpGlobalVolumeAccumulator",
    "pumpUserVolumeAccumulator",
    "pumpFeeConfig",
    "pumpFeeProgram",
    "pumpPoolV2",
    "pumpBuybackFeeRecipient",
    "pumpBuybackFeeRecipientTokenAccount",
    "meteoraProgram",
    "meteoraLbPair",
    "meteoraBinArrayBitmapExtension",
    "meteoraReserveX",
    "meteoraReserveY",
    "meteoraOracle",
    "meteoraHostFeeIn",
    "memoProgram",
    "meteoraEventAuthority",
  ];
  return Object.fromEntries(
    names.map((name) => [name, Keypair.generate().publicKey]),
  );
}

describe("route instruction construction", () => {
  it("constructs Pump -> Meteora with ordered bin arrays", async () => {
    const binArrays = [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ];
    const ix = await program.methods
      .executePumpToMeteora({
        pumpSpendableWsolIn: new BN(1_000),
        pumpMinTargetOut: new BN(900),
        meteoraMinWsolOut: new BN(950),
      })
      .accounts(randomAccounts())
      .remainingAccounts(
        binArrays.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction();

    expect(ix.data.length).to.be.greaterThan(8);
    expect(
      ix.keys.slice(-2).map((meta) => meta.pubkey.toBase58()),
    ).to.deep.equal(binArrays.map((key) => key.toBase58()));
    expect(
      ix.keys.slice(-2).every((meta) => meta.isWritable && !meta.isSigner),
    ).to.equal(true);
  });

  it("constructs Meteora -> Pump and serializes three u64 parameters", async () => {
    const ix = await program.methods
      .executeMeteoraToPump({
        meteoraWsolIn: new BN(2_000),
        meteoraMinTargetOut: new BN(1_800),
        pumpMinWsolOut: new BN(1_900),
      })
      .accounts(randomAccounts())
      .remainingAccounts([
        {
          pubkey: Keypair.generate().publicKey,
          isSigner: false,
          isWritable: true,
        },
      ])
      .instruction();

    expect(ix.data.length).to.equal(8 + 8 * 3);
  });
});
