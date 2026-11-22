// U3 / IN-13: the emission mode `BuildOptions.imports` ("user" by default, "referenced", "all"), the `bundled` marker on files resolved from the bundle, and the header rule for bundled files (design §3.3, §4.3, §5.2, §7, §10).
//
// The catalogue variants per mode are EX-FILE-6.user, EX-FILE-6.public.user (an import public chain), EX-EXT-2.shop.user, EX-E24-1.user (import option) and EX-DIAG-4.local-visibility.user beside their referenced-mode sets.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as core from "../src/core"
import {
  buildFromDescriptorSet,
  buildFromDescriptorSetBinary,
  buildFromProto,
  buildFromProtoAsync,
  bundledFiles,
  printProto,
} from "../src"
import type { BuildOptions, BuildResult, ProtoApiDocument } from "../src"
import { IMAGES, IMPORT_MODES, buildBoth, jsonDiff, loadImage, loadSources, roundTrip } from "./helpers"

const L = (...lines: string[]) => lines.join("\n")
const TS = "google/protobuf/timestamp.proto"
const WRAPPERS = "google/protobuf/wrappers.proto"

/** Both producers give the same document text and source map, and neither reports an issue. */
const conformant = (text: BuildResult, descriptor: BuildResult) => {
  expect(jsonDiff(text.document, descriptor.document)).toEqual([])
  expect(JSON.stringify(text.document)).toBe(JSON.stringify(descriptor.document))
  expect(jsonDiff(text.sourceMap, descriptor.sourceMap)).toEqual([])
  expect([...text.issues, ...descriptor.issues]).toEqual([])
}

/** Every `files` entry marked `bundled` has no header description and ends with the marker (§7 key order). */
const markedWithoutHeader = (doc: ProtoApiDocument): string[] => {
  const marked: string[] = []
  for (const [path, f] of Object.entries(doc.files ?? {})) {
    if (f.bundled === undefined) continue
    expect({ path, bundled: f.bundled, description: f.description }).toEqual({
      path,
      bundled: true,
      description: undefined,
    })
    expect(Object.keys(f).pop()).toBe("bundled")
    marked.push(path)
  }
  return marked
}

const wkt = L(
  'syntax = "proto3";',
  "package a;",
  `import "${TS}";`,
  `import "${WRAPPERS}";`,
  "message M { google.protobuf.Timestamp at = 1; google.protobuf.Int64Value n = 2; }",
)

