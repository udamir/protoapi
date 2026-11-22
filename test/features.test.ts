// F-3 resolved features (validation decision F-3) across proto2, proto3 and editions 2023 / 2024 / 2026, against
// the buf oracle (cases in test/cases/features.ts); syntax migrations that now diff clean on the resolved keywords;
// printer round trips of the new keywords (packed, utf8Validation, jsonFormat, extensionOptions).

import { describe, expect, test } from "bun:test"
import { buildFromProto, printProto } from "../src"
import type { ProtoApiDocument, ProtoSources } from "../src"
import { describeCases } from "./cases/run"
import { cases } from "./cases/features"
import { jsonDiff, loadSources } from "./helpers"

describeCases("F-3 resolved features", "features", cases)

const build = (sources: ProtoSources) => buildFromProto(sources, { sourceMap: false })

describe("F-3 syntax migrations diff clean on the resolved keywords", () => {
  test("FEAT-11: EX-MIG-2 proto2 -> edition 2023: components are identical", () => {
    const before = build(loadSources("catalogue/EX-MIG-2.before"))
    const after = build(loadSources("catalogue/EX-MIG-2.after"))
    expect(after.issues).toEqual([])
    expect(jsonDiff(before.document.components, after.document.components)).toEqual([])
  })

  test("FEAT-12: EX-MIG-1 proto3 -> edition 2023: components are identical", () => {
    const before = build(loadSources("catalogue/EX-MIG-1.before"))
    const after = build(loadSources("catalogue/EX-MIG-1.after"))
    expect(jsonDiff(before.document.components, after.document.components)).toEqual([])
  })

  test("FEAT-13: proto2 -> 2023 without utf8_validation = NONE is a field-level change", () => {
    const p2 = build({ "a.proto": 'syntax = "proto2";\npackage m;\nmessage M { optional string s = 1; }\n' })
    const ed = build({
      "a.proto":
        'edition = "2023";\npackage m;\noption features.json_format = LEGACY_BEST_EFFORT;\nmessage M { string s = 1; }\n',
    })
    expect(jsonDiff(p2.document.components, ed.document.components)).toEqual([
      "/messages/m.M/properties/s/utf8Validation: false !== undefined",
    ])
  })
})

/** build(print(build(x))) ≡ build(x) */
const roundTrip = (
  sources: ProtoSources,
): { diff: string[]; printed: Record<string, string>; doc: ProtoApiDocument } => {
  const first = build(sources)
  const printed = printProto(first.document)
  const second = buildFromProto(printed, { sourceMap: false, entry: Object.keys(sources) })
  expect(second.issues).toEqual([])
  return { diff: jsonDiff(first.document, second.document), printed, doc: first.document }
}

describe("F-3 / F-1 printer round trips", () => {
  const MESSAGES = () =>
    "message M {\n  repeated int32 ints = 1;\n  repeated string strs = 2;\n  map<string, string> both = 3;\n  map<int32, string> value = 4;\n}\nenum E { E_UNSPECIFIED = 0; }\n"

  test("FEAT-14: proto2 (absent packed prints [packed = true])", () => {
    const { diff, printed } = roundTrip({
      "a.proto": `syntax = "proto2";\npackage r;\n${MESSAGES()}message P { repeated int32 p = 1 [packed = true]; }\n`,
    })
    expect(diff).toEqual([])
    expect(printed["a.proto"]).toContain("repeated int32 p = 1 [packed = true];")
    expect(printed["a.proto"]).not.toContain("utf8_validation")
  })

  test("FEAT-15: proto3 (packed: false prints [packed = false])", () => {
    const { diff, printed } = roundTrip({
      "a.proto": `syntax = "proto3";\npackage r;\n${MESSAGES()}message P { repeated int32 p = 1 [packed = false]; }\n`,
    })
    expect(diff).toEqual([])
    expect(printed["a.proto"]).toContain("repeated int32 p = 1 [packed = false];")
  })

  for (const edition of ["2023", "2024", "2026"]) {
    test(`FEAT-16.${edition}: edition ${edition} (features on the element)`, () => {
      const { diff, printed } = roundTrip({
        "a.proto": `edition = "${edition}";\npackage r;\noption features.repeated_field_encoding = EXPANDED;\noption features.utf8_validation = NONE;\noption features.json_format = LEGACY_BEST_EFFORT;\n${MESSAGES()}message P {\n  option features.json_format = ALLOW;\n  repeated int32 p = 1 [features.repeated_field_encoding = PACKED];\n  string s = 2 [features.utf8_validation = VERIFY];\n}\n`,
      })
      expect(diff).toEqual([])
      const text = printed["a.proto"]
      expect(text).toContain("repeated int32 ints = 1 [features.repeated_field_encoding = EXPANDED];")
      expect(text).toContain("map<string, string> both = 3 [features.utf8_validation = NONE];")
      expect(text).toContain("option features.json_format = LEGACY_BEST_EFFORT;")
      expect(text).toContain("repeated int32 p = 1;")
    })
  }

  test("FEAT-17: extension-range options (F-1) and negative zero (F-2) round trip", () => {
    const { diff, printed } = roundTrip({
      "a.proto": `syntax = "proto2";\npackage r;\nimport "google/protobuf/descriptor.proto";\nextend google.protobuf.ExtensionRangeOptions { optional int32 note = 50001; }\nextend google.protobuf.MessageOptions { optional double z = 50002; }\nmessage M {\n  option (z) = -0.0;\n  optional float f = 1 [default = -0];\n  extensions 100 to 199 [verification = UNVERIFIED];\n  extensions 200 to 299;\n  extensions 300 to max [(note) = 3];\n}\n`,
    })
    expect(diff).toEqual([])
    expect(printed["a.proto"]).toContain("extensions 100 to 199 [verification = UNVERIFIED];")
    expect(printed["a.proto"]).toContain("extensions 200 to 299;")
    expect(printed["a.proto"]).toContain("extensions 300 to max [(r.note) = 3];")
  })
})
