import { expect } from "chai";
import { formatSol, parseArgs } from "../scripts/wrap-sol";

describe("wrap-sol utility", () => {
  it("parses a preview request without enabling execution", () => {
    expect(
      parseArgs([
        "--amount-lamports",
        "240000000",
        "--wallet",
        "/secure/trader.json",
      ]),
    ).to.deep.equal({
      amountLamports: 240000000n,
      execute: false,
      help: false,
      walletPath: "/secure/trader.json",
    });
  });

  it("requires an explicit execution flag", () => {
    expect(
      parseArgs(["--amount-lamports", "240000000", "--execute"]).execute,
    ).to.equal(true);
  });

  it("rejects zero, fractional, unsafe, and missing amounts", () => {
    for (const value of ["0", "-1", "0.24", "9007199254740992"]) {
      expect(() => parseArgs(["--amount-lamports", value])).to.throw();
    }
    expect(() => parseArgs([])).to.throw("--amount-lamports is required");
  });

  it("formats lamports without floating-point conversion", () => {
    expect(formatSol(240000000n)).to.equal("0.24");
    expect(formatSol(1000000001n)).to.equal("1.000000001");
    expect(formatSol(12000000n)).to.equal("0.012");
  });
});
