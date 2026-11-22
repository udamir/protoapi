// F-3 resolved features (validation decision F-3): `packed: false`, `utf8Validation: false` and `jsonFormat` written from
// the resolved features against the fixed modern baseline (proto3 / editions defaults are not written), across proto2,
// proto3 and editions 2023 / 2024 / 2026, with file -> message -> oneof -> field inheritance. `options` no longer
// carries `packed`, `features.repeated_field_encoding`, `features.utf8_validation` or `features.json_format`. Also the
// LEGACY_REQUIRED oneof guard. buf 1.75 is the oracle.

import type { Case } from "./types.ts"

type Doc = {
  files?: Record<string, { options?: Record<string, unknown> }>
  components?: {
    messages?: Record<string, Record<string, unknown>>
    enums?: Record<string, Record<string, unknown>>
    extensions?: Record<string, Record<string, unknown>>
  }
}
const msg = (d: unknown, fqn: string) => (d as Doc).components?.messages?.[fqn] as Record<string, unknown>
const props = (d: unknown, fqn: string) => msg(d, fqn)?.properties as Record<string, Record<string, unknown>>
const en = (d: unknown, fqn: string) => (d as Doc).components?.enums?.[fqn] as Record<string, unknown>

/** The resolved keywords of every field of a message: [packed, utf8Validation of field / items / key / value]. */
const keywords = (d: unknown, fqn: string) =>
  Object.fromEntries(
    Object.entries(props(d, fqn)).map(([k, f]) => {
      const sub = (x: unknown) => (x as { utf8Validation?: boolean } | undefined)?.utf8Validation
      return [
        k,
        [f.packed, f.utf8Validation ?? sub(f.items) ?? sub(f.propertyNames) ?? sub(f.additionalProperties), f.options],
      ]
    }),
  )

/** the same message body in every syntax */
const BODY = `message M {
  repeated int32 ints = 1;
  repeated E enums = 2;
  repeated string strs = 3;
  repeated bytes raw = 4;
  map<string, string> both = 5;
  map<int32, string> value = 6;
  map<string, int32> key = 7;
  STRING_FIELD
  message Inner { STRING_FIELD }
  enum Nested { NESTED_UNSPECIFIED = 0; }
}
enum E { E_UNSPECIFIED = 0; }
`
const body = (stringField: string) => BODY.split("STRING_FIELD").join(stringField)

