// Binary FileDescriptorSet input through the optional @bufbuild/protobuf decoder (design D11).

import { describe, expect, test } from "vite-plus/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as pb from "@bufbuild/protobuf"
import * as wkt from "@bufbuild/protobuf/wkt"
import { buildFromDescriptorSet, buildFromDescriptorSetBinary, buildFromProto } from "../src/index.ts"
import { createBuilders } from "../src/build.ts"
import { bundledSources } from "../src/bundle/sources.ts"
import { BUFBUILD_MINIMUM, loadBufbuild, readBufExtension } from "../src/binary.ts"
import { IMAGES, jsonDiff, loadImage, loadSources } from "./helpers.ts"

const readBinary = (name: string) => new Uint8Array(readFileSync(join(IMAGES, `${name}.binpb`)))
const decode = (bytes: Uint8Array) => pb.fromBinary(wkt.FileDescriptorSetSchema, bytes)
const encode = (files: wkt.FileDescriptorProto[]) =>
  pb.toBinary(wkt.FileDescriptorSetSchema, pb.create(wkt.FileDescriptorSetSchema, { file: files }))
const isImport = (fd: wkt.FileDescriptorProto) =>
  readBufExtension((fd as { $unknown?: never }).$unknown)?.isImport === true
const codes = (issues: { code: string; message: string }[]) => issues.map((i) => `${i.code}: ${i.message}`)

describe("binary descriptor sets", () => {
  const json = loadImage("poc")
  const entry = json.file
    .filter((f) => !(f.bufExtension as { isImport?: boolean } | undefined)?.isImport)
    .map((f) => String(f.name))
  const bytes = readBinary("poc")

  test("decodes with @bufbuild/protobuf and equals the ProtoJSON build", async () => {
    const fromJson = buildFromDescriptorSet(json, { entry })
    const fromBinary = await buildFromDescriptorSetBinary(bytes, { entry })
    expect(fromBinary.issues).toEqual([])
    expect(jsonDiff(fromJson.document, fromBinary.document)).toEqual([])
    expect(jsonDiff(fromJson.sourceMap, fromBinary.sourceMap)).toEqual([])
  })

  test("a caller-supplied decoder is used", async () => {
    const result = await buildFromDescriptorSetBinary(bytes, { entry, decoder: () => json })
    expect(result.document).toEqual(buildFromDescriptorSet(json, { entry }).document)
  })

  test("decoder failure is an issue, not an exception", async () => {
    const result = await buildFromDescriptorSetBinary(bytes, {
      decoder: () => {
        throw new Error("boom")
      },
    })
    expect(result.issues.map((i) => i.code)).toEqual(["unsupported"])
    expect(result.document).toEqual({ protoapi: "0.1" })
  })
})

describe("C-3: buf_extension in binary buf images", () => {
  for (const set of ["poc", "binary"]) {
    test(`${set}: without \`entry\`, the binary image gives the document of the JSON image`, async () => {
      const fromJson = buildFromDescriptorSet(loadImage(set))
      const fromBinary = await buildFromDescriptorSetBinary(readBinary(set))
      expect(fromBinary.issues).toEqual(fromJson.issues)
      expect(JSON.stringify(fromBinary.document)).toBe(JSON.stringify(fromJson.document))
      expect(jsonDiff(fromJson.sourceMap, fromBinary.sourceMap)).toEqual([])
    })
  }

  test("isImport, isSyntaxUnspecified and unusedDependency are read from field 8042", () => {
    const files = decode(readBinary("binary")).file
    const ext = Object.fromEntries(files.map((f) => [f.name, readBufExtension((f as { $unknown?: never }).$unknown)]))
    expect(ext["shop.proto"]).toEqual({ isImport: false, isSyntaxUnspecified: false })
    expect(ext["google/protobuf/descriptor.proto"]?.isImport).toBe(true)
    const json = loadImage("binary").file.find((f) => f.name === "shop.proto")?.bufExtension
    expect(json).toEqual(ext["shop.proto"] as Record<string, unknown>)
  })
})

