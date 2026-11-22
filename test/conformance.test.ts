// PB-2: buildFromProto ≡ buildFromDescriptorSet(buf image) as JSON text, source maps equal (design §13). The builds use the default emission mode `imports: "user"` (U3) unless a test names another.

import { describe, expect, test } from "vite-plus/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildFromDescriptorSet, buildFromProto, bundledFiles } from "../src/index.ts"
import { IMAGES, buildBoth, fixtureSets, jsonDiff } from "./helpers.ts"

/** Document text and source map of both producers are equal, neither reports an issue. */
const conformant = (set: string) => {
  const { text, descriptor } = buildBoth(set)
  expect({ set, diff: jsonDiff(text.document, descriptor.document) }).toEqual({ set, diff: [] })
  expect(JSON.stringify(text.document)).toBe(JSON.stringify(descriptor.document))
  expect({ set, sourceMap: jsonDiff(text.sourceMap, descriptor.sourceMap) }).toEqual({ set, sourceMap: [] })
  expect({ set, issues: [...text.issues, ...descriptor.issues] }).toEqual({ set, issues: [] })
}

describe("PB-2 conformance", () => {
  test("PB-2.1: PoC fixtures (proto2, proto3, editions, custom options)", () => {
    const { text, descriptor } = buildBoth("poc")
    expect(jsonDiff(text.document, descriptor.document)).toEqual([])
    expect(JSON.stringify(text.document)).toBe(JSON.stringify(descriptor.document))
    expect(jsonDiff(text.sourceMap, descriptor.sourceMap)).toEqual([])
    expect(text.issues).toEqual([])
    expect(descriptor.issues).toEqual([])
  })

  // U3: every file is a source (text) or a non-import set file (descriptors), so every file is an entry, none is marked and "user" equals "all"; both modes are checked
  test("PB-2.2: every bundled file (descriptor.proto, googleapis, protovalidate, PGV, grpc-gateway)", () => {
    const set = JSON.parse(readFileSync(join(IMAGES, "bundle.json"), "utf8"))
    for (const options of [{ imports: "all" as const }, {}]) {
      const text = buildFromProto({ ...bundledFiles }, options)
      const descriptor = buildFromDescriptorSet(set, options)
      expect(jsonDiff(text.document, descriptor.document)).toEqual([])
      expect(JSON.stringify(text.document)).toBe(JSON.stringify(descriptor.document))
      expect(jsonDiff(text.sourceMap, descriptor.sourceMap)).toEqual([])
      expect(Object.keys(text.sourceMap).length).toBeGreaterThan(4000)
      expect(text.issues).toEqual([])
      expect(Object.values(text.document.files ?? {}).some((f) => f.bundled)).toBe(false)
    }
  })

  test("PB-2.4: googleapis corpus (pubsub, compute 3.9 MB, storage, secretmanager, iam, longrunning)", () => {
    const { text, descriptor } = buildBoth("googleapis")
    expect(JSON.stringify(text.document)).toBe(JSON.stringify(descriptor.document))
    expect(jsonDiff(text.sourceMap, descriptor.sourceMap)).toEqual([])
    // decision 8 (phase C): compute.proto writes `@pattern` with the regex on the next line and `@required <methods>`;
    // an empty value tag and a boolean tag with another value are invalid tags (both producers)
    const tags = [
      "#/components/messages/google.cloud.compute.v1.InstanceGroupManager/properties/base_instance_name",
      "#/components/messages/google.cloud.compute.v1.InstanceReference/properties/instance",
    ]
    for (const r of [text, descriptor]) {
      expect(r.issues.map((i) => `${i.code} @ ${i.pointer}`)).toEqual(tags.map((p) => `invalid-tag @ ${p}`))
    }
  }, 30000)

  test("PB-2.3: input order does not change the document", () => {
    const sources = { ...bundledFiles }
    const reversed = Object.fromEntries(Object.entries(sources).reverse())
    const a = buildFromProto(sources, { includeImports: true, sourceMap: false })
    const b = buildFromProto(reversed, { includeImports: true, sourceMap: false })
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document))
  })

  test("PB-2.5: the named fixtures of design §13 (http, validate, edition2024, comments, names, values)", () => {
    const sets = fixtureSets().filter((s) => s.startsWith("named/") && !s.startsWith("named/comments-"))
    expect(sets).toEqual([
      "named/comments",
      "named/edition2024",
      "named/http",
      "named/names",
      "named/validate",
      "named/values",
    ])
    for (const set of sets) conformant(set)
  })

  test("PB-2.6: the buf breaking corpus (bufbuild/buf v1.75.0 testdata, 118 modules)", () => {
    const sets = fixtureSets().filter((s) => s.startsWith("buf-breaking/"))
    expect(sets.length).toBe(118)
    for (const set of sets) conformant(set)
  }, 30000)

  // Final cleanup: a block comment that ends on the line of the element's first token (`/* @Minimum 1 */ int32 legs = 7;`) leads nothing, in buf 1.75 and in the text producer, so `minimum` is lifted by neither.
  test("PB-2.7: a block comment on the same line before an element attaches to nothing", () => {
    conformant("named/comments-same-line")
    const { text } = buildBoth("named/comments-same-line")
    const legs = text.document.components?.messages?.["named.comments.sameline.Pet"]?.properties?.legs
    expect(legs).toEqual({ type: "int32", number: 7 })
  })

  // Q0-P phase C (IN-10): the layouts in which protoc and buf 1.75 attach comments differently follow buf; each fixture's header names the layout and protoc's attachment
  const pet = (set: string, pkg: string) =>
    buildBoth(set).text.document.components?.messages?.[`named.comments.${pkg}.Pet`]
  test("PB-2.8: a block comment after `;` and a newline leads the next declaration", () => {
    conformant("named/comments-block-after-decl")
    const properties = pet("named/comments-block-after-decl", "blockafterdecl")?.properties
    expect(properties?.age).toEqual({ number: 6, type: "int32" })
    expect(properties?.legs).toEqual({ number: 7, type: "int32", minimum: 1 })
  })
  test("PB-2.9: a block comment and a `//` comment after `;`: the block comment trails, the `//` comment leads the next", () => {
    conformant("named/comments-block-then-line")
    const properties = pet("named/comments-block-then-line", "blockthenline")?.properties
    expect(properties?.age?.description).toBe("Age in years.")
    expect(properties?.legs?.description).toBe("Number of legs.")
  })
  test("PB-2.10: a block comment before `}` on the same line trails the block or the last declaration", () => {
    conformant("named/comments-block-in-empty-body")
    const d = buildBoth("named/comments-block-in-empty-body").text.document
    expect(d.components?.messages?.["named.comments.blockinemptybody.Empty"]?.description).toBe("Carries no data.")
    const values = d.components?.enums?.["named.comments.blockinemptybody.Status"]?.values
    expect(values?.STATUS_UNSPECIFIED).toEqual({ description: "The default.", number: 0 })
    expect(d.services?.["named.comments.blockinemptybody.PetService"]?.description).toBe("No methods yet.")
  })
  test("PB-2.11: a multi-line block comment starting after `;` leads the next declaration", () => {
    conformant("named/comments-multiline-block-after-decl")
    const properties = pet("named/comments-multiline-block-after-decl", "multilineblockafterdecl")?.properties
    expect(properties?.age?.description).toBeUndefined()
    expect(properties?.legs?.description).toBe("Number of legs,\ncounted at birth.")
  })
  test("PB-2.12: a block comment after `}` and a newline leads the next declaration", () => {
    conformant("named/comments-block-after-close")
    const p = pet("named/comments-block-after-close", "blockafterclose")
    expect(p?.description).toBe("A pet.")
    expect(p?.properties?.kind?.description).toBe("The kind of pet.")
  })
  test("PB-2.13: a group after a same-line trailing comment and before a blank line is attached to nothing", () => {
    conformant("named/comments-after-trailing")
    const properties = pet("named/comments-after-trailing", "aftertrailing")?.properties
    expect(properties?.age?.description).toBe("Age in years.")
    expect(properties?.legs?.description).toBe("Number of legs.")
  })
  test("PB-2.14: comments after the last token of a file are attached to nothing", () => {
    conformant("named/comments-at-eof")
  })
  test("PB-2.15: the differential comment fuzz (scripts/comment-fuzz.ts, seed 1, every layout)", () => {
    conformant("named/comments-fuzz")
  })
})
