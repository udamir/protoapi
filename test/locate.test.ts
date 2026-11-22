// PB-6: source map pointers, locatePointer, locateDiff (design §9; validation L-1 … L-4, phase D).
//
// PB-6.5 … PB-6.9 are inline cases with a buf oracle (test/cases/sourcemap.ts): both producers give the same pointers
// and spans. PB-6.10 … run the locateDiff rules with diffs in api-smart-diff 2.0's shape (`Diff.path` holds the before
// keys; a rename's path is the container, `before` / `after` the old and new key).

import { describe, expect, test } from "bun:test"
import { buildFromDescriptorSet, buildFromProto, locateDiff, locatePointer } from "../src"
import type { SourceMap } from "../src"
import { describeCases, loadOracles } from "./cases/run"
import { SM_PROTO2, SM_REQUIRED, cases, find } from "./cases/sourcemap"

const SRC = [
  'syntax = "proto3";',
  "package shop.v1;",
  "message Pet {",
  '  int64 id = 1 [json_name = "petId"];',
  "  reserved 5, 7 to 9;",
  "}",
].join("\n")

const fmt = (l: { start: { line: number; column: number }; end: { line: number; column: number } } | undefined) =>
  l && `${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}`

describe("PB-6 source map", () => {
  const { sourceMap } = buildFromProto({ "shop.proto": SRC })

  test("PB-6.1: EX-SRC-1 pointer spans", () => {
    const at = (p: string) => fmt(sourceMap[p])
    expect(at("#/files/shop.proto/syntax")).toBe("0:0-0:18")
    expect(at("#/files/shop.proto/package")).toBe("1:0-1:16")
    expect(at("#/components/messages/shop.v1.Pet")).toBe("2:0-5:1")
    expect(at("#/components/messages/shop.v1.Pet/properties/id")).toBe("3:2-3:37")
    expect(at("#/components/messages/shop.v1.Pet/properties/id/type")).toBe("3:2-3:7")
    expect(at("#/components/messages/shop.v1.Pet/properties/id/number")).toBe("3:13-3:14")
    expect(at("#/components/messages/shop.v1.Pet/properties/id/jsonName")).toBe("3:16-3:35")
  })

  test("PB-6.2: locatePointer falls back to the nearest ancestor; pointers without `#` are accepted", () => {
    const loc = locatePointer("#/components/messages/shop.v1.Pet/properties/id/maximum", sourceMap)
    expect(loc?.start.line).toBe(3)
    expect(locatePointer("/components/messages/shop.v1.Pet/properties/id", sourceMap)?.start).toEqual({
      line: 3,
      column: 2,
    })
    expect(locatePointer("components/messages/shop.v1.Pet/properties/id", sourceMap)?.start).toEqual({
      line: 3,
      column: 2,
    })
    expect(locatePointer("#/components/messages/Missing", sourceMap)).toBeUndefined()
  })

  test("PB-6.3: locateDiff: replace -> after map, add of a reserved index -> the written range, remove -> before map", () => {
    const before = sourceMap
    const after = buildFromProto({ "shop.proto": SRC.replace("int64 id = 1", "int64 id = 2") }).sourceMap
    const replace = locateDiff(
      { action: "replace", path: ["components", "messages", "shop.v1.Pet", "properties", "id", "number"] },
      before,
      after,
    )
    expect(replace?.start).toEqual({ line: 3, column: 13 })
    const reserved = locateDiff(
      { action: "add", path: ["components", "messages", "shop.v1.Pet", "reserved", "numbers", 1] },
      before,
      after,
    )
    expect(fmt(reserved)).toBe("4:14-4:20")
    const removed = locateDiff(
      { action: "remove", path: ["components", "messages", "shop.v1.Pet", "properties", "id"] },
      before,
      {},
    )
    expect(removed?.start.line).toBe(3)
  })

  test("PB-6.4: sourceMap: false gives an empty map", () => {
    expect(buildFromProto({ "shop.proto": SRC }, { sourceMap: false }).sourceMap).toEqual({})
  })
})

describeCases("PB-6 source map (buf oracle)", "sourcemap", cases)

