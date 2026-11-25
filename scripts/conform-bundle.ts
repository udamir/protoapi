// Dev helper: conformance of both producers on every bundled file (a real-world corpus).
//   node scripts/conform-bundle.ts [--map]   (the image is written by `pnpm images bundle`)

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildFromDescriptorSet, buildFromProto, bundledFiles } from "../src/index.ts"
import { jsonDiff } from "../test/helpers.ts"

const ROOT = join(import.meta.dirname, "..")
const image = join(ROOT, "test", "images", "bundle.json")
if (!existsSync(image)) throw new Error("test/images/bundle.json is missing: run `pnpm images bundle`")
const set = JSON.parse(readFileSync(image, "utf8"))
const sources = { ...bundledFiles }
const opts = { includeImports: true }
const t0 = performance.now()
const text = buildFromProto(sources, opts)
const t1 = performance.now()
const desc = buildFromDescriptorSet(set, opts)
const t2 = performance.now()
console.log(`text ${(t1 - t0).toFixed(0)} ms, descriptor ${(t2 - t1).toFixed(0)} ms`)
console.log(
  "text issues",
  text.issues.length,
  text.issues.slice(0, 10).map((i) => `${i.code} ${i.pointer} ${i.message}`),
)
console.log(
  "descriptor issues",
  desc.issues.length,
  desc.issues.slice(0, 10).map((i) => `${i.code} ${i.pointer} ${i.message}`),
)
const d = jsonDiff(text.document, desc.document, "", [], 60)
console.log(d.length ? `document differs:\n${d.join("\n")}` : "documents equal")
console.log("byte-identical:", JSON.stringify(text.document) === JSON.stringify(desc.document))
if (process.argv.includes("--map")) {
  const m = jsonDiff(text.sourceMap, desc.sourceMap, "", [], 40)
  console.log(m.length ? `source map differs:\n${m.join("\n")}` : "source maps equal")
}
