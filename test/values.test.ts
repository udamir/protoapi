// PB-5 canonical values (design §3.6, D7, rule D, rule J) and the phase C value fixes, against the buf oracle; cases
// in test/cases/values.ts. Also: unknown option fields from descriptors (C-11), and the global guard that no document
// holds `null` or a non-finite number (C-5).

import { describe, expect, test } from "vite-plus/test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildFromDescriptorSet, buildFromProto, bundledFiles } from "../src/index.ts"
import type { ProtoApiDocument } from "../src/index.ts"
import { buildCase, describeCases, loadOracles } from "./cases/run.ts"
import type { Case } from "./cases/types.ts"
import { cases } from "./cases/values.ts"
import { FIXTURES, IMAGES, buildBoth, fixtureSets, loadImage, loadSources } from "./helpers.ts"

describeCases("PB-5 canonical values", "values", cases)

/** Every `null` or non-finite number in a JSON value, as pointer paths. */
const badValues = (v: unknown, path = "#", out: string[] = []): string[] => {
  if (v === null) out.push(`${path}: null`)
  else if (typeof v === "number" && !Number.isFinite(v)) out.push(`${path}: ${v}`)
  else if (Array.isArray(v)) v.forEach((x, i) => badValues(x, `${path}/${i}`, out))
  else if (typeof v === "object" && v) for (const [k, x] of Object.entries(v)) badValues(x, `${path}/${k}`, out)
  return out
}

/** The document survives JSON: no null, no non-finite number, no negative zero (which JSON writes as 0). */
const assertJsonSafe = (doc: ProtoApiDocument) => {
  expect(badValues(doc)).toEqual([])
  expect(JSON.stringify(doc)).toBe(JSON.stringify(JSON.parse(JSON.stringify(doc))))
  const negZero: string[] = []
  JSON.stringify(doc, (k, v) => {
    if (typeof v === "number" && Object.is(v, -0)) negZero.push(k)
    return v
  })
  expect(negZero).toEqual([])
}

describe("PB-5 global guard: no document value is null or a non-finite number (C-5, D7)", () => {
  test("PB-5.40: every fixture set, both producers", () => {
    for (const set of fixtureSets()) {
      if (set.startsWith("catalogue/")) continue
      const text = buildFromProto(loadSources(set), { includeImports: true, sourceMap: false })
      assertJsonSafe(text.document)
    }
    const { text, descriptor } = buildBoth("poc", { includeImports: true, sourceMap: false })
    assertJsonSafe(text.document)
    assertJsonSafe(descriptor.document)
  }, 30000)

  test("PB-5.41: every catalogue set (text) and its buf image (descriptor)", () => {
    const root = join(FIXTURES, "catalogue")
    for (const id of readdirSync(root)) {
      const sources = loadSources(`catalogue/${id}`)
      assertJsonSafe(buildFromProto(sources, { includeImports: true, sourceMap: false }).document)
      try {
        const image = loadImage(`catalogue/${id}`)
        assertJsonSafe(buildFromDescriptorSet(image, { includeImports: true, sourceMap: false }).document)
      } catch {
        // text-only set without an image
      }
    }
  })

  test("PB-5.42: the bundle and every inline case module, both producers", () => {
    assertJsonSafe(buildFromProto({ ...bundledFiles }, { includeImports: true, sourceMap: false }).document)
    const set = JSON.parse(readFileSync(join(IMAGES, "bundle.json"), "utf8"))
    assertJsonSafe(buildFromDescriptorSet(set, { includeImports: true, sourceMap: false }).document)
    const dir = join(import.meta.dirname, "cases")
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f === "types.ts" || f === "run.ts") continue
      const module = f.slice(0, -3)
      const { cases: list } = require(join(dir, f)) as { cases: Case[] }
      const oracles = loadOracles(module)
      for (const c of list) {
        assertJsonSafe(buildCase(c).document)
        const image = oracles[c.id]?.image
        if (image)
          assertJsonSafe(buildFromDescriptorSet(image as never, { entry: c.entry ?? Object.keys(c.sources) }).document)
      }
    }
  })
})

