// Protobuf version compatibility (validation report §7): editions (D-C, C-4, F-4), edition feature defaults read
// from FeatureSetDefaults, ProtoJSON serializer variants (C-14), descriptor default values (desc#13).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as pb from "@bufbuild/protobuf"
import * as wkt from "@bufbuild/protobuf/wkt"
import { buildFromDescriptorSet, buildFromProto, bundledFiles } from "../src"
import type { BuildResult, FileDescriptorSetJson } from "../src"
import { FeatureDefaults, featureDefaultsSource } from "../src/features"
import { bundledFeatureDefaults } from "../src/bundle/features"
import { IMAGES, loadImage } from "./helpers"

const codes = (r: BuildResult) =>
  r.issues.filter((i) => i.code !== "no-source-info").map((i) => `${i.code} @ ${i.pointer}: ${i.message}`)
const file = (r: BuildResult, path = "a.proto") => r.document.files?.[path]
const msg = (r: BuildResult, fqn: string) => r.document.components?.messages?.[fqn]

/** A minimal editions FileDescriptorProto (ProtoJSON) with one message `p.M { string s = 1; repeated int32 r = 2; }`. */
const descriptorSet = (fields: Record<string, unknown>): FileDescriptorSetJson => ({
  file: [
    {
      name: "a.proto",
      package: "p",
      ...fields,
      messageType: [
        {
          name: "M",
          field: [
            { name: "s", number: 1, type: "TYPE_STRING", label: "LABEL_OPTIONAL", jsonName: "s" },
            { name: "r", number: 2, type: "TYPE_INT32", label: "LABEL_REPEATED", jsonName: "r" },
          ],
        },
      ],
    },
  ],
})

describe("D-C: editions", () => {
  test("edition 2026 from text: syntax 2026, no issue, 2026 features typed", () => {
    const r = buildFromProto({
      "a.proto": `edition = "2026";\npackage p;\noption features.enforce_naming_style = STYLE2026;\nmessage M { string s = 1; }\n`,
    })
    expect(codes(r)).toEqual([])
    expect(file(r)).toEqual({
      syntax: "2026",
      package: "p",
      options: { features: { enforce_naming_style: "STYLE2026" } },
    })
    expect(msg(r, "p.M")?.properties.s).toEqual({
      number: 1,
      type: "string",
      protoType: "string",
      presence: "explicit",
    })
  })

  test("edition 2026 from descriptors: EDITION_2026 and 1002, numeric feature values named", () => {
    for (const edition of ["EDITION_2026", 1002, "1002"]) {
      const set = descriptorSet({
        syntax: "editions",
        edition,
        options: { features: { enforceNamingStyle: 3, defaultSymbolVisibility: 4, enforceProtoLimits: 2 } },
      })
      const r = buildFromDescriptorSet(set)
      expect(codes(r)).toEqual([])
      expect(file(r)).toEqual({
        syntax: "2026",
        package: "p",
        options: {
          features: {
            enforce_naming_style: "STYLE2026",
            default_symbol_visibility: "STRICT",
            enforce_proto_limits: "PROTO_LIMITS2026",
          },
        },
      })
    }
  })

  const unknown: [string, Record<string, unknown>, string, string][] = [
    ["EDITION_UNSTABLE", { syntax: "editions", edition: "EDITION_UNSTABLE" }, "UNSTABLE", "edition EDITION_UNSTABLE"],
    ["9999", { syntax: "editions", edition: 9999 }, "UNSTABLE", "edition EDITION_UNSTABLE"],
    ["EDITION_MAX", { syntax: "editions", edition: "EDITION_MAX" }, "MAX", "edition EDITION_MAX"],
    ["unnamed number", { syntax: "editions", edition: 1003 }, "1003", "edition 1003"],
    ["unknown name", { syntax: "editions", edition: "EDITION_2027" }, "2027", "edition EDITION_2027"],
    ["no syntax, unnamed number", { edition: 1003 }, "1003", "edition 1003"],
    ["editions without an edition", { syntax: "editions" }, "editions", 'syntax "editions" without an edition'],
  ]
  for (const [label, fields, syntax, what] of unknown) {
    test(`descriptor, ${label}: syntax "${syntax}" verbatim, unsupported, newest known defaults`, () => {
      const r = buildFromDescriptorSet(descriptorSet(fields))
      expect(file(r)?.syntax).toBe(syntax)
      expect(codes(r)).toEqual([
        `unsupported @ #/files/a.proto/syntax: ${what} is not supported by this version of protoapi; features resolve with the edition 2026 defaults`,
      ])
      // 2026 defaults: explicit presence, packed (no `packed: false`), open enums
      expect(msg(r, "p.M")?.properties).toEqual({
        s: { number: 1, type: "string", protoType: "string", presence: "explicit" },
        r: { number: 2, type: "array", items: { type: "integer", protoType: "int32" } },
      })
    })
  }

  for (const [label, text, syntax] of [
    ["UNSTABLE", "UNSTABLE", "UNSTABLE"],
    ["a future year", "2027", "2027"],
  ]) {
    test(`text, ${label}: the same spelling and issue as the descriptor producer`, () => {
      const r = buildFromProto({ "a.proto": `edition = "${text}";\npackage p;\nmessage M { string s = 1; }\n` })
      expect(file(r)?.syntax).toBe(syntax)
      expect(codes(r)).toEqual([
        `unsupported @ #/files/a.proto/syntax: edition "${text}" is not supported by this version of protoapi; features resolve with the edition 2026 defaults`,
      ])
      expect(r.issues[0].location?.start).toEqual({ line: 0, column: 0 })
      expect(msg(r, "p.M")?.properties.s.presence).toBe("explicit")
    })
  }

  test("EDITION_PROTO3 / EDITION_PROTO2 without syntax are proto3 / proto2", () => {
    const p3 = buildFromDescriptorSet(descriptorSet({ edition: "EDITION_PROTO3" }))
    expect(file(p3)?.syntax).toBe("proto3")
    expect(msg(p3, "p.M")?.properties.s.presence).toBeUndefined()
    const p2 = buildFromDescriptorSet(descriptorSet({ edition: 998 }))
    expect(file(p2)?.syntax).toBe("proto2")
    expect(codes(p2)).toEqual([])
  })
})

