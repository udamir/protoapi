// Dev helper: printer round trip build(print(build(x))) == build(x) (PB-7), with the PB-7 harness of test/helpers.ts.
//   bun scripts/roundtrip.ts poc | bundle | <fixture set> [--include-imports] [--print <file>]

import { bundledFiles } from "../src"
import { loadSources, roundTrip } from "../test/helpers"

const set = process.argv[2] ?? "poc"
const sources = set === "bundle" ? { ...bundledFiles } : loadSources(set)
const r = roundTrip(sources, { includeImports: set === "bundle" || process.argv.includes("--include-imports") })
const show = process.argv.indexOf("--print")
if (show > 0) console.log(r.printed[process.argv[show + 1]])
console.log(
  "new issues after print:",
  r.newIssues.slice(0, 15).map((i) => `${i.code} ${i.pointer ?? i.file} ${i.message}`),
)
console.log(r.diff.length ? `round trip differs:\n${r.diff.join("\n")}` : "round trip equal")
