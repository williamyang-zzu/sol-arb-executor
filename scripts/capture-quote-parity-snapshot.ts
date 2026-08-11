import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BN } from "@coral-xyz/anchor";
import { PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID } from "@pump-fun/pump-sdk";
import {
  GLOBAL_CONFIG_PDA,
  OnlinePumpAmmSdk,
  buyQuoteInput,
  sellBaseInput,
} from "@pump-fun/pump-swap-sdk";
import { Surfnet } from "@solana/surfpool";
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

const targetMint = new PublicKey(required("TARGET_MINT"));
const pumpPool = new PublicKey(required("PUMP_POOL"));
const meteoraPool = new PublicKey(required("METEORA_POOL"));
const inputLamports = new BN(required("WSOL_AMOUNT_IN"));
const outputPath = resolve(
  process.env.QUOTE_PARITY_FIXTURE ??
    "tests/fixtures/quote-parity-mainnet.json",
);
const remoteRpcUrl =
  process.env.SURFPOOL_MAINNET_RPC_URL ?? required("RPC_URL");

type SnapshotAccount = {
  address: string;
  owner: string;
  dataBase64: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const surfnet = Surfnet.startWithConfig({
    remoteRpcUrl,
    blockProductionMode: "transaction",
  });
  try {
    const connection = new Connection(surfnet.rpcUrl, "processed");
    const pump = new OnlinePumpAmmSdk(connection);
    // Public keys are sufficient: swapSolanaState only reads pool state.
    const placeholder = PublicKey.default;
    const pumpState = await pump.swapSolanaState(
      pumpPool,
      placeholder,
      placeholder,
      placeholder,
    );
    if (!pumpState.baseMint.equals(targetMint)) {
      throw new Error("Pump pool target mint mismatch");
    }

    const dlmm = await DLMM.create(connection, meteoraPool);
    if (!dlmm.lbPair.tokenXMint.equals(targetMint)) {
      throw new Error("DLMM token X must be the target mint for this fixture");
    }
    const forwardArrays = await dlmm.getBinArrayForSwap(true, 20);
    const reverseArrays = await dlmm.getBinArrayForSwap(false, 20);

    // Freeze the SDK wall clock so its volatility-reference update and all
    // expected values refer to one reproducible instant.
    const quoteTimestampMs = Date.now();
    const originalNow = Date.now;
    Date.now = () => quoteTimestampMs;
    let pumpBuy;
    let forwardDlmm;
    let reverseDlmm;
    let pumpSell;
    try {
      pumpBuy = buyQuoteInput({
        quote: inputLamports,
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
      forwardDlmm = dlmm.swapQuote(
        pumpBuy.base,
        true,
        new BN(0),
        forwardArrays,
        true,
      );
      reverseDlmm = dlmm.swapQuote(
        inputLamports,
        false,
        new BN(0),
        reverseArrays,
        true,
      );
      pumpSell = sellBaseInput({
        base: reverseDlmm.outAmount,
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
    } finally {
      Date.now = originalNow;
    }

    const feeConfigAddress = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), PUMP_AMM_PROGRAM_ID.toBuffer()],
      PUMP_FEE_PROGRAM_ID,
    )[0];
    const arrayAddresses = [
      ...new Map(
        [...forwardDlmm.binArraysPubkey, ...reverseDlmm.binArraysPubkey].map(
          (publicKey) => [publicKey.toBase58(), publicKey],
        ),
      ).values(),
    ];
    const addresses = [
      pumpPool,
      GLOBAL_CONFIG_PDA,
      feeConfigAddress,
      targetMint,
      pumpState.pool.poolBaseTokenAccount,
      pumpState.pool.poolQuoteTokenAccount,
      meteoraPool,
      SYSVAR_CLOCK_PUBKEY,
      ...arrayAddresses,
    ];
    const response = await connection.getMultipleAccountsInfoAndContext(
      addresses,
      "processed",
    );
    const accounts: SnapshotAccount[] = response.value.map((account, index) => {
      if (!account)
        throw new Error(`Missing cloned account ${addresses[index]}`);
      return {
        address: addresses[index].toBase58(),
        owner: account.owner.toBase58(),
        dataBase64: account.data.toString("base64"),
      };
    });

    const fixture = {
      schemaVersion: 1,
      source: "Surfpool clone of public Solana mainnet accounts",
      capturedSlot: response.context.slot,
      quoteTimestampMs,
      addresses: {
        targetMint: targetMint.toBase58(),
        pumpPool: pumpPool.toBase58(),
        pumpGlobalConfig: GLOBAL_CONFIG_PDA.toBase58(),
        pumpFeeConfig: feeConfigAddress.toBase58(),
        pumpBaseVault: pumpState.pool.poolBaseTokenAccount.toBase58(),
        pumpQuoteVault: pumpState.pool.poolQuoteTokenAccount.toBase58(),
        meteoraPool: meteoraPool.toBase58(),
        forwardBinArrays: forwardDlmm.binArraysPubkey.map(String),
        reverseBinArrays: reverseDlmm.binArraysPubkey.map(String),
      },
      inputLamports: inputLamports.toString(),
      expected: {
        pumpBuyTargetOut: pumpBuy.base.toString(),
        pumpBuyInternalQuote: pumpBuy.internalQuoteWithoutFees.toString(),
        forwardDlmmWsolOut: forwardDlmm.outAmount.toString(),
        reverseDlmmTargetOut: reverseDlmm.outAmount.toString(),
        pumpSellWsolOut: pumpSell.uiQuote.toString(),
      },
      accounts,
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(
      JSON.stringify({
        outputPath,
        capturedSlot: response.context.slot,
        accountCount: accounts.length,
        expected: fixture.expected,
      }),
    );
  } finally {
    surfnet.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
