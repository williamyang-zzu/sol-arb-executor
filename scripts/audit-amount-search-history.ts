// Read-only audit of an already stopped Monitor database; never loads runtime config.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: ts-node scripts/audit-amount-search-history.ts <stopped-monitor.sqlite3>",
  );
const uri = `file:${encodeURI(resolve(path)).replace(/\?/g, "%3F").replace(/#/g, "%23")}?immutable=1`;
function query(sql: string) {
  return JSON.parse(
    execFileSync("sqlite3", ["-json", uri, sql], { encoding: "utf8" }) || "[]",
  );
}
const successes =
  query(`SELECT signature,target_mint,pump_pool,meteora_pool,landed_slot,
  transaction_index,gross_wsol_delta_lamports,compute_units,fee_lamports
  FROM attempts WHERE gross_wsol_delta_lamports > 0 ORDER BY landed_slot,transaction_index`);
const columns = query("PRAGMA table_info(events)").map(
  (row: { name: string }) => row.name,
);
const totals =
  query(`SELECT count(*) as attempts, sum(fee_lamports) as total_fee_lamports,
  sum(COALESCE(gross_wsol_delta_lamports,0)) as gross_profit_lamports FROM attempts`);
const report = {
  source: "stopped Monitor database; transaction metadata only",
  totals,
  successes,
  eventColumns: columns,
  historicalCounterfactualReady: false,
  missing: [
    "transaction-boundary pre-execution account bytes",
    "all required DLMM BinArrays and bitmap state",
    "historical fee configuration and Clock state",
  ],
  caveat:
    "This schema audit does not prove external archives are unavailable. Current account RPC reads or an unrelated fixture cannot replace historical prestates.",
};
mkdirSync("target/amount-search", { recursive: true });
writeFileSync(
  "target/amount-search/history-audit.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    totals,
    successCount: successes.length,
    historicalCounterfactualReady: false,
  }),
);
