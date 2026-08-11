import { BN } from "@coral-xyz/anchor";
import { swapExactInQuoteAtBin, type Bin } from "@meteora-ag/dlmm";
import { buyQuoteInput } from "@pump-fun/pump-swap-sdk";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("isolated on-chain quote probe parity", () => {
  it("matches Pump SDK 1.19.0 buyQuoteInput rounding", () => {
    const result = buyQuoteInput({
      quote: new BN(5_000_000),
      slippage: 0,
      baseReserve: new BN("800000000000"),
      quoteReserve: new BN("20000000000"),
      virtualQuoteReserves: new BN("1000000000"),
      globalConfig: {
        lpFeeBasisPoints: new BN(20),
        protocolFeeBasisPoints: new BN(5),
        coinCreatorFeeBasisPoints: new BN(5),
      } as never,
      baseMintAccount: { supply: 0n } as never,
      baseMint: PublicKey.default,
      coinCreator: new PublicKey("11111111111111111111111111111112"),
      creator: PublicKey.default,
      feeConfig: null,
    });

    expect(result.base.toString()).to.equal("189861292");
    expect(result.internalQuoteWithoutFees.toString()).to.equal("4985043");
  });

  it("matches Meteora SDK 1.9.14 while crossing two bins", () => {
    const bins = [
      syntheticBin(new BN(1).shln(64), 2_000_000),
      syntheticBin(new BN(1).shln(64).muln(99).divn(100), 10_000_000),
    ];
    const staticParameters = {
      baseFactor: 200,
      baseFeePowerFactor: 0,
      variableFeeControl: 0,
      protocolShare: 0,
    };
    const variableParameters = { volatilityAccumulator: 0 };
    let remaining = new BN(5_000_000);
    let amountOut = new BN(0);
    let fee = new BN(0);

    for (const bin of bins) {
      const quote = swapExactInQuoteAtBin(
        bin,
        10,
        staticParameters as never,
        variableParameters as never,
        remaining,
        true,
        false,
        true,
      );
      remaining = remaining.sub(quote.amountIn);
      amountOut = amountOut.add(quote.amountOut);
      fee = fee.add(quote.fee);
    }

    expect(remaining.toString()).to.equal("0");
    expect(amountOut.toString()).to.equal("4969900");
    expect(fee.toString()).to.equal("101");
  });

  it("matches Meteora reverse direction with fee charged on output", () => {
    const quote = swapExactInQuoteAtBin(
      syntheticBin(new BN(1).shln(64).muln(105).divn(100), 0, 10_000_000),
      10,
      {
        baseFactor: 250,
        baseFeePowerFactor: 0,
        variableFeeControl: 0,
        protocolShare: 1_000,
      } as never,
      { volatilityAccumulator: 0 } as never,
      new BN(3_000_000),
      false,
      false,
      false,
    );

    expect(quote.amountOut.toString()).to.equal("2857070");
    expect(quote.fee.add(quote.protocolFee).toString()).to.equal("72");
  });

  it("matches Meteora dynamic-fee rounding", () => {
    const quote = swapExactInQuoteAtBin(
      syntheticBin(new BN(1).shln(64).muln(101).divn(100), 10_000_000),
      10,
      {
        baseFactor: 200,
        baseFeePowerFactor: 0,
        variableFeeControl: 100,
        protocolShare: 2_500,
      } as never,
      { volatilityAccumulator: 1_000 } as never,
      new BN(5_000_000),
      true,
      false,
      true,
    );

    expect(quote.amountOut.toString()).to.equal("5049897");
    expect(quote.fee.add(quote.protocolFee).toString()).to.equal("101");
  });

  it("matches Meteora processed and open limit-order liquidity", () => {
    const bin = syntheticBin(new BN(1).shln(64), 100);
    bin.openOrderAmount = new BN(100);
    bin.processedOrderRemainingAmount = new BN(100);
    bin.limitOrderAskSide = 0;
    const quote = swapExactInQuoteAtBin(
      bin,
      10,
      {
        baseFactor: 200,
        baseFeePowerFactor: 0,
        variableFeeControl: 0,
        protocolShare: 2_500,
      } as never,
      { volatilityAccumulator: 0 } as never,
      new BN(250),
      true,
      true,
      true,
    );

    expect(quote.amountOut.toString()).to.equal("249");
    expect(quote.fee.add(quote.protocolFee).toString()).to.equal("1");
  });
});

function syntheticBin(price: BN, amountY: number, amountX = 0): Bin {
  return {
    price,
    amountX: new BN(amountX),
    amountY: new BN(amountY),
    openOrderAmount: new BN(0),
    processedOrderRemainingAmount: new BN(0),
    limitOrderAskSide: 0,
  } as Bin;
}