describe("F-4: edition defaults from FeatureSetDefaults", () => {
  const table = new FeatureDefaults(bundledFeatureDefaults)

  test("the bundled table (descriptor.proto v36.2) per syntax", () => {
    const pick = (s: string) => {
      const f = table.forSyntax(s)
      return [
        f.field_presence,
        f.enum_type,
        f.repeated_field_encoding,
        f.utf8_validation,
        f.message_encoding,
        f.json_format,
        f.enforce_naming_style,
        f.default_symbol_visibility,
        f.enforce_proto_limits,
      ].join(" ")
    }
    const legacy = "EXPANDED NONE LENGTH_PREFIXED LEGACY_BEST_EFFORT STYLE_LEGACY EXPORT_ALL LEGACY_NO_EXPLICIT_LIMITS"
    expect(pick("proto2")).toBe(`EXPLICIT CLOSED ${legacy}`)
    expect(pick("proto3")).toBe(
      "IMPLICIT OPEN PACKED VERIFY LENGTH_PREFIXED ALLOW STYLE_LEGACY EXPORT_ALL LEGACY_NO_EXPLICIT_LIMITS",
    )
    expect(pick("2023")).toBe(
      "EXPLICIT OPEN PACKED VERIFY LENGTH_PREFIXED ALLOW STYLE_LEGACY EXPORT_ALL LEGACY_NO_EXPLICIT_LIMITS",
    )
    expect(pick("2024")).toBe(
      "EXPLICIT OPEN PACKED VERIFY LENGTH_PREFIXED ALLOW STYLE2024 EXPORT_TOP_LEVEL LEGACY_NO_EXPLICIT_LIMITS",
    )
    expect(pick("2026")).toBe("EXPLICIT OPEN PACKED VERIFY LENGTH_PREFIXED ALLOW STYLE2026 STRICT PROTO_LIMITS2026")
    expect(pick("UNSTABLE")).toBe(pick("2026"))
  })

  test("the generated table equals the one read from the bundled descriptor.proto at build time", () => {
    const r = buildFromProto({ "google/protobuf/descriptor.proto": bundledFiles["google/protobuf/descriptor.proto"] })
    const fs = msg(r, "google.protobuf.FeatureSet")
    const ed = r.document.components?.enums?.["google.protobuf.Edition"]
    const source = featureDefaultsSource(
      Object.entries(fs?.properties ?? {}).map(([name, f]) => ({ name, editionDefaults: f.options?.edition_defaults })),
      Object.entries(ed?.values ?? {}).map(([name, v]) => ({ name, number: v.number })),
    )
    expect(source).toEqual(bundledFeatureDefaults)
  })

  // a user descriptor.proto where edition 2023 defaults to implicit presence and closed enums
  const userDescriptor = bundledFiles["google/protobuf/descriptor.proto"]
    .replace(
      'edition_defaults = { edition: EDITION_2023, value: "EXPLICIT" }',
      'edition_defaults = { edition: EDITION_2023, value: "IMPLICIT" }',
    )
    .replace(
      'edition_defaults = { edition: EDITION_PROTO3, value: "OPEN" }',
      'edition_defaults = { edition: EDITION_PROTO3, value: "OPEN" },\n    edition_defaults = { edition: EDITION_2023, value: "CLOSED" }',
    )
  // `e` keeps explicit presence: with the user's defaults E is closed, and a closed enum on an implicit-presence field
  // is invalid (phase B validation, buf: "closed enum `p.E` cannot be used in an implicit-presence field")
  const user = `edition = "2023";\npackage p;\nenum E { A = 0; }\nmessage M { string s = 1; E e = 2 [features.field_presence = EXPLICIT]; }\n`

  test("a user-supplied descriptor.proto in the sources wins over the bundle (text)", () => {
    expect(userDescriptor).not.toBe(bundledFiles["google/protobuf/descriptor.proto"])
    const bundled = buildFromProto({ "a.proto": user })
    expect(msg(bundled, "p.M")?.properties.s.presence).toBe("explicit")
    expect(bundled.document.components?.enums?.["p.E"]?.closed).toBeUndefined()
    const own = buildFromProto(
      { "a.proto": user, "google/protobuf/descriptor.proto": userDescriptor },
      { entry: ["a.proto"] },
    )
    expect(codes(own)).toEqual([])
    expect(msg(own, "p.M")?.properties.s.presence).toBeUndefined()
    expect(own.document.components?.enums?.["p.E"]?.closed).toBe(true)
    // the bundled defaults are not changed for later builds
    expect(msg(buildFromProto({ "a.proto": user }), "p.M")?.properties.s.presence).toBe("explicit")
  })

  test("a user-supplied descriptor.proto in a descriptor set wins over the bundle", () => {
    const own = buildFromProto({ "a.proto": user, "google/protobuf/descriptor.proto": userDescriptor })
    // the descriptor.proto of the set, as ProtoJSON, with the user's edition_defaults
    const image = loadImage("bundle")
    const desc = image.file.find((f) => f.name === "google/protobuf/descriptor.proto") as Record<string, any>
    const patched = structuredClone(desc)
    const featureSet = patched.messageType.find((m: any) => m.name === "FeatureSet")
    const presence = featureSet.field.find((f: any) => f.name === "field_presence")
    presence.options.editionDefaults = presence.options.editionDefaults.map((d: any) =>
      d.edition === "EDITION_2023" ? { ...d, value: "IMPLICIT" } : d,
    )
    const set = descriptorSet({
      syntax: "editions",
      edition: "EDITION_2023",
      dependency: ["google/protobuf/descriptor.proto"],
    })
    const r = buildFromDescriptorSet({ file: [patched, ...set.file] }, { entry: ["a.proto"] })
    expect(msg(r, "p.M")?.properties.s.presence).toBeUndefined()
    expect(msg(own, "p.M")?.properties.s.presence).toBeUndefined()
    // without it, the bundled defaults apply
    expect(
      msg(buildFromDescriptorSet(descriptorSet({ syntax: "editions", edition: "EDITION_2023" })), "p.M")?.properties.s
        .presence,
    ).toBe("explicit")
  })
})

