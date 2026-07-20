// Esegue le batterie in sequenza (mai in parallelo: fixture, log e pool
// condivisi). Uso: node tests/run-all.mjs [filtro-nel-nome]
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";
const suites = readdirSync(dir)
  .filter((f) => /^test-.*\.mjs$/.test(f) && f.includes(filter))
  .sort();

const failed = [];
for (const [i, suite] of suites.entries()) {
  process.stdout.write(`[${i + 1}/${suites.length}] ${suite} ... `);
  const res = spawnSync(process.execPath, [path.join(dir, suite)], { encoding: "utf8", timeout: 15 * 60 * 1000 });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const tot = out.match(/TOT: \d+\/\d+ PASS|=+ \d+ PASS \/ \d+ FAIL =+/)?.[0] ?? "";
  if (res.status === 0) {
    console.log(`OK ${tot}`);
  } else {
    console.log(`FAIL ${tot}`);
    failed.push(suite);
    console.log(out.split("\n").filter((l) => l.includes("FAIL") || l.includes("ERRORE")).slice(0, 6).join("\n"));
  }
}
console.log(`\n${suites.length - failed.length}/${suites.length} suite verdi${failed.length ? `\nFallite:\n${failed.join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
