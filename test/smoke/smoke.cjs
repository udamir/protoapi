// Smoke test of the built CommonJS bundles: node test/smoke/smoke.cjs (after `pnpm build`).
// Both entries are loaded through the package's own `exports` map (self-reference by name).
const assert = require("node:assert")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const full = require("protoapi")
const core = require("protoapi/core")

const shop = {
  "shop.proto":
    'syntax = "proto3"; package shop.v1; import "google/protobuf/timestamp.proto"; message Pet { google.protobuf.Timestamp at = 1; }',
}

// protoapi: the bundled well-known types resolve
const a = full.buildFromProto(shop)
assert.deepStrictEqual(a.issues, [])
assert.ok(a.document.components.messages["google.protobuf.Timestamp"])
assert.ok(full.printProto(a.document)["shop.proto"].includes("message Pet"))
assert.ok(Object.keys(full.bundledFiles).length >= 47)

// protoapi/core: only descriptor.proto and the language feature files; other imports must be supplied
assert.deepStrictEqual(Object.keys(core.bundledFiles).sort(), [
  "google/protobuf/cpp_features.proto",
  "google/protobuf/descriptor.proto",
  "google/protobuf/go_features.proto",
  "google/protobuf/java_features.proto",
])
const b = core.buildFromProto(shop)
assert.deepStrictEqual(
  b.issues.map((i) => i.code),
  ["missing-import", "unresolved-type"],
)
const c = core.buildFromProto(shop, { bundle: { ...full.bundledFiles } })
assert.deepStrictEqual(c.issues, [])
assert.strictEqual(JSON.stringify(c.document), JSON.stringify(a.document))
// edition defaults are built in, also without descriptor.proto
const e = core.buildFromProto({ "e.proto": 'edition = "2026"; package e; message M { string s = 1; }' })
assert.deepStrictEqual(e.issues, [])
assert.strictEqual(e.document.components.messages["e.M"].properties.s.presence, "explicit")
// the same API through createProtoApi
const api = core.createProtoApi(full.bundledFiles)
assert.strictEqual(JSON.stringify(api.buildFromProto(shop).document), JSON.stringify(a.document))

// built-in options are typed in core without anything supplied
const o = core.buildFromProto({
  "o.proto": 'syntax = "proto3"; package o; message M { string s = 1 [deprecated = true]; }',
})
assert.deepStrictEqual(o.issues, [])
assert.deepStrictEqual(o.document.components.messages["o.M"].properties.s.deprecation, {})

// the core bundle embeds descriptor.proto but not the convention sources
const coreText = readFileSync(join(__dirname, "..", "..", "dist", "core.cjs"), "utf8")
assert.ok(coreText.includes("message FileDescriptorProto"), "dist/core.cjs lacks descriptor.proto")
assert.ok(!coreText.includes("package buf.validate"), "dist/core.cjs embeds protovalidate")
assert.ok(!coreText.includes("message Timestamp"), "dist/core.cjs embeds timestamp.proto")
assert.ok(readFileSync(join(__dirname, "..", "..", "dist", "index.cjs"), "utf8").includes("package buf.validate"))
console.log("cjs ok (protoapi, protoapi/core)")