describe("C-14: ProtoJSON serializer variants give the same document", () => {
  const bytes = new Uint8Array(readFileSync(join(IMAGES, "binary.binpb")))
  const set = pb.fromBinary(wkt.FileDescriptorSetSchema, bytes)
  const registry = pb.createFileRegistry(set)
  const toJson = (options: Partial<pb.JsonWriteOptions>) =>
    pb.toJson(wkt.FileDescriptorSetSchema, set, { registry, ...options }) as unknown as FileDescriptorSetJson
  const entry = ["acme/opts.proto", "pets.proto", "shop.proto"]
  const base = buildFromDescriptorSet(toJson({}), { entry, includeImports: true })

  for (const [label, options] of [
    ["alwaysEmitImplicit", { alwaysEmitImplicit: true }],
    ["alwaysEmitImplicit + useProtoFieldName", { alwaysEmitImplicit: true, useProtoFieldName: true }],
    ["alwaysEmitImplicit + enumAsInteger", { alwaysEmitImplicit: true, enumAsInteger: true }],
  ] as const) {
    test(`${label} ≡ default toJson (descriptor.proto, googleapis, protovalidate and the fixture, includeImports)`, () => {
      const json = toJson(options)
      expect(JSON.stringify(json)).toContain(
        options.useProtoFieldName ? '"uninterpreted_option":[]' : '"uninterpretedOption":[]',
      )
      const r = buildFromDescriptorSet(json, { entry, includeImports: true })
      expect(r.issues).toEqual(base.issues)
      expect(JSON.stringify(r.document)).toBe(JSON.stringify(base.document))
    })
  }

  const opt = `syntax = "proto3";
package acme;
import "google/protobuf/descriptor.proto";
message Opt { string a = 1; int32 b = 2; repeated string c = 3; optional string d = 4; Kind k = 5; Opt sub = 6; }
enum Kind { KIND_UNSPECIFIED = 0; KIND_A = 1; }
extend google.protobuf.MessageOptions { Opt opt = 50002; }
`

  test("implicit-presence zero values in option messages equal absent ones (text)", () => {
    const r = buildFromProto(
      {
        "acme/opt.proto": opt,
        "a.proto": `syntax = "proto3";\npackage p;\nimport "acme/opt.proto";\nmessage M {\n  option (acme.opt) = { a: "" b: 0 d: "" k: KIND_UNSPECIFIED sub: { a: "x" b: 0 } };\n  option (acme.opt).sub.sub.b = 0;\n}\n`,
      },
      { entry: ["a.proto"] },
    )
    expect(codes(r)).toEqual([])
    expect(msg(r, "p.M")?.options).toEqual({ "acme.opt": { d: "", sub: { a: "x", sub: {} } } })
  })

  test("the same from ProtoJSON with and without implicit fields", () => {
    const json = (o: Record<string, unknown>): FileDescriptorSetJson => ({
      file: [
        {
          name: "a.proto",
          package: "p",
          syntax: "proto3",
          dependency: ["acme/opt.proto"],
          messageType: [{ name: "M", options: o }],
        },
      ],
    })
    const sources = { "acme/opt.proto": opt }
    const plain = buildFromDescriptorSet(json({ "[acme.opt]": { d: "", sub: { a: "x", sub: {} } } }), {
      bundle: sources,
    })
    const implicit = buildFromDescriptorSet(
      json({
        "[acme.opt]": {
          a: "",
          b: 0,
          c: [],
          d: "",
          k: "KIND_UNSPECIFIED",
          sub: { a: "x", b: 0, c: [], k: 0, sub: { a: "", b: 0, c: [] } },
        },
        uninterpretedOption: [],
        deprecated: false,
      }),
      { bundle: sources },
    )
    expect(msg(plain, "p.M")?.options).toEqual({ "acme.opt": { d: "", sub: { a: "x", sub: {} } } })
    expect(JSON.stringify(implicit.document)).toBe(JSON.stringify(plain.document))
  })
})

