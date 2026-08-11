import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type FixtureAccount = {
  address: string;
  owner: string;
  dataBase64: string;
};

const fixturePath = resolve(
  process.env.QUOTE_PARITY_FIXTURE ??
    "tests/fixtures/quote-parity-mainnet.json",
);
const outputDirectory = resolve("target/quote-probe-accounts");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  accounts: FixtureAccount[];
};

mkdirSync(outputDirectory, { recursive: true });
for (const account of fixture.accounts) {
  if (account.address.startsWith("Sysvar")) continue;
  writeFileSync(
    resolve(outputDirectory, `${account.address}.json`),
    `${JSON.stringify({
      pubkey: account.address,
      account: {
        lamports: 1_000_000_000,
        data: [account.dataBase64, "base64"],
        owner: account.owner,
        executable: false,
        rentEpoch: 0,
      },
    })}\n`,
  );
}