describe("C-2: registry from the set plus the bundle, per file", () => {
  const full = readBinary("binary")
  const text = buildFromProto(loadSources("binary"))
  const thinFiles = decode(full).file.filter((f) => !isImport(f))

  test("the fixture builds the same from text and from the JSON image", () => {
    expect(text.issues).toEqual([])
    expect(JSON.stringify(buildFromDescriptorSet(loadImage("binary")).document)).toBe(JSON.stringify(text.document))
  })

  test("a thin set (no imported files, protoc without --include_imports) keeps http, field_behavior and protovalidate", async () => {
    expect(thinFiles.map((f) => f.name).sort()).toEqual(["acme/opts.proto", "pets.proto", "shop.proto"])
    const r = await buildFromDescriptorSetBinary(encode(thinFiles))
    expect(codes(r.issues)).toEqual([])
    expect(JSON.stringify(r.document)).toBe(JSON.stringify(text.document))
    const req = r.document.components?.messages?.["shop.v1.GetPetRequest"]
    expect(req?.properties.name.required).toBe(true)
    expect(req?.properties.name).toMatchObject({ minLength: 3 })
    expect(r.document.services?.["shop.v1.PetService"]?.methods.GetPet.http).toEqual({
      method: "GET",
      path: "/v1/{name=pets/*}",
    })
  })

  test("an option whose definition is nowhere is an unknown-option issue; the other options survive", async () => {
    const r = await buildFromDescriptorSetBinary(encode(thinFiles.filter((f) => f.name !== "acme/opts.proto")))
    expect(codes(r.issues)).toEqual([
      "unknown-option: option field number 50001 of google.protobuf.FieldOptions in pets.proto cannot be decoded: no extension definition in the set or the bundle; the value is dropped",
      "unknown-option: option field number 50001 of google.protobuf.FieldOptions in shop.proto cannot be decoded: no extension definition in the set or the bundle; the value is dropped",
    ])
    expect(r.document.components?.messages?.["shop.v1.Pet"]?.properties.name.options).toBeUndefined()
    expect(r.document.components?.messages?.["shop.v1.GetPetRequest"]?.properties.name.required).toBe(true)
  })

  test("one file with an edition the decoder does not know does not drop the options of the others", async () => {
    // pets.proto with edition 1003 (a future edition): patch the varint of FileDescriptorProto.edition (field 14)
    const pets = encode(thinFiles.filter((f) => f.name === "pets.proto"))
    // the last match: SourceCodeInfo (field 9) is written before edition (field 14)
    let at = -1
    for (let i = 0; i + 2 < pets.length; i++)
      if (pets[i] === 0x70 && pets[i + 1] === 0xe9 && pets[i + 2] === 0x07) at = i
    expect(at).toBeGreaterThan(0)
    pets[at + 1] = 0xeb // 1001 -> 1003
    const others = encode(thinFiles.filter((f) => f.name !== "pets.proto"))
    const r = await buildFromDescriptorSetBinary(new Uint8Array([...others, ...pets]))
    expect(codes(r.issues)).toEqual([
      "unsupported: the definitions in pets.proto cannot be loaded into the @bufbuild/protobuf registry (edition 1003 is newer than the installed @bufbuild/protobuf supports (up to edition 2026)); options that use them are not decoded",
      "unsupported: edition 1003 is not supported by this version of protoapi; features resolve with the edition 2026 defaults",
    ])
    expect(r.document.files?.["pets.proto"]?.syntax).toBe("1003")
    // options of every file are still decoded with the definitions of the loadable files
    expect(r.document.components?.messages?.["shop.v1.Pet"]?.properties.name.options).toEqual({
      "acme.owner": "team-pets",
    })
    expect(r.document.components?.messages?.["shop.v1.pets.Cat"]?.properties.name.options).toEqual({
      "acme.owner": "team-cats",
    })
    expect(r.document.components?.messages?.["shop.v1.GetPetRequest"]?.properties.name.required).toBe(true)
  })
})