describe("U3: emission mode", () => {
  test('U3.1: the default is "user"; includeImports is an alias (true = all, false = referenced)', () => {
    const sources = loadSources("poc")
    const json = (o: BuildOptions) => JSON.stringify(buildFromProto(sources, o).document)
    expect(json({})).toBe(json({ imports: "user" }))
    expect(json({ includeImports: true })).toBe(json({ imports: "all" }))
    expect(json({ includeImports: false })).toBe(json({ imports: "referenced" }))
    // the same meaning twice is allowed
    expect(json({ includeImports: true, imports: "all" })).toBe(json({ imports: "all" }))
    expect(json({ includeImports: false, imports: "referenced" })).toBe(json({ imports: "referenced" }))
  })

  test("U3.2: conflicting includeImports / imports and an unknown mode are a TypeError in every builder (decision 15)", async () => {
    const bytes = new Uint8Array(readFileSync(join(IMAGES, "poc.binpb")))
    const set = loadImage("poc")
    const bad: BuildOptions[] = [
      { includeImports: true, imports: "user" },
      { includeImports: true, imports: "referenced" },
      { includeImports: false, imports: "all" },
      { includeImports: false, imports: "user" },
      { imports: "none" as "user" },
    ]
    for (const api of [
      { buildFromProto, buildFromProtoAsync, buildFromDescriptorSet, buildFromDescriptorSetBinary },
      core,
    ]) {
      for (const o of bad) {
        expect(() => api.buildFromProto({}, o)).toThrow(TypeError)
        // the async builders throw synchronously (a programming error, not a failed build)
        expect(() => api.buildFromProtoAsync({}, o)).toThrow(TypeError)
        expect(() => api.buildFromDescriptorSet(set, o)).toThrow(TypeError)
        expect(() => api.buildFromDescriptorSetBinary(bytes, o)).toThrow(TypeError)
      }
    }
    expect(() => buildFromProto({}, { includeImports: true, imports: "user" })).toThrow(
      "buildFromProto: options.imports conflicts with options.includeImports",
    )
  })

  test("U3.3: a user import supplied by the loader is emitted in full (sync and async loader; both producers)", async () => {
    const all = loadSources("poc")
    const sources = { "pet.proto": all["pet.proto"] }
    const loader = (p: string) => all[p]
    const text = buildFromProto(sources, { loader })
    const asyncText = await buildFromProtoAsync(sources, { loader: async (p) => all[p] })
    const descriptor = buildFromDescriptorSet(loadImage("poc"), { entry: ["pet.proto"] })
    conformant(text, descriptor)
    expect(JSON.stringify(asyncText.document)).toBe(JSON.stringify(text.document))
    const doc = text.document
    // shop/ext.proto declares only option extensions nothing references: emitted because it is a user file
    expect(doc.files?.["shop/ext.proto"]).toBeDefined()
    expect(doc.files?.["shop/ext.proto"]?.bundled).toBeUndefined()
    expect(Object.keys(doc.components?.extensions ?? {}).some((k) => k.startsWith("shop.ext."))).toBe(true)
    // the referenced mode keeps only what the entry references (nothing of shop/ext.proto)
    const referenced = buildFromProto(sources, { loader, imports: "referenced" }).document
    expect(referenced.files?.["shop/ext.proto"]).toBeUndefined()
    expect(referenced.components?.extensions).toBeUndefined()
  })

  test("U3.4: a bundled well-known type file contributes the referenced declarations only, marked", () => {
    const doc = buildFromProto({ "a.proto": wkt }).document
    expect(Object.keys(doc.files ?? {})).toEqual([TS, WRAPPERS, "a.proto"])
    expect(markedWithoutHeader(doc)).toEqual([TS, WRAPPERS])
    expect(Object.keys(doc.components?.messages ?? {})).toEqual([
      "google.protobuf.Timestamp",
      "google.protobuf.Int64Value",
      "a.M",
    ])
    // descriptor.proto is resolved for option typing but nothing of it is referenced: not listed
    expect(doc.files?.["google/protobuf/descriptor.proto"]).toBeUndefined()
  })

  test('U3.5: "all" emits bundled files in full and still marks them; "referenced" marks the listed ones', () => {
    const all = buildFromProto({ "a.proto": wkt }, { imports: "all" }).document
    expect(markedWithoutHeader(all)).toEqual([TS, WRAPPERS])
    expect(all.components?.messages?.["google.protobuf.StringValue"]).toBeDefined()
    const referenced = buildFromProto({ "a.proto": wkt }, { imports: "referenced" }).document
    expect(markedWithoutHeader(referenced)).toEqual([TS, WRAPPERS])
    expect(referenced.components?.messages?.["google.protobuf.StringValue"]).toBeUndefined()
  })

  test("U3.6: an entry file with a bundled path is emitted in full, not marked, and keeps its header (both producers)", () => {
    const entry = ["google/protobuf/type.proto"]
    const set = JSON.parse(readFileSync(join(IMAGES, "bundle.json"), "utf8"))
    const text = buildFromProto({}, { entry })
    conformant(text, buildFromDescriptorSet(set, { entry }))
    const doc = text.document
    const f = doc.files?.["google/protobuf/type.proto"]
    expect(f?.bundled).toBeUndefined()
    expect(f?.description).toContain("Copyright")
    expect(doc.components?.messages?.["google.protobuf.Option"]).toBeDefined()
    // its bundled imports are marked and referenced only
    expect(markedWithoutHeader(doc)).toEqual(["google/protobuf/any.proto", "google/protobuf/source_context.proto"])
  })

  test("U3.7: a file supplied in sources under a bundled path is a user file: full, unmarked, with its header", () => {
    const own = L(
      "// My own timestamp.",
      "",
      'syntax = "proto3";',
      "package google.protobuf;",
      "message Timestamp { int64 seconds = 1; }",
      "message Unused {}",
    )
    for (const imports of IMPORT_MODES) {
      const doc = buildFromProto({ [TS]: own, "a.proto": wkt }, { entry: ["a.proto"], imports }).document
      const f = doc.files?.[TS]
      expect({ imports, bundled: f?.bundled, description: f?.description }).toEqual({
        imports,
        bundled: undefined,
        description: "My own timestamp.",
      })
      // full in "user" and "all", referenced only in "referenced"
      expect(doc.components?.messages?.["google.protobuf.Unused"] !== undefined).toBe(imports !== "referenced")
      // the wrappers still come from the bundle
      expect(doc.files?.[WRAPPERS]?.bundled).toBe(true)
    }
    // a loader is never asked for a bundled path (the bundle wins, design §5.2), so it cannot override one
    const asked: string[] = []
    buildFromProto({ "a.proto": wkt }, { loader: (p) => void asked.push(p) })
    expect(asked).toEqual([])
  })

  test("U3.8: the bundle option marks the files it supplies; a path it overrides is still bundled", () => {
    const extra = { "x/common.proto": L('syntax = "proto3";', "package x;", "message Used {}", "message Unused {}") }
    const a = L('syntax = "proto3";', "package a;", 'import "x/common.proto";', "message M { x.Used u = 1; }")
    const doc = buildFromProto({ "a.proto": a }, { bundle: extra }).document
    expect(doc.files?.["x/common.proto"]?.bundled).toBe(true)
    expect(doc.components?.messages?.["x.Unused"]).toBeUndefined()
    // the descriptor producer reads the same bundle in effect
    const image = {
      file: [
        { name: "x/common.proto", package: "x", syntax: "proto3", messageType: [{ name: "Used" }, { name: "Unused" }] },
        {
          name: "a.proto",
          package: "a",
          syntax: "proto3",
          dependency: ["x/common.proto"],
          messageType: [
            {
              name: "M",
              field: [
                {
                  name: "u",
                  number: 1,
                  label: "LABEL_OPTIONAL",
                  type: "TYPE_MESSAGE",
                  typeName: ".x.Used",
                  jsonName: "u",
                },
              ],
            },
          ],
        },
      ],
    }
    const descriptor = buildFromDescriptorSet(image, { entry: ["a.proto"], bundle: extra, sourceMap: false }).document
    expect(descriptor.files?.["x/common.proto"]?.bundled).toBe(true)
    expect(descriptor.components?.messages?.["x.Unused"]).toBeUndefined()
    // without the option the path is no bundle key: a user file, emitted in full
    const user = buildFromDescriptorSet(image, { entry: ["a.proto"], sourceMap: false }).document
    expect(user.files?.["x/common.proto"]?.bundled).toBeUndefined()
    expect(user.components?.messages?.["x.Unused"]).toBeDefined()
  })

  test("U3.9: protoapi/core: a well-known type supplied by the loader is a user file", () => {
    const doc = core.buildFromProto({ "a.proto": wkt }, { loader: (p) => bundledFiles[p] }).document
    expect(doc.files?.[TS]?.bundled).toBeUndefined()
    expect(doc.files?.[TS]?.description).toContain("Copyright")
    expect(doc.components?.messages?.["google.protobuf.StringValue"]).toBeDefined()
  })

  test("U3.10: the marker has no source-map entry; a bundled file keeps the entries of its other keys", () => {
    const { sourceMap, document } = buildFromProto({ "a.proto": wkt })
    const file = `#/files/${TS.replace(/\//g, "~1")}`
    expect(document.files?.[TS]?.bundled).toBe(true)
    expect(sourceMap[`${file}/bundled`]).toBeUndefined()
    expect(sourceMap[`${file}/description`]).toBeUndefined()
    expect(sourceMap[`${file}/package`]).toBeDefined()
  })

  test('U3.11: the printer skips files marked bundled; the "user" round trip rebuilds from the printed files alone', () => {
    for (const imports of IMPORT_MODES) {
      const doc = buildFromProto({ "a.proto": wkt }, { imports }).document
      expect(Object.keys(printProto(doc))).toEqual(["a.proto"])
    }
    const sources = loadSources("binary")
    const r = roundTrip(sources, { entry: ["shop.proto"] })
    expect(Object.keys(r.used).sort()).toEqual(
      ["acme/opts.proto", "pets.proto", "shop.proto"].filter((p) => p in r.printed),
    )
    expect(r.diff).toEqual([])
    expect(r.newIssues).toEqual([])
  })
})

