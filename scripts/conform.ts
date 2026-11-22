// Dev helper: build a fixture set with both producers and print the differences.
//   node scripts/conform.ts poc [--doc] [--map]

import { buildBoth, jsonDiff } from "../test/helpers.ts"

const set = process.argv[2] ?? "poc"
const { text, descriptor } = buildBoth(set)
const showDoc = process.argv.includes("--doc")
if (showDoc) console.log(JSON.stringify(text.document, null, 2))
console.log(
  "text issues:",
  text.issues.map((i) => `${i.code} @ ${i.pointer ?? i.file}: ${i.message}`),
)
console.log(
  "descriptor issues:",
  descriptor.issues.map((i) => `${i.code} @ ${i.pointer ?? i.file}: ${i.message}`),
)
const d = jsonDiff(text.document, descriptor.document)
console.log(d.length ? `document differs:\n${d.join("\n")}` : "documents equal")
if (JSON.stringify(text.document) === JSON.stringify(descriptor.document)) console.log("byte-identical")
if (process.argv.includes("--map")) {
  const m = jsonDiff(text.sourceMap, descriptor.sourceMap)
  console.log(m.length ? `source map differs:\n${m.join("\n")}` : "source maps equal")
}