describe("PK-3: @bufbuild/protobuf versions", () => {
  const full = readBinary("binary")
  const withLoader = (load: Parameters<typeof createBuilders>[1]) => createBuilders(bundledSources, load)

  test("a decoder without edition 2024 support reports the 2024 file with a version hint", async () => {
    const old = withLoader({ loadBufbuild: async () => ({ pb: { ...pb, maximumEdition: 1000 }, wkt }) })
    const r = await old.buildFromDescriptorSetBinary(full)
    expect(codes(r.issues)).toEqual([
      `unsupported: the definitions in pets.proto cannot be loaded into the @bufbuild/protobuf registry (edition 2024 is newer than the installed @bufbuild/protobuf supports (up to edition 2023); edition 2024 needs @bufbuild/protobuf >= ${BUFBUILD_MINIMUM}, edition 2026 needs >= 2.16.0); options that use them are not decoded`,
    ])
    expect(r.document.components?.messages?.["shop.v1.Pet"]?.properties.name.options).toEqual({
      "acme.owner": "team-pets",
    })
  })

  test("v1 (no fromBinary / FileDescriptorSetSchema) is an unsupported issue with a version hint", async () => {
    const v1 = withLoader({ loadBufbuild: async () => ({ pb: { proto3: {} }, wkt: undefined }) })
    const r = await v1.buildFromDescriptorSetBinary(full)
    expect(r.document).toEqual({ protoapi: "0.1" })
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].code).toBe("unsupported")
    expect(r.issues[0].message).toContain("not a 2.x release")
    expect(r.issues[0].message).toContain(`>= ${BUFBUILD_MINIMUM}`)
  })

  test("a missing package is an unsupported issue with a version hint", async () => {
    const missing = withLoader({
      loadBufbuild: () => loadBufbuild(() => Promise.reject(new Error("Cannot find package '@bufbuild/protobuf'"))),
    })
    const r = await missing.buildFromDescriptorSetBinary(full)
    expect(r.issues.map((i) => i.code)).toEqual(["unsupported"])
    expect(r.issues[0].message).toBe(
      `cannot decode the FileDescriptorSet: the optional peer dependency @bufbuild/protobuf (>= ${BUFBUILD_MINIMUM}) is not installed; install it or pass a \`decoder\``,
    )
  })

  test("descriptor fields the decoder does not know (an older schema) are reported with a version hint", async () => {
    // simulate a decoder whose FileDescriptorProto / DescriptorProto lack a field: the bytes carry it as unknown
    const files = decode(full).file.filter((f) => f.name === "pets.proto")
    ;(files[0] as { $unknown?: unknown[] }).$unknown = [{ no: 99, wireType: 0, data: new Uint8Array([1]) }]
    ;(files[0].messageType[0] as { $unknown?: unknown[] }).$unknown = [
      { no: 98, wireType: 0, data: new Uint8Array([1]) },
    ]
    const r = await buildFromDescriptorSetBinary(encode(files))
    const hint = `edition 2024 needs @bufbuild/protobuf >= ${BUFBUILD_MINIMUM}, edition 2026 needs >= 2.16.0`
    expect(codes(r.issues).filter((i) => i.includes("unknown to the installed"))).toEqual([
      `unsupported: field number 99 of google.protobuf.FileDescriptorProto in pets.proto is unknown to the installed @bufbuild/protobuf (up to edition 2026) and dropped; ${hint}`,
      `unsupported: field number 98 of google.protobuf.DescriptorProto in pets.proto is unknown to the installed @bufbuild/protobuf (up to edition 2026) and dropped; ${hint}`,
    ])
  })

  test("the installed devDependency supports edition 2026", () => {
    expect(pb.maximumEdition).toBeGreaterThanOrEqual(1002)
  })
})

describe("editions and Go features through the binary path", () => {
  for (const set of ["catalogue/EX-FILE-4.2026", "catalogue/EX-OPT-6.go"]) {
    test(`${set}: binary image ≡ JSON image`, async () => {
      const fromJson = buildFromDescriptorSet(loadImage(set))
      const fromBinary = await buildFromDescriptorSetBinary(readBinary(set))
      expect(fromBinary.issues).toEqual([])
      expect(JSON.stringify(fromBinary.document)).toBe(JSON.stringify(fromJson.document))
    })
  }
})

