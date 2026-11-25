import { describe, expect, test } from "vite-plus/test"
import type { BuildIssue } from "../../src/index.ts"
import { formatPointer, matchFragment, matchIssues, parsePointer, resolvePointer } from "./match.ts"

describe("catalogue matcher", () => {
  test("pointers use RFC 6901 escaping", () => {
    expect(parsePointer("#/files/google~1protobuf~1any.proto/options")).toEqual([
      "files",
      "google/protobuf/any.proto",
      "options",
    ])
    expect(parsePointer("#")).toEqual([])
    expect(formatPointer(["files", "a/b~c.proto"])).toBe("#/files/a~1b~0c.proto")
    expect(resolvePointer({ a: [{ b: 1 }] }, "#/a/0/b")).toBe(1)
    expect(resolvePointer({ a: {} }, "#/a/x")).toBeUndefined()
  })

  test("objects match exactly, ignoring key order", () => {
    expect(matchFragment({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([])
    expect(matchFragment({ a: 1, b: 2 }, { a: 1 })).toEqual(["#/b: unexpected key, value 2"])
    expect(matchFragment({ a: 1 }, { a: 1, b: 2 })).toEqual(["#/b: missing, expected 2"])
    expect(matchFragment({ a: "1" }, { a: 1 })).toEqual(['#/a: expected 1, got "1"'])
  })

  test("the … key opens an object and the … value matches anything present", () => {
    expect(matchFragment({ a: 1, b: 2 }, { a: 1, "…": null })).toEqual([])
    expect(matchFragment({ a: 1, d: "x" }, { a: 1, d: "…" })).toEqual([])
    expect(matchFragment({ a: 1 }, { a: 1, d: "…" })).toEqual(['#/d: missing, expected "…"'])
  })

  test("title and file may be omitted on components only", () => {
    const msg = { title: "Pet", file: "shop.proto", type: "object", properties: { id: { number: 1, title: "x" } } }
    expect(
      matchFragment(msg, { type: "object", properties: { id: { number: 1, title: "x" } } }, [
        "components",
        "messages",
        "shop.v1.Pet",
      ]),
    ).toEqual([])
    expect(
      matchFragment(
        { "shop.v1.Pet": msg },
        { "shop.v1.Pet": { type: "object", properties: { id: { number: 1, title: "x" } } } },
        ["components", "messages"],
      ),
    ).toEqual([])
    expect(
      matchFragment({ number: 1, title: "x" }, { number: 1 }, ["components", "messages", "M", "properties", "id"]),
    ).toEqual(['#/components/messages/M/properties/id/title: unexpected key, value "x"'])
  })

  test("ignoreKeys allows extra keys anywhere below", () => {
    expect(
      matchFragment({ a: { description: "d", b: 1 } }, { a: { b: 1 } }, [], { ignoreKeys: ["description"] }),
    ).toEqual([])
  })

  test("arrays match in order", () => {
    expect(matchFragment([1, 2], [1, 2])).toEqual([])
    expect(matchFragment([2, 1], [1, 2]).length).toBe(2)
    expect(matchFragment([1], [1, 2])).toEqual(["#: expected 2 items, got 1: [1]"])
  })

  test("issue specs are an exact multiset", () => {
    const loc = { file: "b.proto", start: { line: 2, column: 0 }, end: { line: 2, column: 5 } }
    const issues: BuildIssue[] = [
      { code: "unresolved-type", message: "", pointer: "#/components/messages/M/properties/f" },
      { code: "duplicate-name", message: "", pointer: "#/components/messages/M", location: loc },
      { code: "syntax", message: "" },
    ]
    expect(
      matchIssues(issues, [
        "unresolved-type @ #/components/messages/M/properties/f",
        "duplicate-name @ #/components/messages/M at b.proto:2:0",
        "syntax @ *",
      ]),
    ).toEqual([])
    expect(matchIssues(issues.slice(0, 1), ["unresolved-type @ #/components/messages/M/**"])).toEqual([])
    expect(matchIssues(issues.slice(1, 2), ["duplicate-name @ #/components/messages/M at b.proto:3:0"])).toHaveLength(2)
    expect(matchIssues([], ["syntax @ *"])).toEqual(["missing issue: syntax @ *"])
  })
})