export const cases: Case[] = [
  {
    id: "FEAT-1",
    title:
      "proto2: packable repeated fields are packed: false, strings utf8Validation: false, messages and enums LEGACY_BEST_EFFORT",
    sources: { "a.proto": `syntax = "proto2";\npackage f;\n${body("optional string s = 8;")}` },
    check: (r, x) => {
      x(keywords(r.document, "f.M")).toEqual({
        ints: [false, undefined, undefined],
        enums: [false, undefined, undefined],
        strs: [undefined, false, undefined],
        raw: [undefined, undefined, undefined],
        both: [undefined, false, undefined],
        value: [undefined, false, undefined],
        key: [undefined, false, undefined],
        s: [undefined, false, undefined],
      })
      const both = props(r.document, "f.M").both
      x([both.propertyNames, both.additionalProperties]).toEqual([
        { type: "string", protoType: "string", utf8Validation: false },
        { type: "string", protoType: "string", utf8Validation: false },
      ])
      x(props(r.document, "f.M").value.propertyNames).toEqual({ type: "integer", protoType: "int32" })
      for (const m of ["f.M", "f.M.Inner"]) x(msg(r.document, m).jsonFormat).toBe("LEGACY_BEST_EFFORT")
      for (const e of ["f.E", "f.M.Nested"]) x(en(r.document, e).jsonFormat).toBe("LEGACY_BEST_EFFORT")
      x(Object.keys(en(r.document, "f.E"))).toEqual(["title", "file", "type", "values", "closed", "jsonFormat"])
    },
  },
  {
    id: "FEAT-2",
    title: "proto2: [packed = true] gives no keyword and leaves options; [packed = false] is the default",
    sources: {
      "a.proto":
        'syntax = "proto2";\npackage f;\nmessage M {\n  repeated int32 a = 1 [packed = true];\n  repeated int32 b = 2 [packed = false];\n  repeated sint64 c = 3 [packed = true, deprecated = true];\n}\n',
    },
    check: (r, x) =>
      x(keywords(r.document, "f.M")).toEqual({
        a: [undefined, undefined, undefined],
        b: [false, undefined, undefined],
        c: [undefined, undefined, undefined],
      }),
  },
  {
    id: "FEAT-3",
    title: "proto3: the baseline writes nothing; [packed = false] is packed: false and leaves options",
    sources: {
      "a.proto": `syntax = "proto3";\npackage f;\n${body("string s = 8;")}message P {\n  repeated int32 a = 1 [packed = false];\n  repeated int32 b = 2 [packed = true];\n}\n`,
    },
    check: (r, x) => {
      for (const [k, v] of Object.entries(keywords(r.document, "f.M")))
        x([k, ...(v as unknown[])]).toEqual([k, undefined, undefined, undefined])
      x(keywords(r.document, "f.P")).toEqual({ a: [false, undefined, undefined], b: [undefined, undefined, undefined] })
      x([msg(r.document, "f.M").jsonFormat, en(r.document, "f.E").jsonFormat]).toEqual([undefined, undefined])
    },
  },
  {
    id: "FEAT-4",
    title: "edition 2023: file-level features resolve onto every element and leave files.options",
    sources: {
      "a.proto": `edition = "2023";\npackage f;\noption features.repeated_field_encoding = EXPANDED;\noption features.utf8_validation = NONE;\noption features.json_format = LEGACY_BEST_EFFORT;\noption features.enum_type = CLOSED;\noption java_package = "x";\n${body("string s = 8;")}`,
    },
    check: (r, x) => {
      x((r.document as Doc).files?.["a.proto"]?.options).toEqual({
        java_package: "x",
        features: { enum_type: "CLOSED" },
      })
      x(keywords(r.document, "f.M")).toEqual({
        ints: [false, undefined, undefined],
        enums: [false, undefined, undefined],
        strs: [undefined, false, undefined],
        raw: [undefined, undefined, undefined],
        both: [undefined, false, undefined],
        value: [undefined, false, undefined],
        key: [undefined, false, undefined],
        s: [undefined, false, undefined],
      })
      for (const m of ["f.M", "f.M.Inner"]) x(msg(r.document, m).jsonFormat).toBe("LEGACY_BEST_EFFORT")
      for (const e of ["f.E", "f.M.Nested"]) x(en(r.document, e).jsonFormat).toBe("LEGACY_BEST_EFFORT")
    },
  },
  {
    id: "FEAT-5",
    title: "edition 2023: inheritance file -> message -> nested message / enum -> field, overrides in both directions",
    sources: {
      "a.proto": `edition = "2023";
package f;
option features.utf8_validation = NONE;
option features.json_format = LEGACY_BEST_EFFORT;
message A {
  string a = 1;
  string b = 2 [features.utf8_validation = VERIFY];
  message B {
    option features.json_format = ALLOW;
    string c = 1;
    enum E { option features.json_format = LEGACY_BEST_EFFORT; E_UNSPECIFIED = 0; }
    enum F { F_UNSPECIFIED = 0; }
    message D { int32 x = 1; }
  }
  oneof o {
    string d = 3;
    string e = 4 [features.utf8_validation = VERIFY];
  }
  repeated int32 r = 5 [features.repeated_field_encoding = EXPANDED];
}
message C { string x = 1; }
`,
    },
    check: (r, x) => {
      const a = props(r.document, "f.A")
      x([a.a.utf8Validation, a.b.utf8Validation, a.d.utf8Validation, a.e.utf8Validation, a.r.packed]).toEqual([
        false,
        undefined,
        false,
        undefined,
        false,
      ])
      x([a.a.options, a.b.options, a.d.options, a.r.options]).toEqual([undefined, undefined, undefined, undefined])
      x(props(r.document, "f.A.B").c.utf8Validation).toBe(false)
      x(props(r.document, "f.C").x.utf8Validation).toBe(false)
      x(["f.A", "f.A.B", "f.A.B.D", "f.C"].map((m) => msg(r.document, m).jsonFormat)).toEqual([
        "LEGACY_BEST_EFFORT",
        undefined,
        undefined,
        "LEGACY_BEST_EFFORT",
      ])
      x([en(r.document, "f.A.B.E").jsonFormat, en(r.document, "f.A.B.F").jsonFormat]).toEqual([
        "LEGACY_BEST_EFFORT",
        undefined,
      ])
      x([msg(r.document, "f.A").options, msg(r.document, "f.A.B").options]).toEqual([undefined, undefined])
      x((r.document as Doc).files?.["a.proto"]?.options).toBeUndefined()
    },
  },
  {
    id: "FEAT-6",
    title: "edition 2024: the same keywords; other features stay under options",
    sources: {
      "a.proto": `edition = "2024";
package f;
import "google/protobuf/cpp_features.proto";
option features.utf8_validation = NONE;
option features.(pb.cpp).string_type = VIEW;
message M {
  string s = 1 [features.utf8_validation = VERIFY, features.(pb.cpp).string_type = STRING];
  string t = 2;
  repeated int32 r = 3 [features.repeated_field_encoding = EXPANDED];
}
enum E { option features.json_format = LEGACY_BEST_EFFORT; E_UNSPECIFIED = 0; }
`,
    },
    check: (r, x) => {
      const p = props(r.document, "f.M")
      x([p.s.utf8Validation, p.s.options]).toEqual([undefined, { features: { "pb.cpp": { string_type: "STRING" } } }])
      x([p.t.utf8Validation, p.r.packed]).toEqual([false, false])
      x((r.document as Doc).files?.["a.proto"]?.options).toEqual({ features: { "pb.cpp": { string_type: "VIEW" } } })
      x(en(r.document, "f.E").jsonFormat).toBe("LEGACY_BEST_EFFORT")
      x(en(r.document, "f.E").options).toBeUndefined()
    },
  },
  {
    id: "FEAT-7",
    title: "edition 2026: the same keywords",
    sources: {
      "a.proto": `edition = "2026";
package f;
option features.repeated_field_encoding = EXPANDED;
message M {
  repeated int32 a = 1;
  repeated int32 b = 2 [features.repeated_field_encoding = PACKED];
  string s = 3 [features.utf8_validation = NONE];
  option features.json_format = LEGACY_BEST_EFFORT;
}
`,
    },
    check: (r, x) => {
      x(keywords(r.document, "f.M")).toEqual({
        a: [false, undefined, undefined],
        b: [undefined, undefined, undefined],
        s: [undefined, false, undefined],
      })
      x(msg(r.document, "f.M").jsonFormat).toBe("LEGACY_BEST_EFFORT")
      x((r.document as Doc).files?.["a.proto"]?.options).toBeUndefined()
    },
  },
  {
    id: "FEAT-8",
    title: "extensions: proto2 string and packable repeated extensions get the keywords",
    sources: {
      "a.proto":
        'syntax = "proto2";\npackage f;\nmessage M { extensions 100 to 199; }\nextend M {\n  optional string note = 100;\n  repeated int32 codes = 101;\n  repeated int32 packed_codes = 102 [packed = true];\n}\n',
    },
    check: (r, x) => {
      const x_ = (r.document as Doc).components?.extensions ?? {}
      x([x_["f.note"]?.utf8Validation, x_["f.codes"]?.packed, x_["f.packed_codes"]?.packed]).toEqual([
        false,
        false,
        undefined,
      ])
      x(x_["f.packed_codes"]?.options).toBeUndefined()
    },
  },
  {
    id: "FEAT-9",
    title: "[packed] on a non-packable field: no keyword, the invalid-option issue stays (buf rejects it)",
    sources: { "a.proto": 'syntax = "proto2";\npackage f;\nmessage M { repeated string s = 1 [packed = true]; }\n' },
    buf: "expected packable type",
    issues: ["invalid-option @ #/components/messages/f.M/properties/s"],
    check: (r, x) => {
      const s = props(r.document, "f.M").s
      x([s.packed, s.options]).toEqual([undefined, undefined])
    },
  },
  {
    id: "FEAT-10",
    title: "a file-level LEGACY_REQUIRED does not make oneof members required (buf rejects the file option)",
    sources: {
      "a.proto":
        'edition = "2023";\npackage f;\noption features.field_presence = LEGACY_REQUIRED;\nmessage M {\n  int32 a = 1;\n  oneof o { int32 b = 2; string c = 3; }\n}\n',
    },
    buf: "LEGACY_REQUIRED",
    issues: ["invalid-option @ #/files/a.proto/options/features"],
    check: (r, x) => {
      const p = props(r.document, "f.M")
      x([p.a.presence, p.b.presence, p.c.presence]).toEqual(["required", undefined, undefined])
    },
  },
]
