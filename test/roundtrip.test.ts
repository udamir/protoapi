// PB-7: build(print(build(x))) ≡ build(x), except x-annotation-conflicts (design §10, §13; validation phase D).
//
// `roundTrip` (helpers.ts) prints with the build's tag options and rebuilds from the printed files alone (`imports: "user"`, the default), every printed file over the sources (`"all"`) or the printed entry files over the sources (`"referenced"`). PB-7.7 … PB-7.11 run it over every input the tests have, in all three emission modes; PB-7.12 checks that the printed text passes `buf build` wherever the input did (recorded by scripts/print-check.ts in test/images/printed.json, keyed by the printed text's hash).

import { describe, expect, test } from "vite-plus/test"
import { existsSync, readFileSync } from "node:fs"
import { buildFromProto, bundledFiles, printProto } from "../src/index.ts"
import type { BuildOptions, PrintOptions, ProtoApiDocument, ProtoSources } from "../src/index.ts"
import { IMPORT_MODES, inMode, loadSources, roundTrip } from "./helpers.ts"
import { PRINT_CHECK, type PrintCheck, printedHash, roundTripSets } from "./roundtrip-sets.ts"

const L = (...lines: string[]) => lines.join("\n")

/** The round trip of `sources` must be exact in every emission mode: no difference, no new issue. */
const exact = (sources: ProtoSources, options: BuildOptions = {}, print: PrintOptions = {}) => {
  for (const imports of IMPORT_MODES) {
    const r = roundTrip(sources, inMode(options, imports), print)
    const got = { imports, diff: r.diff, newIssues: r.newIssues.map((i) => `${i.code}: ${i.message}`) }
    expect(got).toEqual({ imports, diff: [], newIssues: [] })
  }
}

/**
 * Inputs outside the guarantee, with the reason. EX-FILE-6 is invalid on purpose: d.proto uses `Pet` through a
 * non-public import (an `unresolved-type`); the printer adds the import the reference needs (design §10: imports are
 * recomputed from the references used), so the rebuilt `files[d.proto].imports` gains `a.proto`.
 */
const EXCEPTIONS: Record<string, string> = {
  "catalogue/EX-FILE-6": '/files/d.proto/imports: ["e.proto"] !== ["e.proto","a.proto"]',
  "catalogue/EX-FILE-6.includeImports": '/files/d.proto/imports: ["e.proto"] !== ["e.proto","a.proto"]',
  "catalogue/EX-FILE-6.user": '/files/d.proto/imports: ["e.proto"] !== ["e.proto","a.proto"]',
}

const sets = await roundTripSets()
const group = (prefix: string) => sets.filter((s) => s.id.startsWith(prefix))

const runSets = (list: typeof sets) => {
  expect(list.length).toBeGreaterThan(0)
  for (const s of list) {
    for (const imports of IMPORT_MODES) {
      const r = roundTrip(s.sources, inMode(s.options, imports))
      const known = EXCEPTIONS[s.id]
      if (known) {
        // the exception stays visible: exactly the documented difference
        expect(r.diff).toEqual([known])
        continue
      }
      const got = {
        set: s.id,
        imports,
        diff: r.diff,
        newIssues: r.newIssues.map((i) => `${i.code}: ${i.message}`),
      }
      expect(got).toEqual({ set: s.id, imports, diff: [], newIssues: [] })
    }
  }
}