describe("bundled definitions of a binary set", () => {
  // buf image of b.proto alone (`option (a.opt) = { v: 7 }`), built against a descriptor.proto whose edition 2024 default exports nested types
  const bytes = Uint8Array.from(
    atob(
      "CqMBCgdiLnByb3RvEgFiGgdvLnByb3RvIgsKAU06BoK1GAIIB0pqCgYSBAAABQEKCAoBDBIDAAARCggKAQISAwEACgoJCgIDABIDAgARCgoKAgQAEgQDAAUBCgoKAwQAARIDAwgJCgoKAwQABxIDBAIcCg0KBgQAB9CGAxIDBAkbCg4KBwQAB9CGAwESAwQVGWIIZWRpdGlvbnNw6QfS9gMECAAYAA==",
    ),
    (c) => c.charCodeAt(0),
  )
  const sources = {
    "x.proto": 'edition = "2024";\npackage a;\nmessage Outer {\n  message Inner {\n    int32 v = 1;\n  }\n}\n',
    "o.proto":
      'edition = "2024";\npackage a;\nimport "google/protobuf/descriptor.proto";\nimport "x.proto";\nextend google.protobuf.MessageOptions {\n  Outer.Inner opt = 50000;\n}\n',
  }

  test("they follow the symbol visibility of the descriptor.proto in BuildOptions.bundle", async () => {
    const descriptor = bundledSources["google/protobuf/descriptor.proto"].replace(
      'edition_defaults = { edition: EDITION_2024, value: "EXPORT_TOP_LEVEL" }',
      'edition_defaults = { edition: EDITION_2024, value: "EXPORT_ALL" }',
    )
    expect(descriptor).not.toBe(bundledSources["google/protobuf/descriptor.proto"])
    const bundle = { "google/protobuf/descriptor.proto": descriptor, ...sources }
    const r = await buildFromDescriptorSetBinary(bytes, { bundle })
    expect(codes(r.issues)).toEqual([])
    expect(r.document.components?.messages?.["b.M"]?.options).toEqual({ "a.opt": { v: 7 } })
  })

  test("they follow the symbol visibility of a descriptor.proto the set contains", async () => {
    const descriptor = pb.clone(wkt.FileDescriptorProtoSchema, wkt.file_google_protobuf_descriptor.proto)
    const visibility = descriptor.messageType
      .find((m) => m.name === "FeatureSet")
      ?.field.find((f) => f.name === "default_symbol_visibility")?.options?.editionDefaults
    const in2024 = visibility?.find((d) => d.edition === wkt.Edition.EDITION_2024)
    expect(in2024?.value).toBe("EXPORT_TOP_LEVEL")
    if (in2024) in2024.value = "EXPORT_ALL"
    const r = await buildFromDescriptorSetBinary(new Uint8Array([...encode([descriptor]), ...bytes]), {
      bundle: sources,
      entry: ["b.proto"],
    })
    expect(codes(r.issues)).toEqual([
      "no-source-info: google/protobuf/descriptor.proto has no SourceCodeInfo; the source map is empty",
    ])
    expect(r.document.components?.messages?.["b.M"]?.options).toEqual({ "a.opt": { v: 7 } })
  })
})

