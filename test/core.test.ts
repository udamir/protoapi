// PK-1: `protoapi/core` has the API of `protoapi` without the bundled convention sources; the full bundle is injected
// by the default entry (src/index.ts) and never imported from the core entry. Core keeps descriptor.proto and the
// language feature files (design §17 item 4, "registry always included").

import { describe, expect, test } from "vite-plus/test"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import * as core from "../src/core.ts"
import * as full from "../src/index.ts"
import { ROOT, loadImage, loadSources } from "./helpers.ts"

/** Relative imports reachable from a source file (static `import … from "./x"`). */
const importGraph = (entry: string): Set<string> => {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/^(?:import|export)\s[^"']*?from\s+["'](\.[^"']+)["']/gm)) {
      visit(resolve(dirname(file), m[1]))
    }
  }
  visit(entry)
  return seen
}

describe("PK-1: protoapi/core", () => {
  test("the core entry does not import src/bundle/sources.ts; the default entry does", () => {
    const sources = join(ROOT, "src", "bundle", "sources.ts")
    const coreGraph = importGraph(join(ROOT, "src", "core.ts"))
    expect(coreGraph.size).toBeGreaterThan(10)
    expect(coreGraph.has(sources)).toBe(false)
    expect(importGraph(join(ROOT, "src", "index.ts")).has(sources)).toBe(true)
  })

  test("the same exports", () => {
    expect(Object.keys(core).sort()).toEqual(Object.keys(full).sort())
    expect(Object.keys(core.bundledFiles).sort()).toEqual([
      "google/protobuf/cpp_features.proto",
      "google/protobuf/descriptor.proto",
      "google/protobuf/go_features.proto",
      "google/protobuf/java_features.proto",
    ])
    for (const [path, text] of Object.entries(core.bundledFiles)) expect(text).toBe(full.bundledFiles[path])
    expect(importGraph(join(ROOT, "src", "core.ts")).has(join(ROOT, "src", "bundle", "core-sources.ts"))).toBe(true)
  })

  test("without the bundle, imports of bundled files are missing; the `bundle` option or createProtoApi supplies them", () => {
    const sources = loadSources("binary")
    const missing = core.buildFromProto(sources)
    expect(missing.issues.filter((i) => i.code === "missing-import").map((i) => i.message)).toEqual([
      'import "buf/validate/validate.proto" not found',
      'import "google/api/annotations.proto" not found',
      'import "google/api/field_behavior.proto" not found',
    ])
    const expected = JSON.stringify(full.buildFromProto(sources).document)
    expect(JSON.stringify(core.buildFromProto(sources, { bundle: { ...full.bundledFiles } }).document)).toBe(expected)
    const api = core.createProtoApi(full.bundledFiles)
    expect(JSON.stringify(api.buildFromProto(sources).document)).toBe(expected)
    expect(api.printProto(full.buildFromProto(sources).document)).toEqual(
      full.printProto(full.buildFromProto(sources).document),
    )
  })

  test("a complete descriptor set needs no bundle", async () => {
    const image = loadImage("binary")
    const unmarked = (d: unknown) => JSON.stringify(d, (k, v) => (k === "bundled" ? undefined : v))
    // the referenced mode does not depend on where a file came from: the same declarations, only the markers differ
    const referenced = { imports: "referenced" } as const
    const coreReferenced = core.buildFromDescriptorSet(image, referenced)
    expect(coreReferenced.issues).toEqual([])
    expect(JSON.stringify(coreReferenced.document)).toBe(
      unmarked(full.buildFromDescriptorSet(image, referenced).document),
    )
    // U3: the bundle in effect decides which set files are bundled; with the same bundle the documents are equal
    expect(JSON.stringify(core.buildFromDescriptorSet(image, { bundle: { ...full.bundledFiles } }).document)).toBe(
      JSON.stringify(full.buildFromDescriptorSet(image).document),
    )
    const bytes = new Uint8Array(readFileSync(join(ROOT, "test", "images", "binary.binpb")))
    const r = await core.buildFromDescriptorSetBinary(bytes)
    expect(r.issues).toEqual([])
    expect(JSON.stringify(r.document)).toBe(JSON.stringify(core.buildFromDescriptorSet(image).document))
  })

  test("U3: outside its bundle, protoapi/core treats a set file under a bundled path as a user file", () => {
    const image = loadImage("binary")
    const fromCore = core.buildFromDescriptorSet(image).document
    const fromFull = full.buildFromDescriptorSet(image).document
    // descriptor.proto is in both bundles: marked by both, not emitted in full by either
    for (const d of [fromCore, fromFull])
      expect(d.components?.messages?.["google.protobuf.FileOptions"]).toBeUndefined()
    // protovalidate is bundled only by `protoapi`: core emits the file in full and does not mark it
    expect(fromCore.files?.["buf/validate/validate.proto"]?.bundled).toBeUndefined()
    expect(fromCore.files?.["buf/validate/validate.proto"]?.description).toBeTypeOf("string")
    expect(fromCore.components?.messages?.["buf.validate.FieldRules"]).toBeDefined()
    expect(fromFull.files?.["buf/validate/validate.proto"]).toBeUndefined()
    expect(fromFull.components?.messages?.["buf.validate.FieldRules"]).toBeUndefined()
  })

  test("edition defaults are built in (no descriptor.proto at all)", () => {
    const r = core.buildFromProto({
      "a.proto": `edition = "2023";\npackage p;\nenum E { A = 0; }\nmessage M { string s = 1; repeated int32 r = 2; E e = 3; }\n`,
    })
    expect(r.issues).toEqual([])
    expect(JSON.stringify(r.document)).toBe(
      JSON.stringify(
        full.buildFromProto({
          "a.proto": `edition = "2023";\npackage p;\nenum E { A = 0; }\nmessage M { string s = 1; repeated int32 r = 2; E e = 3; }\n`,
        }).document,
      ),
    )
  })

  test("built-in options and features (including pb.cpp / pb.java / pb.go) are typed without anything supplied", () => {
    const sources = {
      "a.proto": `edition = "2023";
package p;
import "google/protobuf/go_features.proto";
import "google/protobuf/cpp_features.proto";
option java_package = "com.example";
option features.(pb.go).api_level = API_OPAQUE;
message M {
  option deprecated = true;
  string s = 1 [json_name = "S", features.(pb.cpp).string_type = CORD, features.utf8_validation = NONE];
}
`,
    }
    const r = core.buildFromProto(sources)
    expect(r.issues).toEqual([])
    expect(JSON.stringify(r.document)).toBe(JSON.stringify(full.buildFromProto(sources).document))
    expect(r.document.files?.["a.proto"]?.options).toEqual({
      java_package: "com.example",
      features: { "pb.go": { api_level: "API_OPAQUE" } },
    })
  })
})
