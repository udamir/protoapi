// Smoke test of the built ESM bundles: node test/dist/smoke.mjs (after `bun run build`).
// Both entries are loaded through the package's own `exports` map (self-reference by name); `browser` points at the
// ESM build.
import assert from "node:assert"
import { readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import * as full from "protoapi"
import * as core from "protoapi/core"

const read = (p) => readFileSync(new URL(p, import.meta.url))
const pkg = JSON.parse(read("../../package.json"))
assert.strictEqual(pkg.browser, "./dist/index.mjs")
assert.ok(read(`../../${pkg.unpkg}`).length > 0)

const json = JSON.parse(read("../images/poc.json"))
const bytes = new Uint8Array(read("../images/poc.binpb"))
for (const [name, api] of [
  ["protoapi", full],
  ["protoapi/core", core],
]) {
  // a complete buf image needs no bundle; without `entry`, bufExtension.isImport is read from the binary image
  const a = api.buildFromDescriptorSet(json)
  const b = await api.buildFromDescriptorSetBinary(bytes)
  assert.deepStrictEqual(b.issues, [], name)
  assert.strictEqual(JSON.stringify(a.document), JSON.stringify(b.document), name)
}

// custom options (google.api, protovalidate, a set-defined extension) decode through the per-file registry
const image = new Uint8Array(read("../images/binary.binpb"))
const fromFull = await full.buildFromDescriptorSetBinary(image)
assert.deepStrictEqual(fromFull.issues, [])
const getPet = fromFull.document.components.messages["shop.v1.GetPetRequest"]
assert.strictEqual(getPet.properties.name.required, true)
assert.strictEqual(getPet.required, undefined)

// §12 budgets the code without bundled sources at 60 KB gzip (phase B: 49 KB). The core file also carries
// descriptor.proto and the feature files (about 18 KB gzip): 57 KB after phase A, 67 KB after phase B (definition
// checks, validate.ts). The cap below is raised from 60 KB to 70 KB; flagged for review in the validation report.
// Phase C (annotation fixes, Any / Struct values, resolved features): code 53 KB gzip, the core file 71.5 KB; the cap is
// raised to 75 KB, again flagged for review (the §12 budget of 60 KB for code holds).
// Phase D (printer, source map, API checks): code 59.9 KB, the core file 78.2 KB; the cap is raised to 80 KB, approved by
// the user on 2026-11-17. The real budget is the code-only 60 KB asserted in PB-9.8.
const coreSize = gzipSync(read("../../browser/protoapi-core.min.js")).length
assert.ok(coreSize < 80 * 1024, `protoapi-core.min.js is ${coreSize} bytes gzip`)
assert.ok(!read("../../dist/core.mjs").toString().includes("package buf.validate"))
console.log(`esm ok (protoapi, protoapi/core; core ${(coreSize / 1024).toFixed(1)} KB gzip)`)