describe("option values without a ProtoJSON form", () => {
  // the file of the buf image below (`--exclude-imports --exclude-source-info`): an Any of a type the set does not define, a Timestamp and a Duration outside the ProtoJSON range (@bufbuild/protobuf's toJson throws for each), and option map and Struct keys named like members of Object.prototype
  const source = `syntax = "proto3";
package p;
import "google/protobuf/descriptor.proto";
import "google/protobuf/any.proto";
import "google/protobuf/duration.proto";
import "google/protobuf/struct.proto";
import "google/protobuf/timestamp.proto";
message O { map<string, int32> m = 1; }
extend google.protobuf.FieldOptions {
  google.protobuf.Any any = 50000;
  int32 num = 50001;
  google.protobuf.Timestamp ts = 50002;
  google.protobuf.Duration dur = 50003;
}
extend google.protobuf.MessageOptions { string label = 50004; O o = 50005; google.protobuf.Struct s = 50006; }
message M {
  option (label) = "kept";
  int32 a = 1 [(any) = { type_url: "type.googleapis.com/x.Unknown" value: "\\x08\\x01" }, (num) = 1];
  int32 b = 2 [(ts) = { seconds: 253402300800 }, (num) = 2];
  int32 c = 3 [(dur) = { seconds: 315576000001 }, (num) = 3];
  int32 d = 4 [(num) = 4];
}
message A { option (o) = { m: { key: "toString" value: 1 } m: { key: "__proto__" value: 2 } }; }
message B { option (s) = { fields: { key: "constructor" value: { number_value: 1 } } fields: { key: "__proto__" value: { bool_value: true } } }; }
`
  const bytes = Uint8Array.from(
    atob(
      "CtoHCgdhLnByb3RvEgFwGiBnb29nbGUvcHJvdG9idWYvZGVzY3JpcHRvci5wcm90bxoZZ29vZ2xlL3Byb3RvYnVmL2FueS5wcm90bxoeZ29vZ2" +
        "xlL3Byb3RvYnVmL2R1cmF0aW9uLnByb3RvGhxnb29nbGUvcHJvdG9idWYvc3RydWN0LnByb3RvGh9nb29nbGUvcHJvdG9idWYvdGltZXN0YW1w" +
        "LnByb3RvIlQKAU8SGQoBbRgBIAMoCzILLnAuTy5NRW50cnlSAW0aNAoGTUVudHJ5EhAKA2tleRgBIAEoCVIDa2V5EhQKBXZhbHVlGAIgASgFUg" +
        "V2YWx1ZToCOAEimgEKAU0SOQoBYRgBIAEoBUIrgrUYIwoddHlwZS5nb29nbGVhcGlzLmNvbS94LlVua25vd24SAggBiLUYAVIBYRIdCgFiGAIg" +
        "ASgFQg+ItRgCkrUYBwiAg9H/rwdSAWISHQoBYxgDIAEoBUIPiLUYA5q1GAcIgbyuzpcJUgFjEhIKAWQYBCABKAVCBIi1GARSAWQ6CKK1GARrZX" +
        "B0IiYKAUE6Iaq1GB0KDQoJX19wcm90b19fEAIKDAoIdG9TdHJpbmcQASI0CgFCOi+ytRgrCg8KCV9fcHJvdG9fXxICIAEKGAoLY29uc3RydWN0" +
        "b3ISCREAAAAAAADwPzpHCgNhbnkSHS5nb29nbGUucHJvdG9idWYuRmllbGRPcHRpb25zGNCGAyABKAsyFC5nb29nbGUucHJvdG9idWYuQW55Ug" +
        "Nhbnk6MQoDbnVtEh0uZ29vZ2xlLnByb3RvYnVmLkZpZWxkT3B0aW9ucxjRhgMgASgFUgNudW06SwoCdHMSHS5nb29nbGUucHJvdG9idWYuRmll" +
        "bGRPcHRpb25zGNKGAyABKAsyGi5nb29nbGUucHJvdG9idWYuVGltZXN0YW1wUgJ0czpMCgNkdXISHS5nb29nbGUucHJvdG9idWYuRmllbGRPcH" +
        "Rpb25zGNOGAyABKAsyGS5nb29nbGUucHJvdG9idWYuRHVyYXRpb25SA2R1cjo3CgVsYWJlbBIfLmdvb2dsZS5wcm90b2J1Zi5NZXNzYWdlT3B0" +
        "aW9ucxjUhgMgASgJUgVsYWJlbDo1CgFvEh8uZ29vZ2xlLnByb3RvYnVmLk1lc3NhZ2VPcHRpb25zGNWGAyABKAsyBC5wLk9SAW86SAoBcxIfLm" +
        "dvb2dsZS5wcm90b2J1Zi5NZXNzYWdlT3B0aW9ucxjWhgMgASgLMhcuZ29vZ2xlLnByb3RvYnVmLlN0cnVjdFIBc2IGcHJvdG8z0vYDBAgAGAA=",
    ),
    (c) => c.charCodeAt(0),
  )

  test("only the value without a ProtoJSON form is decoded from its bytes; the other options of the file survive", async () => {
    const text = buildFromProto({ "a.proto": source })
    const r = await buildFromDescriptorSetBinary(bytes)
    expect(codes(r.issues)).toEqual([
      "no-source-info: a.proto has no SourceCodeInfo; the source map is empty",
      "unknown-option: unknown type type.googleapis.com/x.Unknown in an Any option value; the value is kept as written",
    ])
    expect(codes(text.issues)).toEqual(codes(r.issues).slice(1))
    expect(JSON.stringify(r.document)).toBe(JSON.stringify(text.document))
    const m = r.document.components?.messages?.["p.M"]
    expect(m?.options).toEqual({ "p.label": "kept" })
    expect(m?.properties.a.options).toEqual({
      "p.any": { type_url: "type.googleapis.com/x.Unknown", value: "CAE=" },
      "p.num": 1,
    })
    expect(m?.properties.b.options).toEqual({ "p.num": 2, "p.ts": { seconds: "253402300800" } })
    expect(m?.properties.c.options).toEqual({ "p.num": 3, "p.dur": { seconds: "315576000001" } })
    expect(m?.properties.d.options).toEqual({ "p.num": 4 })
    expect(JSON.stringify(r.document.components?.messages?.["p.A"]?.options)).toBe(
      '{"p.o":{"m":{"__proto__":2,"toString":1}}}',
    )
    expect(JSON.stringify(r.document.components?.messages?.["p.B"]?.options)).toBe(
      '{"p.s":{"fields":{"__proto__":{"bool_value":true},"constructor":{"number_value":1}}}}',
    )
  })
})