describe("PB-6 locateDiff rules", () => {
  const P = ["components", "messages", "sm.Pet"]
  const map = buildFromProto({ "sm.proto": SM_PROTO2 }).sourceMap
  const T = SM_PROTO2
  const loc = (diff: Parameters<typeof locateDiff>[0], before: SourceMap = map, after: SourceMap = map) =>
    fmt(locateDiff(diff, before, after))

  test("PB-6.10: L-1 rename in api-smart-diff 2.0's shape: path = container, after = the new key", () => {
    const before = buildFromProto({ "sm.proto": T.replace("required string name", "required string label") }).sourceMap
    const renamed = { action: "rename", path: [...P, "properties"], before: "label", after: "name" }
    expect(loc(renamed, before, map)).toBe(fmt(map["#/components/messages/sm.Pet/properties/name"]))
    // the new key is missing from the after map: the before map at the old key
    expect(loc(renamed, before, {})).toBe(fmt(before["#/components/messages/sm.Pet/properties/label"]))
    // a renamed message
    const msg = { action: "rename", path: ["components", "messages"], before: "sm.Old", after: "sm.Pet" }
    expect(loc(msg)).toBe(fmt(map["#/components/messages/sm.Pet"]))
  })

  test("PB-6.11: S1: a `required` keyword diff locates its keyword entry; no index rule for a message `required`", () => {
    const rq = buildFromProto({ "rq.proto": SM_REQUIRED }).sourceMap
    const R = ["components", "messages", "rq.M"]
    const at = (diff: Parameters<typeof locateDiff>[0]) => fmt(locateDiff(diff, rq, rq))
    expect(at({ action: "add", path: [...R, "properties", "c", "required"], after: true })).toBe(
      find(SM_REQUIRED, 12, "(google.api.field_behavior) = REQUIRED"),
    )
    expect(at({ action: "remove", path: [...R, "properties", "a", "required"], before: true })).toBe(
      find(SM_REQUIRED, 8, "// @Required"),
    )
    // the 0.1.0 rule (an index into the message's `required[]` -> the named field) is gone: nearest ancestor
    expect(loc({ action: "add", path: [...P, "required", 0], after: "name" })).toBe(
      fmt(map["#/components/messages/sm.Pet"]),
    )
  })

  test("PB-6.12: L-2 reserved numbers, names and extensions indices (also inside an interval)", () => {
    expect(loc({ action: "add", path: [...P, "reserved", "numbers", 1] })).toBe(find(T, 17, "20 to 30"))
    expect(loc({ action: "replace", path: [...P, "reserved", "numbers", 1, 1], before: 29, after: 30 })).toBe(
      find(T, 17, "20 to 30"),
    )
    expect(loc({ action: "add", path: [...P, "reserved", "names", 1], after: "foo" })).toBe(find(T, 19, '"foo"'))
    expect(loc({ action: "add", path: [...P, "extensions", 1] })).toBe(find(T, 21, "300 to 399"))
    // an index the map does not have: the first statement
    expect(loc({ action: "add", path: [...P, "reserved", "numbers", 9] })).toBe(find(T, 17, "reserved 10, 20 to 30;"))
    expect(loc({ action: "add", path: [...P, "extensions", 9] })).toBe(find(T, 20, "extensions 100 to 199;"))
  })

  test("PB-6.13: L-4 a $ref leaf locates the type name: field, items, additionalProperties, method request", () => {
    expect(loc({ action: "replace", path: [...P, "properties", "kids", "items", "$ref"] })).toBe(find(T, 11, "Pet"))
    expect(loc({ action: "replace", path: [...P, "properties", "by_name", "additionalProperties", "$ref"] })).toBe(
      find(T, 12, "map<string, Pet>"),
    )
    expect(
      loc({ action: "replace", path: ["services", "sm.Svc", "methods", "Get", "request", "schema", "$ref"] }),
    ).toBe(find(T, 26, "Pet"))
    expect(loc({ action: "replace", path: ["components", "extensions", "sm.tagged", "$ref"] })).toBe(
      find(T, 24, "int32"),
    )
  })

  test("PB-6.14: L-3 keyword diffs locate the option statement or the tag line", () => {
    expect(loc({ action: "add", path: [...P, "properties", "id", "minimum"], after: 1 })).toBe(
      find(T, 8, "// @Minimum 1"),
    )
    expect(loc({ action: "replace", path: [...P, "properties", "id", "exclusiveMaximum"] })).toBe(
      find(T, 9, "(buf.validate.field).int32.lt = 10"),
    )
    // a keyword without an entry: the nearest ancestor (the field)
    expect(loc({ action: "add", path: [...P, "properties", "name", "maxLength"] })).toBe(
      fmt(map["#/components/messages/sm.Pet/properties/name"]),
    )
  })

  test("PB-6.15: Diff.origin replaces the path; add / replace fall back to the before map; file keys are escaped", () => {
    const origin = {
      action: "replace",
      path: ["components", "messages", "x.Use", "properties", "pet", "number"],
      origin: { before: [...P, "properties", "id", "number"], after: [...P, "properties", "id", "number"] },
    }
    expect(loc(origin)).toBe(find(T, 9, "1"))
    // below a renamed ancestor `path` holds the before keys: the after map has no entry, the before map has
    expect(loc({ action: "add", path: [...P, "properties", "id", "number"] }, map, {})).toBe(find(T, 9, "1"))
    const m2 = buildFromProto({ "dir/a~b.proto": 'syntax = "proto3";\npackage p;\n' }).sourceMap
    expect(fmt(locateDiff({ action: "replace", path: ["files", "dir/a~b.proto", "package"] }, m2, m2))).toBe("1:0-1:10")
  })

  test("PB-6.16: no-source-info: a descriptor set without SourceCodeInfo gives an empty map and an issue", () => {
    const image = loadOracles("sourcemap")["PB-6.5"].image as { file: Record<string, unknown>[] }
    const bare = { file: image.file.map(({ sourceCodeInfo: _, ...f }) => f) }
    const r = buildFromDescriptorSet(bare)
    expect(r.sourceMap).toEqual({})
    expect(r.issues.map((i) => i.code)).toEqual(["no-source-info"])
    expect(locateDiff({ action: "add", path: [...P, "properties", "id"] }, r.sourceMap, r.sourceMap)).toBeUndefined()
    // the declarations are all there; comments (descriptions, tags) live in SourceCodeInfo and are gone
    const full = buildFromDescriptorSet(image).document
    expect(Object.keys(r.document.components?.messages?.["sm.Pet"].properties ?? {})).toEqual(
      Object.keys(full.components?.messages?.["sm.Pet"].properties ?? {}),
    )
    expect(r.document.components?.messages?.["sm.Pet"].description).toBeUndefined()
  })

  test("PB-6.17: wrong argument types are a TypeError (decision 15)", () => {
    expect(() => locatePointer(5 as never, map)).toThrow(TypeError)
    expect(() => locatePointer("#/x", null as never)).toThrow(TypeError)
    expect(() => locateDiff({ action: "add" } as never, map, map)).toThrow(TypeError)
    expect(() => locateDiff({ action: "add", path: [] }, map, "x" as never)).toThrow(TypeError)
  })
})