describe("PB-7 printer round trip", () => {
  test("PB-7.1: PoC fixtures", () => {
    const r = roundTrip(loadSources("poc"))
    expect(r.second.issues).toEqual([])
    expect(r.diff).toEqual([])
  })

  test("PB-7.2: every bundled file", () => {
    const r = roundTrip({ ...bundledFiles }, { includeImports: true })
    expect(r.second.issues).toEqual([])
    expect(r.diff).toEqual([])
  })

  test("PB-7.2b: googleapis corpus", () => {
    const r = roundTrip(loadSources("googleapis"))
    expect(r.newIssues).toEqual([])
    expect(r.diff).toEqual([])
  }, 30000)

  test("PB-7.3: printed text is readable protobuf", () => {
    const { printed } = roundTrip({
      "shop.proto": L(
        'syntax = "proto3";',
        "package shop.v1;",
        "message Pet { message Tag { string v = 1; } repeated Tag tags = 1; map<string, Pet> kids = 2; }",
        "message Empty {}",
        "service S { rpc Get(Pet) returns (stream Pet); }",
      ),
    })
    const text = printed["shop.proto"]
    expect(text).toContain("repeated Tag tags = 1;")
    expect(text).toContain("map<string, Pet> kids = 2;")
    expect(text).toContain("rpc Get(Pet) returns (stream Pet);")
    expect(text).toContain("message Empty {}")
  })

  test("PB-7.4: proto2 groups, defaults and extensions", () => {
    exact({
      "legacy.proto": L(
        'syntax = "proto2";',
        "package shop.legacy;",
        "enum Color { RED = 1; GREEN = 2; }",
        "message Order {",
        "  required int64 id = 1;",
        '  optional string note = 2 [default = "a\\"b\\n"];',
        '  optional bytes magic = 3 [default = "\\001\\377"];',
        "  optional double ceiling = 4 [default = inf];",
        "  optional Color color = 5 [default = GREEN];",
        "  repeated group Result = 6 { required string url = 1; }",
        "  extensions 100 to max;",
        "}",
        "extend Order { optional bool priority = 100; repeated string notes = 101; }",
      ),
    })
  })

  test("PB-7.5: editions features", () => {
    exact({
      "ed.proto": L(
        'edition = "2023";',
        "package shop.edt;",
        "option features.field_presence = IMPLICIT;",
        "option features.enum_type = CLOSED;",
        "message Item {",
        "  string name = 1;",
        "  int32 qty = 2 [features.field_presence = EXPLICIT];",
        "  string code = 3 [features.field_presence = LEGACY_REQUIRED];",
        "  Item next = 4 [features.message_encoding = DELIMITED];",
        "}",
        "enum Kind { KIND_UNKNOWN = 0; }",
        "enum Mode { option features.enum_type = OPEN; MODE_UNKNOWN = 0; }",
      ),
    })
  })

  test("PB-7.6: annotations printed back as their options (decision 11, P-6, P-7)", () => {
    const sources = {
      "a.proto": L(
        'syntax = "proto3";',
        "package a;",
        'import "buf/validate/validate.proto";',
        'import "google/api/field_behavior.proto";',
        "message Search {",
        "  // Required. Search phrase.",
        '  // @Example "golden retriever"',
        "  string query = 1 [(buf.validate.field).string = { min_len: 1, max_len: 200 }];",
        '  repeated string tags = 2 [(buf.validate.field).repeated = { max_items: 5, unique: true, items: { string: { pattern: "^[a-z]+$" } } }];',
        "  map<string, int32> weights = 3 [(buf.validate.field).map = { min_pairs: 1, keys: { string: { min_len: 2 } } }];",
        "  int64 shop_id = 4 [(buf.validate.field).int64.gt = 0, (google.api.field_behavior) = IMMUTABLE];",
        "  bool tos = 5 [(buf.validate.field).bool.const = true];",
        "  // @Default 20",
        "  int32 page_size = 6;",
        "  enum Status { STATUS_UNSPECIFIED = 0; STATUS_A = 1; STATUS_B = 2; }",
        "  Status status = 7 [(buf.validate.field).enum = { in: [1, 2] }];",
        "}",
      ),
    }
    exact(sources)
    const text = printProto(buildFromProto(sources).document)["a.proto"]
    // a keyword whose convention is imported prints as that option; the import list is the written one
    expect(text).toContain("(google.api.field_behavior) = REQUIRED")
    expect(text).toContain("(google.api.field_behavior) = IMMUTABLE")
    expect(text).toContain(
      '(buf.validate.field) = { string { min_len: 1 max_len: 200 example: ["golden retriever"] } }',
    )
    expect(text).toContain("(buf.validate.field) = { enum { in: [1, 2] } }")
    expect(text).not.toContain("@MinLength")
    expect(text).toContain("// @Default 20")
    expect(text.match(/^import /gm)?.length).toBe(2)
  })

  test("PB-7.7: every catalogue set, every emission mode (EX-FILE-6 is invalid on purpose)", () => {
    runSets(group("catalogue/"))
  }, 60000)

  test("PB-7.8: the named fixtures (http, validate, edition2024, comments, names, values)", () => {
    runSets(group("named/"))
  })

  test("PB-7.9: the buf breaking corpus (118 modules)", () => {
    runSets(group("buf-breaking/"))
  }, 60000)

  test("PB-7.10: every inline case buf accepts", () => {
    runSets(group("cases/"))
  }, 60000)

  test("PB-7.11: PoC, binary and googleapis sets in every mode, and the bundle", () => {
    runSets(sets.filter((s) => ["poc", "binary", "googleapis", "bundle"].includes(s.id)))
  }, 60000)

  test("PB-7.12: the printed text passes buf build wherever the input does (recorded oracle)", () => {
    expect(existsSync(PRINT_CHECK) ? "recorded" : "run `node scripts/print-check.ts`").toBe("recorded")
    const recorded = JSON.parse(readFileSync(PRINT_CHECK, "utf8")) as PrintCheck
    const problems: string[] = []
    let checked = 0
    for (const s of sets) {
      if (!s.bufValid) continue
      for (const imports of IMPORT_MODES) {
        const key = `${s.id}|${imports}`
        const r = roundTrip(s.sources, inMode(s.options, imports))
        const rec = recorded[key]
        if (!rec) problems.push(`${key}: not recorded`)
        else if (rec.hash !== printedHash(r.used))
          problems.push(`${key}: printed text changed, re-run scripts/print-check.ts`)
        else if (rec.buf !== "ok") problems.push(`${key}: buf rejects the printed text: ${rec.buf.slice(0, 200)}`)
        else checked++
      }
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(600)
  }, 120000)

  test("PB-7.13: comment tags and AIP prefixes when no convention is imported (decision 11)", () => {
    const sources = {
      "a.proto": L(
        'syntax = "proto3";',
        "package a;",
        "enum Color { COLOR_UNSPECIFIED = 0; RED = 1; BLUE = 2; }",
        "message M {",
        "  // Required. Output only. the id",
        "  // @Minimum 1",
        "  // @Maximum 10",
        "  // @MultipleOf 2",
        "  int32 id = 1;",
        "  // Input only. Immutable.",
        "  // @MinLength 2",
        "  // @Pattern ^a+$",
        "  // @Format email",
        '  // @Enum "a,b", c',
        '  // @Example "x"',
        "  // @Example 5",
        '  // @Default "zz"',
        "  // @Title The name",
        "  string name = 2;",
        "  // @MinItems 1",
        "  // @ExclusiveMinimum -5",
        "  repeated int64 nums = 3;",
        "  // @MinItems 2",
        "  // @Pattern ^k",
        "  map<string, string> kv = 4;",
        "  // @Enum RED, 2",
        "  Color color = 5;",
        "  // @Enum 1, 2, 3",
        "  uint64 big = 6;",
        "  // @Enum 0.5, 1.25",
        "  float f = 7;",
        "  // Deprecated: use other",
        "  int32 old = 8;",
        "}",
      ),
    }
    exact(sources)
    const text = printProto(buildFromProto(sources).document)["a.proto"]
    expect(text).toContain("// Immutable.")
    expect(text).toContain("// @Enum RED, BLUE")
    expect(text).toContain("// @Enum 1, 2, 3")
    expect(text).not.toContain("import ")
  })

  test("PB-7.14: annotations: options with tags: false (documents built with annotations options)", () => {
    exact(
      {
        "a.proto": L(
          'syntax = "proto3";',
          "package a;",
          'import "buf/validate/validate.proto";',
          'import "google/api/field_behavior.proto";',
          "message M {",
          "  // Required. text stays",
          "  // @Minimum 3",
          "  int32 id = 1 [(buf.validate.field).int32 = { gte: 1, lte: 9, in: [1, 2] }, (google.api.field_behavior) = REQUIRED];",
          '  string s = 2 [(buf.validate.field).string = { min_len: 1, pattern: "^x", email: true, example: "a@b" }];',
          "  repeated string r = 3 [(buf.validate.field).repeated = { min_items: 1, unique: true, items: { string: { max_len: 3 } } }];",
          "  map<string, int32> m = 4 [(buf.validate.field).map = { min_pairs: 1, keys: { string: { min_len: 1 } }, values: { int32: { gt: 0 } } }];",
          "  bool b = 5 [(buf.validate.field).bool.const = true];",
          "}",
        ),
      },
      { annotations: "options" },
    )
  })

  test("PB-7.15: deprecation reasons on every element kind (P-3), oneofs without an option (A-4)", () => {
    exact({
      "a.proto": L(
        'syntax = "proto3";',
        "package a;",
        "// Deprecated: m reason",
        "message M {",
        "  // Deprecated: oneof reason",
        "  oneof o { int32 x = 1; }",
        "  // @Deprecated",
        "  oneof p { int32 y = 2; }",
        "  // Deprecated: f reason",
        "  int32 f = 3;",
        "}",
        "// Deprecated: e reason",
        "enum E {",
        "  // Deprecated: v reason",
        "  E_UNSPECIFIED = 0;",
        "}",
        "// Deprecated: s reason",
        "service S {",
        "  // Deprecated: r reason",
        "  rpc R(M) returns (M);",
        "}",
      ),
    })
  })

  test("PB-7.16: groups in extend blocks (P-1), extension order (P-4), nested order around groups (P-5)", () => {
    exact({
      "a.proto": L(
        'syntax = "proto2";',
        "package a;",
        "message A {",
        "  extensions 100 to 200;",
        "  message N {}",
        "  optional group G = 1 { optional int32 x = 1; }",
        "  message N2 {}",
        "  extend A { optional group Inner = 101 { optional int32 y = 1; } }",
        "}",
        "message B { extensions 1 to 10; }",
        "extend A { optional group Ext = 100 { optional int32 z = 1; } optional int32 plain = 102; }",
        "message C {}",
        "extend B { optional int32 other = 1; }",
        "extend A { optional int32 later = 103; }",
      ),
    })
  })

  test("PB-7.17: editions features inherited from the file and messages (P-2)", () => {
    exact({
      "a.proto": L(
        'edition = "2023";',
        "package a;",
        "option features.message_encoding = DELIMITED;",
        "message A {",
        "  A d = 1;",
        "  A lp = 2 [features.message_encoding = LENGTH_PREFIXED];",
        "  message B { int32 i = 1 [features.field_presence = IMPLICIT]; A x = 3; }",
        "  repeated A many = 3;",
        "  option features.json_format = LEGACY_BEST_EFFORT;",
        "  message C { option features.json_format = ALLOW; int32 c = 1; }",
        "}",
      ),
    })
  })

  test("PB-7.18: documents without files (decision 12): syntax and package inferred, bundled types imported", () => {
    exact(
      {
        "a.proto": L(
          'syntax = "proto2";',
          "package nf.v1;",
          "message M { optional int32 a = 1 [default = 3]; message N { required string s = 1; } }",
        ),
      },
      { files: false },
    )
    exact(
      {
        "a.proto": L(
          'edition = "2023";',
          "package nf.v2;",
          'import "google/protobuf/timestamp.proto";',
          "message M { google.protobuf.Timestamp t = 1; int32 i = 2 [features.field_presence = IMPLICIT]; }",
        ),
      },
      { files: false },
    )
    exact(
      {
        "a.proto": L('syntax = "proto3";', "package one;", "message A { int32 x = 1; }"),
        "b.proto": L('syntax = "proto3";', "package two;", 'import "a.proto";', "message B { one.A a = 1; }"),
      },
      { files: false },
    )
    const doc = buildFromProto(
      { "a.proto": 'syntax = "proto2"; package nf.v1; message M { optional int32 a = 1 [default = 3]; }' },
      { files: false },
    ).document
    expect(printProto(doc)["protoapi.proto"]).toMatch(/^syntax = "proto2";\npackage nf\.v1;/)
  })

  test("PB-7.19: Any option values print in the expanded text form (P-8)", () => {
    exact({
      "a.proto": L(
        'syntax = "proto3";',
        "package a;",
        'import "google/protobuf/any.proto";',
        'import "google/protobuf/descriptor.proto";',
        'import "google/protobuf/duration.proto";',
        'import "google/protobuf/timestamp.proto";',
        'import "google/protobuf/field_mask.proto";',
        'import "google/protobuf/wrappers.proto";',
        "message Payload { string s = 1; int64 n = 2; }",
        "message Opt { google.protobuf.Any any = 1; repeated google.protobuf.Any many = 2; }",
        "extend google.protobuf.MessageOptions { Opt opt = 50000; }",
        "message M {",
        "  option (opt) = {",
        '    any { [type.googleapis.com/a.Payload] { s: "x" n: 5 } }',
        "    many { [type.googleapis.com/google.protobuf.Duration] { seconds: -5 nanos: -500000000 } }",
        "    many { [type.googleapis.com/google.protobuf.Timestamp] { seconds: 1700000000 nanos: 1000 } }",
        '    many { [type.googleapis.com/google.protobuf.FieldMask] { paths: ["a.b_c", "d"] } }',
        "    many { [type.googleapis.com/google.protobuf.Int64Value] { value: 7 } }",
        '    many { [type.googleapis.com/google.protobuf.Any] { [type.googleapis.com/a.Payload] { s: "y" } } }',
        "  };",
        "}",
      ),
    })
  })

  test("PB-7.20: tag rename map in PrintOptions.tags (decision 13), unknown editions written verbatim", () => {
    exact(
      {
        "a.proto": L(
          'syntax = "proto3";',
          "package a;",
          "message M {",
          "  // @DefaultValue 5",
          "  // @Min 1",
          "  int32 a = 1;",
          "}",
        ),
      },
      { tags: { default: "DefaultValue", example: false } },
    )
    const r = roundTrip({ "a.proto": L('edition = "2027";', "package a;", "message M { int32 a = 1; }") })
    expect(r.diff).toEqual([])
    expect(r.printed["a.proto"]).toMatch(/^edition = "2027";/)
  })

  test("PB-7.21: the written imports, re-exports (P-12), option definitions from PrintOptions.sources (P-9)", () => {
    exact(
      {
        "a.proto": L('syntax = "proto3";', "package a;", "message A {}"),
        "b.proto": L('syntax = "proto3";', "package a;", 'import public "a.proto";'),
        "c.proto": L('syntax = "proto3";', "package a;", 'import "b.proto";', "message C { A a = 1; }"),
      },
      { entry: ["c.proto"] },
    )
    const sources = {
      "dep.proto": L(
        'syntax = "proto3";',
        "package dep;",
        'import "google/protobuf/descriptor.proto";',
        "enum Level { LEVEL_UNSPECIFIED = 0; HIGH = 1; }",
        "message Rule { Level level = 1; string name = 2; }",
        "extend google.protobuf.FieldOptions { Rule rule = 50001; Level lvl = 50002; }",
        "message D { int32 x = 1; }",
        "message E { message Inner { int32 y = 1; } }",
      ),
      "main.proto": L(
        'syntax = "proto3";',
        "package main;",
        'import "dep.proto";',
        'message M { dep.D d = 1 [(dep.rule) = { level: HIGH name: "n" }, (dep.lvl) = HIGH]; dep.E.Inner i = 2; }',
      ),
    }
    exact(sources, { entry: ["main.proto"] })
    const doc = buildFromProto(sources, { entry: ["main.proto"] }).document
    expect(printProto(doc, { sources })["main.proto"]).toContain('(dep.rule) = { level: HIGH name: "n" }')
    // the partial import file keeps the nested type under a wrapper message (D3 emits referenced types only)
    expect(printProto(doc)["dep.proto"]).toContain("message E {\n  message Inner {")
  })

  test("PB-7.22: trailing comments with AIP prefixes print as leading comments (P-11, item 10)", () => {
    exact({
      "a.proto": L(
        'syntax = "proto3";',
        "package a;",
        'import "google/api/field_behavior.proto";',
        "message M {",
        "  int32 a = 1; // Required. the id",
        "  int32 b = 2; // Output only. read",
        "}",
      ),
    })
  })

  test("PB-7.24: unknown options print back as written (P-14), sub-paths nested in the document", () => {
    const text = L(
      'syntax = "proto3";',
      "package a;",
      "",
      "message M {",
      "  option (unk.sub).x = 1;",
      '  option (unk.sub).y.z = "s";',
      "  option (unk).sub.w = X;",
      "  option (other) = 5;",
      "  option (o2.a) = { b: 1 };",
      "  int32 f = 1 [(unk.f).g = true, (unk.h) = 2];",
      "}",
      "",
    )
    exact({ "a.proto": text })
    const r = buildFromProto({ "a.proto": text })
    expect(r.document.components?.messages?.["a.M"]?.options).toEqual({
      "unk.sub": { x: "1", y: { z: '"s"' } },
      unk: { sub: { w: "X" } },
      other: "5",
      "o2.a": "{ b: 1 }",
    })
    expect(r.issues.map((i) => `${i.code} @ ${i.pointer?.split("/").slice(-2).join("/")}`)).toEqual([
      "unknown-option @ options/unk.f",
      "unknown-option @ options/unk.h",
      "unknown-option @ options/unk.sub",
      "unknown-option @ options/unk.sub",
      "unknown-option @ options/unk",
      "unknown-option @ options/other",
      "unknown-option @ options/o2.a",
    ])
    expect(printProto(r.document)["a.proto"]).toBe(text)
  })

  test("PB-7.25: an Any written with type_url / value fields prints in the expanded form", () => {
    const r = roundTrip({
      "a.proto": L(
        'syntax = "proto3";',
        "package a;",
        'import "google/protobuf/any.proto";',
        'import "google/protobuf/descriptor.proto";',
        "message Payload { string s = 1; int64 n = 2; }",
        "extend google.protobuf.MessageOptions { google.protobuf.Any an = 50000; }",
        "message M {",
        '  option (an) = { type_url: "type.googleapis.com/a.Payload" value: "\\x0a\\x01x\\x10\\x05" };',
        "}",
      ),
    })
    expect(r.diff).toEqual([])
    expect(r.printed["a.proto"]).toContain('option (a.an) = { [type.googleapis.com/a.Payload] { s: "x" n: 5 } };')
  })

  test("PB-7.26: S1: the field keyword `required` round trips from every source and prints in the §10 order", () => {
    const OA = "grpc.gateway.protoc_gen_openapiv2.options"
    const text = L(
      'syntax = "proto3";',
      "package a;",
      'import "google/api/field_behavior.proto";',
      'import "buf/validate/validate.proto";',
      'import "validate/validate.proto";',
      'import "protoc-gen-openapiv2/options/annotations.proto";',
      "message M {",
      `  option (${OA}.openapiv2_schema) = { json_schema: { required: ["g", "hJson"] } };`,
      "  // @Required",
      "  string a = 1;",
      "  // Required. The b.",
      "  string b = 2;",
      "  string c = 3 [(google.api.field_behavior) = REQUIRED];",
      "  string d = 4 [(buf.validate.field).required = true];",
      "  N e = 5 [(validate.rules).message.required = true];",
      "  string g = 7;",
      '  string h = 8 [json_name = "hJson"];',
      "}",
      "message N {}",
    )
    exact({ "a.proto": text })
    // field_behavior is available, so every source prints as `(google.api.field_behavior) = REQUIRED`
    const printed = roundTrip({ "a.proto": text }).printed["a.proto"]
    expect(printed.match(/\(google\.api\.field_behavior\) = REQUIRED/g)?.length).toBe(7)
    // without the google.api import: protovalidate, then PGV on message fields; without any option: the tag
    const only = (imp: string) =>
      roundTrip({
        "a.proto": L(
          'syntax = "proto3";',
          "package a;",
          imp,
          "message M {",
          "  // @Required",
          "  N e = 1;",
          "}",
          "message N {}",
        ),
      })
    expect(only('import "buf/validate/validate.proto";').printed["a.proto"]).toContain(
      "N e = 1 [(buf.validate.field) = { required: true }];",
    )
    expect(only('import "validate/validate.proto";').printed["a.proto"]).toContain(
      "N e = 1 [(validate.rules) = { message { required: true } }];",
    )
    expect(only("").printed["a.proto"]).toContain("  // @Required\n  N e = 1;")
    // a hand-made document: the keyword on the field is printed; a message `required` array is not read
    const doc = {
      protoapi: "0.1",
      files: { "x.proto": { syntax: "proto3", package: "p" } },
      components: {
        messages: {
          "p.A": {
            type: "object",
            properties: { f: { number: 1, type: "string", protoType: "string", required: true } },
          },
          "p.B": {
            type: "object",
            required: ["f"],
            properties: { f: { number: 1, type: "string", protoType: "string" } },
          },
        },
      },
    } as unknown as ProtoApiDocument
    const out = printProto(doc)["x.proto"]
    expect(out).toContain("  // @Required\n  string f = 1;")
    expect(out.match(/@Required/g)?.length).toBe(1)
  })

  test("PB-7.23: documents with missing optional parts print (API-2); wrong argument types are a TypeError", () => {
    const doc = {
      protoapi: "0.1",
      files: { "x.proto": {} },
      services: { "p.S": { methods: { M: {} } } },
      components: {
        messages: { "p.A": { type: "object" }, "p.B": { type: "object", properties: { f: {} } } },
        enums: { "p.E": { type: "string" } },
        extensions: { "p.x": { number: 1 } },
      },
    } as unknown as ProtoApiDocument
    const out = printProto(doc)
    expect(Object.keys(out)).toEqual(["x.proto"])
    expect(out["x.proto"]).toContain("message A {}")
    expect(printProto({ protoapi: "0.1" })).toEqual({ "protoapi.proto": 'syntax = "proto3";\n' })
    expect(() => printProto(null as never)).toThrow(TypeError)
    expect(() => printProto({ protoapi: "0.1" }, 5 as never)).toThrow(TypeError)
  })
})