describe("IN-13: bundled files carry no header description", () => {
  test("IN-13.1: both producers, every emission mode, PoC and binary sets", () => {
    for (const set of ["poc", "binary"])
      for (const imports of IMPORT_MODES) {
        const { text, descriptor } = buildBoth(set, { imports })
        conformant(text, descriptor)
        const marked = markedWithoutHeader(text.document)
        // poc references Timestamp; in "all" every bundled import is listed (descriptor.proto at least)
        if (set === "poc" || imports === "all") expect(marked.length).toBeGreaterThan(0)
      }
  })

  test("IN-13.2: user files keep their header; the same file text from the bundle loses it", () => {
    const own = bundledFiles[TS]
    const asSource = buildFromProto({ [TS]: own, "a.proto": wkt }, { entry: ["a.proto"] }).document
    const fromBundle = buildFromProto({ "a.proto": wkt }).document
    expect(asSource.files?.[TS]?.description).toContain("Protocol Buffers")
    expect(fromBundle.files?.[TS]?.description).toBeUndefined()
    // element descriptions of bundled declarations stay
    expect(fromBundle.components?.messages?.["google.protobuf.Timestamp"]?.description).toBeString()
  })

  test("IN-13.3: the binary path agrees", async () => {
    const bytes = new Uint8Array(readFileSync(join(IMAGES, "poc.binpb")))
    for (const imports of IMPORT_MODES) {
      const r = await buildFromDescriptorSetBinary(bytes, { imports })
      expect(JSON.stringify(r.document)).toBe(
        JSON.stringify(buildFromDescriptorSet(loadImage("poc"), { imports }).document),
      )
      markedWithoutHeader(r.document)
    }
  })
})
