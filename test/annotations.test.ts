// PB-3 annotation layer (design §3.8, D13, D14; validation A-1 … A-15, agent-decided items 4–10) against the buf
// oracle; cases in test/cases/annotations.ts.

import { describe, expect, test } from "vite-plus/test"
import { buildFromProto } from "../src/index.ts"
import { liftGoogleApi } from "../src/conventions/google-api.ts"
import type { Candidate } from "../src/conventions/types.ts"
import { cases } from "./cases/annotations.ts"
import { describeCases } from "./cases/run.ts"

describeCases("PB-3 annotation layer", "annotations", cases)

describe("PB-3 annotation modes", () => {
  const sources = {
    "t.proto": `syntax = "proto3";
package t;
import "buf/validate/validate.proto";
message M {
  // Required. Text.
  // @MaxLength 9
  // @Title T
  string a = 1 [(buf.validate.field).string.max_len = 5];
  // @Bogus 1
  // @MinLength abc
  string b = 2;
}
`,
  }

  test('PB-3.19: annotations "options" reads no tags or prefixes (no invalid-tag, no conflicts)', () => {
    const r = buildFromProto(sources, { annotations: "options" })
    const p = r.document.components?.messages?.["t.M"]?.properties
    expect(p?.a).toEqual({
      description: "Required. Text.\n@MaxLength 9\n@Title T",
      number: 1,
      type: "string",
      maxLength: 5,
    })
    expect(r.issues).toEqual([])
  })

  test('PB-3.20: annotations "none" lifts no convention option', () => {
    const r = buildFromProto(sources, { annotations: "none" })
    const a = r.document.components?.messages?.["t.M"]?.properties.a
    expect(a?.maxLength).toBeUndefined()
    expect(a?.options).toEqual({ "buf.validate.field": { string: { max_len: "5" } } })
    expect(r.issues).toEqual([])
  })

  test("PB-3.21: an unknown @tag stays in the description; an invalid known tag is removed and reported", () => {
    const r = buildFromProto(sources)
    const b = r.document.components?.messages?.["t.M"]?.properties.b
    expect(b?.description).toBe("@Bogus 1")
    expect(r.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([
      "annotation-conflict: field a: maxLength from buf.validate (5) is kept, tag (9) is dropped",
      "invalid-tag: invalid comment tag @MinLength abc: a non-negative integer is expected (field b)",
    ])
  })
})

describe("PB-3 google.api field_info", () => {
  test("a field_info.format named like an Object.prototype key is not a format (it stays under options)", () => {
    for (const format of ["constructor", "toString", "__proto__", "IPV4"]) {
      const options: Record<string, unknown> = { "google.api.field_info": { format } }
      const out: Candidate[] = []
      liftGoogleApi(options, { self: { scalar: "string" } }, out)
      if (format === "IPV4") {
        expect(out).toEqual([{ target: "", keyword: "format", value: "ipv4", source: "google.api" }])
        expect(options).toEqual({})
      } else {
        expect(out).toEqual([])
        expect(options).toEqual({ "google.api.field_info": { format } })
      }
    }
  })
})