describe("desc#13: descriptor default values", () => {
  const set = (fields: [string, string, string, string?][]): FileDescriptorSetJson => ({
    file: [
      {
        name: "a.proto",
        package: "p",
        enumType: [
          {
            name: "E",
            value: [
              { name: "A", number: 1 },
              { name: "B", number: 2 },
            ],
          },
        ],
        messageType: [
          {
            name: "M",
            field: fields.map(([type, defaultValue, name, typeName], i) => ({
              name,
              number: i + 1,
              label: "LABEL_OPTIONAL",
              type,
              ...(typeName ? { typeName } : {}),
              defaultValue,
              jsonName: name,
            })),
          },
        ],
      },
    ],
  })

  test("a value that cannot be parsed for the field type is an invalid-option issue and is dropped", () => {
    const r = buildFromDescriptorSet(
      set([
        ["TYPE_INT32", "abc", "i"],
        ["TYPE_INT32", "2147483648", "big"],
        ["TYPE_UINT64", "-1", "neg"],
        ["TYPE_BOOL", "yes", "b"],
        ["TYPE_DOUBLE", "1.2.3", "d"],
        ["TYPE_ENUM", "C", "e", ".p.E"],
        ["TYPE_INT64", "-9223372036854775808", "ok64"],
        ["TYPE_ENUM", "B", "oke", ".p.E"],
        ["TYPE_DOUBLE", "-inf", "okd"],
      ]),
    )
    const props = msg(r, "p.M")?.properties ?? {}
    for (const n of ["i", "big", "neg", "b", "d", "e"]) expect(props[n]?.default).toBeUndefined()
    expect([props.ok64?.default, props.oke?.default, props.okd?.default]).toEqual([
      "-9223372036854775808",
      "B",
      "-Infinity",
    ])
    expect(codes(r)).toEqual([
      'invalid-option @ #/components/messages/p.M/properties/i: default value "abc" is not valid for field i (int32); it is dropped',
      'invalid-option @ #/components/messages/p.M/properties/big: default value "2147483648" is not valid for field big (int32); it is dropped',
      'invalid-option @ #/components/messages/p.M/properties/neg: default value "-1" is not valid for field neg (uint64); it is dropped',
      'invalid-option @ #/components/messages/p.M/properties/b: default value "yes" is not valid for field b (bool); it is dropped',
      'invalid-option @ #/components/messages/p.M/properties/d: default value "1.2.3" is not valid for field d (double); it is dropped',
      'invalid-option @ #/components/messages/p.M/properties/e: default value "C" is not valid for field e (p.E); it is dropped',
    ])
  })
})