describe("PB-5 descriptor side of C-11 (option sets compiled against other definition versions)", () => {
  /** issues as `code @ pointer`, without the no-source-info of hand-written descriptors */
  const issuesOf = (r: { issues: { code: string; pointer?: string }[] }) =>
    r.issues.filter((i) => i.code !== "no-source-info").map((i) => `${i.code} @ ${i.pointer}`)
  test("PB-5.43: protovalidate before 1.0 (ignoreEmpty) from a descriptor: kept raw with unknown-option", () => {
    // the ProtoJSON a set compiled against protovalidate before 1.0 carries (`ignore_empty` was removed in 1.0; buf
    // rejects it against the bundled v1.2.2, so the descriptor is written by hand)
    const sources = {
      "a.proto":
        'syntax = "proto3";\npackage v;\nimport "buf/validate/validate.proto";\nmessage M {\n  string a = 1 [(buf.validate.field).string.min_len = 1];\n}\n',
    }
    const text = buildFromProto(sources)
    expect(text.issues).toEqual([])
    const set = {
      file: [
        {
          name: "a.proto",
          package: "v",
          dependency: ["buf/validate/validate.proto"],
          syntax: "proto3",
          messageType: [
            {
              name: "M",
              field: [
                {
                  name: "a",
                  number: 1,
                  label: "LABEL_OPTIONAL",
                  type: "TYPE_STRING",
                  jsonName: "a",
                  options: {
                    "[buf.validate.field]": { ignoreEmpty: true, string: { minLen: "1", legacyRule: { maxCount: 2 } } },
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const d = buildFromDescriptorSet(set)
    const a = d.document.components?.messages?.["v.M"]?.properties.a
    expect(a?.minLength).toBe(1)
    expect(a?.options).toEqual({
      "buf.validate.field": { string: { legacy_rule: { max_count: 2 } }, ignore_empty: true },
    })
    expect(issuesOf(d)).toEqual([
      "unknown-option @ #/components/messages/v.M/properties/a/options/buf.validate.field",
      "unknown-option @ #/components/messages/v.M/properties/a/options/buf.validate.field",
    ])
  })

  test("PB-5.44: the same legacy rule from text and from a descriptor gives the same document", () => {
    const text = buildFromProto({
      "a.proto":
        'syntax = "proto3";\npackage v;\nimport "buf/validate/validate.proto";\nmessage M {\n  string a = 1 [(buf.validate.field).ignore_empty = true, (buf.validate.field).string.min_len = 1];\n}\n',
    })
    const set = {
      file: [
        {
          name: "a.proto",
          package: "v",
          dependency: ["buf/validate/validate.proto"],
          syntax: "proto3",
          messageType: [
            {
              name: "M",
              field: [
                {
                  name: "a",
                  number: 1,
                  label: "LABEL_OPTIONAL",
                  type: "TYPE_STRING",
                  jsonName: "a",
                  options: { "[buf.validate.field]": { string: { minLen: "1" }, ignoreEmpty: true } },
                },
              ],
            },
          ],
        },
      ],
    }
    const d = buildFromDescriptorSet(set, { sourceMap: false })
    expect(d.document.components?.messages?.["v.M"]).toEqual(text.document.components?.messages?.["v.M"] as never)
    expect(issuesOf(d)).toEqual(issuesOf(text))
  })

  test("PB-5.45: an Any of an unknown type in a descriptor is kept with unknown-option", () => {
    const set = {
      file: [
        {
          name: "a.proto",
          package: "v",
          dependency: ["google/protobuf/any.proto", "google/protobuf/descriptor.proto"],
          syntax: "proto3",
          messageType: [
            { name: "M", options: { "[v.an]": { "@type": "type.googleapis.com/nope.Missing", someField: 1 } } },
          ],
          extension: [
            {
              name: "an",
              number: 50001,
              label: "LABEL_OPTIONAL",
              type: "TYPE_MESSAGE",
              typeName: ".google.protobuf.Any",
              extendee: ".google.protobuf.MessageOptions",
              jsonName: "an",
            },
          ],
        },
      ],
    }
    const d = buildFromDescriptorSet(set)
    expect(d.document.components?.messages?.["v.M"]?.options).toEqual({
      "v.an": { "@type": "type.googleapis.com/nope.Missing", some_field: 1 },
    })
    expect(issuesOf(d)).toEqual(["unknown-option @ #/components/messages/v.M/options/v.an"])
  })

  test("PB-5.51: a ProtoJSON Timestamp is RFC 3339; another date form is not read as one (kept as written)", () => {
    const values = [
      "2024-01-01T00:00:00.5+01:00",
      "0001-01-01T00:00:00Z",
      "2024-01-01",
      "2024-01-01T00:00:00",
      "Jan 1 2024",
    ]
    const set = {
      file: [
        {
          name: "a.proto",
          package: "v",
          dependency: ["google/protobuf/timestamp.proto", "google/protobuf/descriptor.proto"],
          syntax: "proto3",
          messageType: [{ name: "M", options: { "[v.ts]": values } }],
          extension: [
            {
              name: "ts",
              number: 50001,
              label: "LABEL_REPEATED",
              type: "TYPE_MESSAGE",
              typeName: ".google.protobuf.Timestamp",
              extendee: ".google.protobuf.MessageOptions",
              jsonName: "ts",
            },
          ],
        },
      ],
    }
    const d = buildFromDescriptorSet(set)
    expect(d.document.components?.messages?.["v.M"]?.options).toEqual({
      "v.ts": [{ seconds: "1704063600", nanos: 500000000 }, { seconds: "-62135596800" }, ...values.slice(2)],
    })
  })

  test("PB-5.52: an Any with a Timestamp or Duration that has no ProtoJSON form keeps the payload's fields", () => {
    // protobuf's ProtoJSON limits Timestamp to 0001-01-01..9999-12-31 with nanos 0..999999999, Duration to ±315576000000 s with nanos of its sign (buf accepts the text; only its JSON image fails)
    const any = (t: string, body: string) =>
      `  option (an) = { [type.googleapis.com/google.protobuf.${t}] { ${body} } };\n`
    const r = buildFromProto({
      "a.proto": `syntax = "proto3";\npackage v;\nimport "google/protobuf/any.proto";\nimport "google/protobuf/descriptor.proto";\nimport "google/protobuf/duration.proto";\nimport "google/protobuf/timestamp.proto";\nextend google.protobuf.MessageOptions { repeated google.protobuf.Any an = 50001; }\nmessage M {\n${[
        any("Timestamp", "seconds: 253402300799 nanos: 999999999"),
        any("Timestamp", "seconds: 253402300800"),
        any("Timestamp", "seconds: -62135596801"),
        any("Timestamp", "seconds: 100000000000000"),
        any("Timestamp", "seconds: 1 nanos: -1"),
        any("Duration", "seconds: -315576000000"),
        any("Duration", "seconds: 315576000001"),
        any("Duration", "seconds: 1 nanos: -1"),
      ].join("")}}\n`,
    })
    expect(r.issues).toEqual([])
    const T = "type.googleapis.com/google.protobuf.Timestamp"
    const D = "type.googleapis.com/google.protobuf.Duration"
    expect(r.document.components?.messages?.["v.M"]?.options).toEqual({
      "v.an": [
        { "@type": T, value: "9999-12-31T23:59:59.999999999Z" },
        { "@type": T, seconds: "253402300800" },
        { "@type": T, seconds: "-62135596801" },
        { "@type": T, seconds: "100000000000000" },
        { "@type": T, seconds: "1", nanos: -1 },
        { "@type": D, value: "-315576000000s" },
        { "@type": D, seconds: "315576000001" },
        { "@type": D, seconds: "1", nanos: -1 },
      ],
    })
  })

  test('PB-5.46: F-2: a descriptor that carries a negative zero option value (ProtoJSON -0) gives "-0"', () => {
    const set = {
      file: [
        {
          name: "a.proto",
          package: "v",
          dependency: ["google/protobuf/descriptor.proto"],
          syntax: "proto2",
          messageType: [{ name: "M", options: { "[v.d]": -0, "[v.f]": "-0" } }],
          extension: ["d", "f"].map((name, i) => ({
            name,
            number: 50001 + i,
            label: "LABEL_OPTIONAL",
            type: name === "d" ? "TYPE_DOUBLE" : "TYPE_FLOAT",
            extendee: ".google.protobuf.MessageOptions",
            jsonName: name,
          })),
        },
      ],
    }
    const d = buildFromDescriptorSet(JSON.parse(JSON.stringify(set).replace('"[v.d]":0', '"[v.d]":-0')))
    expect(d.document.components?.messages?.["v.M"]?.options).toEqual({ "v.d": "-0", "v.f": "-0" })
  })
})
