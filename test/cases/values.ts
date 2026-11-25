// PB-5 canonical values (design §3.6 / D7, rule D of §3.7, rule J of §3.5) and the phase C value fixes: float32
// narrowing (C-5), negative zero (F-2), enum-alias defaults (C-6), Any (C-9), unknown option fields (C-11),
// extension-range options (F-1). buf 1.75 is the oracle: an accepted case is also a conformance test.

import type { Case } from "./types.ts"

const P2 = 'syntax = "proto2";\npackage v;\n'
const P3 = 'syntax = "proto3";\npackage v;\n'
const DESC = 'import "google/protobuf/descriptor.proto";\n'

/** a proto2 message with one field per line, built as `v.M` */
const defaults = (fields: string, head = "") => ({ "a.proto": `${P2}${head}message M {\n${fields}\n}\n` })
const M = "#/components/messages/v.M"

/** custom options on a message, built as `v.M` (option definitions in proto2 so that every value is written) */
const options = (defs: string, sets: string, imports = "", syntax = P2) => ({
  "a.proto": `${syntax}${DESC}${imports}extend google.protobuf.MessageOptions {\n${defs}\n}\nmessage M {\n${sets}\n}\n`,
})

/** `(o)` (an `O` of maps) set to `value` on `v.M`, and `(an)` (an Any) to the text-format fields `any` */
const mapOptions = (value: string, any = "") => ({
  "a.proto": `${P3}import "google/protobuf/any.proto";\n${DESC}enum E { E0 = 0; E1 = 1; }\nmessage V { int32 x = 1; }\nmessage O { map<string, int32> m = 1; map<string, E> e = 2; map<string, V> v = 3; map<int64, string> i = 4; map<bool, bytes> b = 5; }\nextend google.protobuf.MessageOptions { O o = 50000; google.protobuf.Any an = 50001; }\nmessage M {\n  option (o) = ${value};\n${any ? `  option (an) = { ${any} };\n` : ""}}\n`,
})

type Doc = { components?: { messages?: Record<string, Record<string, unknown>> } }
const props = (d: unknown) =>
  (d as Doc).components?.messages?.["v.M"]?.properties as Record<string, Record<string, unknown>>
const opts = (d: unknown) => (d as Doc).components?.messages?.["v.M"]?.options as Record<string, unknown>

export const cases: Case[] = [
  // ---- defaults (proto2) ------------------------------------------------------------------------------------------
  {
    id: "PB-5.1",
    title: "32-bit integer defaults are JSON numbers, at the range bounds",
    sources: defaults(
      "  optional int32 a = 1 [default = -2147483648];\n  optional uint32 b = 2 [default = 4294967295];\n  optional sint32 c = 3 [default = -1];\n  optional fixed32 d = 4 [default = 7];\n  optional sfixed32 e = 5 [default = 2147483647];",
    ),
    check: (r, x) =>
      x(Object.values(props(r.document)).map((f) => f.default)).toEqual([-2147483648, 4294967295, -1, 7, 2147483647]),
  },
  {
    id: "PB-5.2",
    title: "64-bit integer defaults are decimal strings",
    sources: defaults(
      "  optional int64 a = 1 [default = -9223372036854775808];\n  optional uint64 b = 2 [default = 18446744073709551615];\n  optional sint64 c = 3 [default = -1];\n  optional fixed64 d = 4 [default = 9007199254740993];\n  optional sfixed64 e = 5 [default = 0];",
    ),
    check: (r, x) =>
      x(Object.values(props(r.document)).map((f) => f.default)).toEqual([
        "-9223372036854775808",
        "18446744073709551615",
        "-1",
        "9007199254740993",
        "0",
      ]),
  },
  {
    id: "PB-5.3",
    title: "hexadecimal and octal integer defaults are written in decimal",
    sources: defaults(
      "  optional int32 a = 1 [default = 0x7fffffff];\n  optional int32 b = 2 [default = -010];\n  optional uint64 c = 3 [default = 0xFFFFFFFFFFFFFFFF];",
    ),
    check: (r, x) =>
      x(Object.values(props(r.document)).map((f) => f.default)).toEqual([2147483647, -8, "18446744073709551615"]),
  },
  {
    id: "PB-5.4",
    title: "finite double defaults are JSON numbers (shortest round-trip form)",
    sources: defaults(
      "  optional double a = 1 [default = 1e10];\n  optional double b = 2 [default = 0.001];\n  optional double c = 3 [default = 5];\n  optional double d = 4 [default = 1.7976931348623157e308];\n  optional double e = 5 [default = 5e-324];",
    ),
    check: (r, x) =>
      x(Object.values(props(r.document)).map((f) => f.default)).toEqual([
        1e10, 0.001, 5, 1.7976931348623157e308, 5e-324,
      ]),
  },
  {
    id: "PB-5.5",
    title: "non-finite double defaults are the ProtoJSON strings",
    sources: defaults(
      "  optional double a = 1 [default = inf];\n  optional double b = 2 [default = -inf];\n  optional double c = 3 [default = nan];\n  optional float d = 4 [default = -inf];",
    ),
    check: (r, x) =>
      x(Object.values(props(r.document)).map((f) => f.default)).toEqual(["Infinity", "-Infinity", "NaN", "-Infinity"]),
  },
  {
    id: "PB-5.6",
    title: "float defaults: the shortest decimal of the float32 value (IN-5c)",
    sources: defaults(
      "  optional float a = 1 [default = 0.1];\n  optional float b = 2 [default = 3.4028235e38];\n  optional float c = 3 [default = 16777217];\n  optional float d = 4 [default = 1.17549435e-38];",
    ),
    check: (r, x) =>
      x(Object.values(props(r.document)).map((f) => f.default)).toEqual([0.1, 3.4028235e38, 16777216, 1.1754944e-38]),
  },
  {
    id: "PB-5.7",
    title: 'C-5: a float default that overflows float32 is "Infinity", never null',
    sources: defaults("  optional float a = 1 [default = 1e39];\n  optional float b = 2 [default = -1e39];"),
    check: (r, x) => x(Object.values(props(r.document)).map((f) => f.default)).toEqual(["Infinity", "-Infinity"]),
  },
  {
    id: "PB-5.8",
    title: "C-5: a float default below the float32 range is 0",
    sources: defaults("  optional float a = 1 [default = 1e-46];"),
    check: (r, x) => x(props(r.document).a.default).toBe(0),
  },
  {
    id: "PB-5.9",
    title: 'F-2: negative zero defaults are "-0" (float and double)',
    sources: defaults(
      "  optional double a = 1 [default = -0.0];\n  optional float b = 2 [default = -0];\n  optional double c = 3 [default = 0];",
    ),
    check: (r, x) => x(Object.values(props(r.document)).map((f) => f.default)).toEqual(["-0", "-0", 0]),
  },
  {
    id: "PB-5.10",
    title: "bool defaults are JSON booleans",
    sources: defaults("  optional bool a = 1 [default = true];\n  optional bool b = 2 [default = false];"),
    check: (r, x) => x(Object.values(props(r.document)).map((f) => f.default)).toEqual([true, false]),
  },
  {
    id: "PB-5.11",
    title: "string defaults: escapes decoded (\\n, \\t, octal, hex, \\u)",
    sources: defaults(
      '  optional string a = 1 [default = "a\\nb\\tc"];\n  optional string b = 2 [default = "\\101\\x42\\u00e9"];\n  optional string c = 3 [default = "q\\"\'"];',
    ),
    check: (r, x) => x(Object.values(props(r.document)).map((f) => f.default)).toEqual(["a\nb\tc", "ABé", "q\"'"]),
  },
  {
    id: "PB-5.12",
    title: "adjacent string literals are concatenated",
    sources: defaults("  optional string a = 1 [default = \"multi\" 'part'];"),
    check: (r, x) => x(props(r.document).a.default).toBe("multipart"),
  },
  {
    id: "PB-5.13",
    title: "bytes defaults are standard padded base64",
    sources: defaults(
      '  optional bytes a = 1 [default = "\\000\\001\\377ab"];\n  optional bytes b = 2 [default = "\\u00e9"];\n  optional bytes c = 3 [default = ""];',
    ),
    check: (r, x) => x(Object.values(props(r.document)).map((f) => f.default)).toEqual(["AAH/YWI=", "w6k=", ""]),
  },
  {
    id: "PB-5.14",
    title: "enum defaults are value names",
    sources: defaults("  optional E a = 1 [default = GREEN];", "enum E { RED = 1; GREEN = 2; }\n"),
    check: (r, x) => x(props(r.document).a.default).toBe("GREEN"),
  },
  {
    id: "PB-5.15",
    title: "C-6 / D-B: an enum-alias default keeps the name as written; descriptors keep what they store",
    sources: defaults(
      "  optional E a = 1 [default = BB];",
      "enum E { option allow_alias = true; A = 0; B = 1; BB = 1; }\n",
    ),
    // D-B: the one known PB-2 divergence. buf stores the first name for the number (`B`), the text producer writes
    // the name as written (`BB`); the printer prints the name it is given.
    noConformance: "D-B: buf stores the first enum name for the default number",
    check: (r, x) => x(props(r.document).a.default).toBe("BB"),
    descriptorCheck: (d, x) => x(props(d.document).a.default).toBe("B"),
  },
  // ---- option values ------------------------------------------------------------------------------------------------
  {
    id: "PB-5.16",
    title: "32-bit integer option values are numbers, 64-bit ones decimal strings",
    sources: options(
      "  optional int32 i32 = 50001;\n  optional uint32 u32 = 50002;\n  optional int64 i64 = 50003;\n  optional uint64 u64 = 50004;\n  optional sfixed64 sf64 = 50005;",
      "  option (i32) = -5;\n  option (u32) = 0xffffffff;\n  option (i64) = -9223372036854775808;\n  option (u64) = 18446744073709551615;\n  option (sf64) = 9007199254740993;",
    ),
    check: (r, x) =>
      x(opts(r.document)).toEqual({
        "v.i32": -5,
        "v.u32": 4294967295,
        "v.i64": "-9223372036854775808",
        "v.u64": "18446744073709551615",
        "v.sf64": "9007199254740993",
      }),
  },
  {
    id: "PB-5.17",
    title: "C-5: float option values are narrowed to float32 (16777217 -> 16777216, 0.1 stays 0.1)",
    sources: options(
      "  optional float f1 = 50001;\n  optional float f2 = 50002;\n  optional float f3 = 50003;\n  optional double d1 = 50004;",
      "  option (f1) = 16777217;\n  option (f2) = 0.1;\n  option (f3) = 1.23456789012;\n  option (d1) = 16777217;",
    ),
    check: (r, x) =>
      x(opts(r.document)).toEqual({ "v.f1": 16777216, "v.f2": 0.1, "v.f3": 1.2345679, "v.d1": 16777217 }),
  },
  {
    id: "PB-5.18",
    title: "C-5: float option values below and above the float32 range",
    sources: options(
      "  optional float f1 = 50001;\n  optional float f2 = 50002;\n  optional float f3 = 50003;",
      "  option (f1) = 1e-46;\n  option (f2) = 1e39;\n  option (f3) = -1e39;",
    ),
    check: (r, x) => x(opts(r.document)).toEqual({ "v.f1": 0, "v.f2": "Infinity", "v.f3": "-Infinity" }),
  },
  {
    id: "PB-5.19",
    title: "non-finite float and double option values are the ProtoJSON strings",
    sources: options(
      "  optional double d1 = 50001;\n  optional double d2 = 50002;\n  optional float f1 = 50003;",
      "  option (d1) = inf;\n  option (d2) = -nan;\n  option (f1) = -inf;",
    ),
    check: (r, x) => x(opts(r.document)).toEqual({ "v.d1": "Infinity", "v.d2": "NaN", "v.f1": "-Infinity" }),
  },
  {
    id: "PB-5.20",
    title: 'F-2: negative zero option values are "-0"',
    sources: options(
      "  optional double d1 = 50001;\n  optional float f1 = 50002;\n  optional double d2 = 50003;",
      "  option (d1) = -0.0;\n  option (f1) = -0;\n  option (d2) = 0.0;",
    ),
    // buf 1.75 stores +0 for a negative zero option value (protoc keeps the sign); a known PB-2 divergence like D-B.
    // A descriptor that carries -0 (ProtoJSON `-0`) gives "-0" (test/values.test.ts PB-5.46).
    noConformance: "buf 1.75 drops the sign of a negative zero option value",
    check: (r, x) => x(opts(r.document)).toEqual({ "v.d1": "-0", "v.f1": "-0", "v.d2": 0 }),
    descriptorCheck: (d, x) => x(opts(d.document)).toEqual({ "v.d1": 0, "v.f1": 0, "v.d2": 0 }),
  },
  {
    id: "PB-5.21",
    title: "bool, string and bytes option values",
    sources: options(
      "  optional bool b = 50001;\n  optional string s = 50002;\n  optional bytes y = 50003;",
      '  option (b) = false;\n  option (s) = "a\\u00e9\\n";\n  option (y) = "\\377\\000";',
    ),
    check: (r, x) => x(opts(r.document)).toEqual({ "v.b": false, "v.s": "aé\n", "v.y": "/wA=" }),
  },
  {
    id: "PB-5.22",
    title: "enum option values are names, also when written as numbers",
    sources: {
      "a.proto": `${P2}${DESC}enum E { RED = 1; GREEN = 2; }\nextend google.protobuf.MessageOptions {\n  optional E e1 = 50001;\n  optional E e2 = 50002;\n}\nmessage M {\n  option (e1) = GREEN;\n  option (e2) = 1;\n}\n`,
    },
    check: (r, x) => x(opts(r.document)).toEqual({ "v.e1": "GREEN", "v.e2": "RED" }),
  },
  {
    id: "PB-5.23",
    title: "a repeated option set twice is an array; a repeated field inside a message value is an array",
    sources: {
      "a.proto": `${P2}${DESC}message Agg { repeated int32 n = 1; optional string s = 2; }\nextend google.protobuf.MessageOptions {\n  repeated string tags = 50001;\n  optional Agg agg = 50002;\n}\nmessage M {\n  option (tags) = "a";\n  option (tags) = "b";\n  option (agg) = { n: 1 };\n}\n`,
    },
    check: (r, x) => x(opts(r.document)).toEqual({ "v.tags": ["a", "b"], "v.agg": { n: [1] } }),
  },
  {
    id: "PB-5.24",
    title: "message option values: snake_case keys in declaration order, values canonical",
    sources: {
      "a.proto": `${P2}${DESC}message Agg {\n  optional int64 big_id = 1;\n  optional float ratio = 2;\n  optional double zero = 3;\n  optional bytes raw = 4;\n  optional Agg next = 5;\n}\nextend google.protobuf.MessageOptions { optional Agg agg = 50001; }\nmessage M {\n  option (agg) = { next { ratio: 16777217 } raw: "\\001" zero: 0.5 ratio: 1e39 big_id: 9007199254740993 };\n}\n`,
    },
    check: (r, x) => {
      const agg = opts(r.document)["v.agg"]
      x(agg).toEqual({
        big_id: "9007199254740993",
        ratio: "Infinity",
        zero: 0.5,
        raw: "AQ==",
        next: { ratio: 16777216 },
      })
      x(Object.keys(agg as object)).toEqual(["big_id", "ratio", "zero", "raw", "next"])
    },
  },
  {
    id: "PB-5.25",
    title: "well-known types inside options are messages (Duration, Timestamp, FieldMask, wrappers)",
    sources: options(
      "  optional google.protobuf.Duration d = 50001;\n  optional google.protobuf.Timestamp t = 50002;\n  optional google.protobuf.FieldMask fm = 50003;\n  optional google.protobuf.Int64Value w = 50004;\n  optional google.protobuf.StringValue sv = 50005;",
      '  option (d) = { seconds: 60 nanos: 5 };\n  option (t) = { seconds: 1 };\n  option (fm) = { paths: ["a_b.c", "d"] };\n  option (w) = { value: 5 };\n  option (sv) = {};',
      'import "google/protobuf/duration.proto";\nimport "google/protobuf/timestamp.proto";\nimport "google/protobuf/field_mask.proto";\nimport "google/protobuf/wrappers.proto";\n',
    ),
    check: (r, x) =>
      x(opts(r.document)).toEqual({
        "v.d": { seconds: "60", nanos: 5 },
        "v.t": { seconds: "1" },
        "v.fm": { paths: ["a_b.c", "d"] },
        "v.w": { value: "5" },
        "v.sv": {},
      }),
  },
  {
    id: "PB-5.26",
    title: "Struct, Value and ListValue option values are messages; a null is NULL_VALUE, never JSON null",
    sources: options(
      "  optional google.protobuf.Struct st = 50001;\n  optional google.protobuf.Value vv = 50002;\n  optional google.protobuf.ListValue lv = 50003;",
      '  option (st) = { fields { key: "b" value { null_value: NULL_VALUE } } fields { key: "a" value { struct_value { fields { key: "n" value { number_value: 1.5 } } } } } };\n  option (vv) = { list_value { values { bool_value: false } values { string_value: "" } } };\n  option (lv) = { values { number_value: -2.5 } };',
      'import "google/protobuf/struct.proto";\n',
    ),
    check: (r, x) =>
      x(opts(r.document)).toEqual({
        "v.st": {
          fields: { a: { struct_value: { fields: { n: { number_value: 1.5 } } } }, b: { null_value: "NULL_VALUE" } },
        },
        "v.vv": { list_value: { values: [{ bool_value: false }, { string_value: "" }] } },
        "v.lv": { values: [{ number_value: -2.5 }] },
      }),
  },
  {
    id: "PB-5.27",
    title: 'C-9: an Any option value with a message payload is { "@type", ...fields } (typed, snake_case)',
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\n${DESC}message Payload { int64 big_id = 1; repeated string tags = 2; Payload inner = 3; }\nextend google.protobuf.MessageOptions { google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { [type.googleapis.com/v.Payload] { tags: "x" big_id: 7 inner { big_id: 0 } } };\n}\n`,
    },
    check: (r, x) => {
      const an = opts(r.document)["v.an"]
      x(an).toEqual({ "@type": "type.googleapis.com/v.Payload", big_id: "7", tags: ["x"], inner: {} })
      x(Object.keys(an as object)).toEqual(["@type", "big_id", "tags", "inner"])
    },
  },
  {
    id: "PB-5.28",
    title: "C-9: Any with a well-known payload uses its ProtoJSON value form",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\nimport "google/protobuf/duration.proto";\nimport "google/protobuf/timestamp.proto";\nimport "google/protobuf/field_mask.proto";\nimport "google/protobuf/wrappers.proto";\nimport "google/protobuf/empty.proto";\n${DESC}extend google.protobuf.MessageOptions { repeated google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { [type.googleapis.com/google.protobuf.Duration] { seconds: 5 nanos: 500000000 } };\n  option (an) = { [type.googleapis.com/google.protobuf.Timestamp] { seconds: 1700000000 nanos: 1000 } };\n  option (an) = { [type.googleapis.com/google.protobuf.FieldMask] { paths: "a_b" paths: "c.d_e" } };\n  option (an) = { [type.googleapis.com/google.protobuf.Int64Value] { value: 9007199254740993 } };\n  option (an) = { [type.googleapis.com/google.protobuf.BoolValue] {} };\n  option (an) = { [type.googleapis.com/google.protobuf.Empty] {} };\n}\n`,
    },
    check: (r, x) =>
      x(opts(r.document)["v.an"]).toEqual([
        { "@type": "type.googleapis.com/google.protobuf.Duration", value: "5.500s" },
        { "@type": "type.googleapis.com/google.protobuf.Timestamp", value: "2023-11-14T22:13:20.000001Z" },
        { "@type": "type.googleapis.com/google.protobuf.FieldMask", value: "aB,c.dE" },
        { "@type": "type.googleapis.com/google.protobuf.Int64Value", value: "9007199254740993" },
        { "@type": "type.googleapis.com/google.protobuf.BoolValue", value: false },
        { "@type": "type.googleapis.com/google.protobuf.Empty", value: {} },
      ]),
  },
  {
    id: "PB-5.29",
    title: "C-9: Any with a Struct payload stays in message form (no JSON null); a nested Any is a value",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\nimport "google/protobuf/struct.proto";\nimport "google/protobuf/duration.proto";\n${DESC}extend google.protobuf.MessageOptions { repeated google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { [type.googleapis.com/google.protobuf.Struct] { fields { key: "k" value { null_value: NULL_VALUE } } } };\n  option (an) = { [type.googleapis.com/google.protobuf.Any] { [type.googleapis.com/google.protobuf.Duration] { seconds: 1 } } };\n}\n`,
    },
    check: (r, x) =>
      x(opts(r.document)["v.an"]).toEqual([
        { "@type": "type.googleapis.com/google.protobuf.Struct", fields: { k: { null_value: "NULL_VALUE" } } },
        {
          "@type": "type.googleapis.com/google.protobuf.Any",
          value: { "@type": "type.googleapis.com/google.protobuf.Duration", value: "1s" },
        },
      ]),
  },
  {
    id: "PB-5.30",
    title: "C-9: an Any with an unknown type URL is an unknown-option, kept best effort (buf rejects it)",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\n${DESC}extend google.protobuf.MessageOptions { google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { [type.googleapis.com/nope.Missing] { a: 1 b: "x" } };\n}\n`,
    },
    buf: "Missing",
    issues: [`unknown-option @ ${M}/options/v.an`],
    check: (r, x) => x(opts(r.document)["v.an"]).toEqual({ "@type": "type.googleapis.com/nope.Missing", a: 1, b: "x" }),
  },
  {
    id: "PB-5.38",
    title: "an Any written with type_url / value fields is expanded like [url] { … } (scalars, packed, maps, enums)",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\n${DESC}message Q { repeated int32 r = 1; int32 n = 2; sfixed32 sf = 3; float fl = 4; uint32 u = 5; sint64 s64 = 7; int64 i64 = 8; repeated E es = 9; string s = 10; bytes by = 11; map<int64, Q> mq = 12; optional int32 o = 13; fixed64 f = 14; double d = 15; bool b = 16; }\nenum E { E0 = 0; E1 = 1; }\nextend google.protobuf.MessageOptions { repeated google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { type_url: "type.googleapis.com/v.Q" value: "\\x0a\\x04\\x01\\x02\\x96\\x01\\x10\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\x01\\x1d\\xfe\\xff\\xff\\xff\\x25\\x00\\x00\\xc0\\x3f\\x28\\xff\\xff\\xff\\xff\\x0f\\x38\\x03\\x40\\x80\\x80\\x80\\x80\\x80\\x80\\x80\\x80\\x80\\x01\\x48\\x01\\x48\\x00\\x52\\x02hi\\x5a\\x01\\xff\\x62\\x06\\x08\\x05\\x12\\x02\\x10\\x01\\x68\\x00\\x71\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x79\\x00\\x00\\x00\\x00\\x00\\x00\\xf0\\x3f\\x80\\x01\\x01" };\n  option (an) = { value: "\\x10\\x07" type_url: "type.googleapis.com/v.Q" };\n  option (an) = { type_url: "type.googleapis.com/v.Q" value: "\\x10\\x00\\x0a\\x00\\x58\\x07\\xa0\\x06\\x01" };\n  option (an) = { type_url: "type.googleapis.com/v.Q" };\n  option (an) = {};\n}\n`,
    },
    check: (r, x) =>
      x(opts(r.document)["v.an"]).toEqual([
        {
          "@type": "type.googleapis.com/v.Q",
          r: [1, 2, 150],
          n: -1,
          sf: -2,
          fl: 1.5,
          u: 4294967295,
          s64: "-2",
          i64: "-9223372036854775808",
          es: ["E1", "E0"],
          s: "hi",
          by: "/w==",
          mq: { "5": { n: 1 } },
          o: 0,
          f: "1",
          d: 1,
          b: true,
        },
        { "@type": "type.googleapis.com/v.Q", n: 7 },
        { "@type": "type.googleapis.com/v.Q" },
        { "@type": "type.googleapis.com/v.Q" },
        {},
      ]),
  },
  {
    id: "PB-5.39",
    title: "an Any written with type_url / value fields: nested Any, well-known and JSON-valued payloads",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\nimport "google/protobuf/struct.proto";\nimport "google/protobuf/duration.proto";\nimport "google/protobuf/wrappers.proto";\n${DESC}message Q { int32 n = 2; google.protobuf.Any a = 6; }\nextend google.protobuf.MessageOptions { repeated google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { type_url: "type.googleapis.com/v.Q" value: "\\x32\\x1d\\x0a\\x17type.googleapis.com/v.Q\\x12\\x02\\x10\\x07" };\n  option (an) = { [type.googleapis.com/v.Q] { a { type_url: "type.googleapis.com/v.Q" value: "\\x10\\x09" } } };\n  option (an) = { type_url: "type.googleapis.com/google.protobuf.Any" value: "\\x0a\\x17type.googleapis.com/v.Q\\x12\\x02\\x10\\x07" };\n  option (an) = { type_url: "type.googleapis.com/google.protobuf.Duration" value: "\\x08\\x05\\x10\\x80\\xca\\xb5\\xee\\x01" };\n  option (an) = { type_url: "type.googleapis.com/google.protobuf.Int32Value" value: "\\x08\\x05" };\n  option (an) = { type_url: "type.googleapis.com/google.protobuf.Value" value: "\\x1a\\x01x" };\n  option (an) = { type_url: "type.googleapis.com/google.protobuf.Struct" value: "\\x0a\\x07\\x0a\\x01k\\x12\\x02\\x08\\x00" };\n}\n`,
    },
    check: (r, x) => {
      const q7 = { "@type": "type.googleapis.com/v.Q", n: 7 }
      x(opts(r.document)["v.an"]).toEqual([
        { "@type": "type.googleapis.com/v.Q", a: q7 },
        { "@type": "type.googleapis.com/v.Q", a: { "@type": "type.googleapis.com/v.Q", n: 9 } },
        { "@type": "type.googleapis.com/google.protobuf.Any", value: q7 },
        { "@type": "type.googleapis.com/google.protobuf.Duration", value: "5.500s" },
        { "@type": "type.googleapis.com/google.protobuf.Int32Value", value: 5 },
        { "@type": "type.googleapis.com/google.protobuf.Value", string_value: "x" },
        { "@type": "type.googleapis.com/google.protobuf.Struct", fields: { k: { null_value: "NULL_VALUE" } } },
      ])
    },
  },
  {
    id: "PB-5.40",
    title: "an Any written with type_url / value fields of an unknown type is kept as written (buf rejects it)",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\n${DESC}extend google.protobuf.MessageOptions { google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { type_url: "type.googleapis.com/nope.Missing" value: "\\x08\\x01" };\n}\n`,
    },
    buf: "Missing",
    issues: [`unknown-option @ ${M}/options/v.an`],
    check: (r, x) => {
      x(opts(r.document)["v.an"]).toEqual({ type_url: "type.googleapis.com/nope.Missing", value: "CAE=" })
      // the same issue as an unknown type in the expanded form (PB-5.30)
      x(r.issues[0].message).toContain("unknown type type.googleapis.com/nope.Missing in an Any option value")
    },
  },
  {
    id: "PB-5.41",
    title: "an Any written with type_url / value fields whose bytes do not decode is kept as written (buf rejects it)",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\n${DESC}message Q { int32 n = 2; }\nextend google.protobuf.MessageOptions { google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { type_url: "type.googleapis.com/v.Q" value: "\\x10" };\n}\n`,
    },
    buf: "invalid wire-format",
    issues: [`unknown-option @ ${M}/options/v.an`],
    check: (r, x) => x(opts(r.document)["v.an"]).toEqual({ type_url: "type.googleapis.com/v.Q", value: "EA==" }),
  },
  {
    id: "PB-5.42",
    title: "an Any written with a value but no type_url is kept as written (buf rejects it)",
    sources: {
      "a.proto": `${P3}import "google/protobuf/any.proto";\n${DESC}extend google.protobuf.MessageOptions { google.protobuf.Any an = 50001; }\nmessage M {\n  option (an) = { value: "\\x08\\x01" };\n}\n`,
    },
    buf: "type_url is not set",
    issues: [`unknown-option @ ${M}/options/v.an`],
    check: (r, x) => x(opts(r.document)["v.an"]).toEqual({ value: "CAE=" }),
  },
  // ---- map entries in text-format option values ---------------------------------------------------------------------
  {
    id: "PB-5.47",
    title: "a map entry without a key or a value takes the zero value of its type",
    sources: mapOptions(
      '{ m: [{ value: 1 }, { key: "k" }] e: { key: "a" } v: { key: "a" } i: { value: "z" } b: {} }',
      'type_url: "type.googleapis.com/v.O" value: "\\x0a\\x03\\x0a\\x01k\\x0a\\x02\\x10\\x05"',
    ),
    check: (r, x) => {
      x(opts(r.document)["v.o"]).toEqual({
        m: { "": 1, k: 0 },
        e: { a: "E0" },
        v: { a: {} },
        i: { "0": "z" },
        b: { false: "" },
      })
      // the same in an Any decoded from its wire bytes
      x(opts(r.document)["v.an"]).toEqual({ "@type": "type.googleapis.com/v.O", m: { k: 0, "": 5 } })
    },
  },
  {
    id: "PB-5.48",
    title: "a map entry key of the wrong type is an invalid-option (buf rejects it)",
    sources: mapOptions("{ m: { key: 1, value: 2 } }"),
    buf: "mismatched types",
    issues: [`invalid-option @ ${M}/options/v.o`],
    check: (r, x) => {
      x(opts(r.document)["v.o"]).toEqual({})
      x(r.issues[0].message).toContain("map entry key: a string literal is expected")
    },
  },
  {
    id: "PB-5.49",
    title: "a map entry value of the wrong type is an invalid-option (buf rejects it)",
    sources: mapOptions('{ m: { key: "k", value: "x" } m: { key: "j", value: 2 } }'),
    buf: "mismatched types",
    issues: [`invalid-option @ ${M}/options/v.o`],
    check: (r, x) => x(opts(r.document)["v.o"]).toEqual({ m: { j: 2 } }),
  },
  {
    id: "PB-5.50",
    title: "a map entry field other than key and value is an invalid-option (buf rejects it)",
    sources: mapOptions('{ m: { key: "k", foo: 1 } }'),
    buf: "cannot resolve message field name",
    issues: [`invalid-option @ ${M}/options/v.o`],
  },
  // ---- rule D and rule J --------------------------------------------------------------------------------------------
  {
    id: "PB-5.31",
    title: "rule D: field options equal to their default are not written",
    sources: defaults(
      "  optional int64 a = 1 [jstype = JS_NORMAL, deprecated = false];\n  optional M b = 2 [lazy = false, unverified_lazy = false, debug_redact = false];\n  repeated int32 c = 3 [packed = false, retention = RETENTION_UNKNOWN];\n  optional int64 d = 4 [jstype = JS_STRING, debug_redact = true];\n  optional string e = 5 [ctype = STRING];",
    ),
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.options, p.b.options, p.c.options, p.e.options]).toEqual([undefined, undefined, undefined, undefined])
      x(p.d.options).toEqual({ jstype: "JS_STRING", debug_redact: true })
    },
  },
  {
    id: "PB-5.32",
    title: "rule D: file, message, enum and method options equal to their default are not written",
    sources: {
      "a.proto": `${P2}option java_multiple_files = false;\noption optimize_for = SPEED;\noption cc_enable_arenas = true;\noption java_package = "x.y";\nmessage M { option message_set_wire_format = false; option no_standard_descriptor_accessor = false; }\nenum E { option allow_alias = false; option deprecated = false; A = 0; }\nservice S { rpc R(M) returns (M) { option idempotency_level = IDEMPOTENCY_UNKNOWN; } }\n`,
    },
    check: (r, x) => {
      const d = r.document
      x(d.files?.["a.proto"]?.options).toEqual({ java_package: "x.y" })
      x(d.components?.messages?.["v.M"]?.options).toBeUndefined()
      x(d.components?.enums?.["v.E"]?.options).toBeUndefined()
      x(d.services?.["v.S"]?.methods.R.idempotency).toBeUndefined()
      x(d.services?.["v.S"]?.methods.R.options).toBeUndefined()
    },
  },
  {
    id: "PB-5.33",
    title: "rule J: jsonName only when json_name differs from the protoc default",
    sources: {
      "a.proto": `${P3}message M {\n  string foo_bar = 1 [json_name = "fooBar"];\n  string foo_1bar = 2 [json_name = "foo1bar"];\n  string _foo = 3 [json_name = "Foo"];\n  string foo__baz = 4 [json_name = "fooBaz"];\n  string tail_ = 5 [json_name = "tail"];\n  string pet_tags = 6 [json_name = "petTags2"];\n  string plain = 7;\n}\n`,
    },
    check: (r, x) => {
      const p = props(r.document)
      x(Object.entries(p).map(([k, f]) => [k, f.jsonName])).toEqual([
        ["foo_bar", undefined],
        ["foo_1bar", undefined],
        ["_foo", undefined],
        ["foo__baz", undefined],
        ["tail_", undefined],
        ["pet_tags", "petTags2"],
        ["plain", undefined],
      ])
    },
  },
  // ---- unknown fields of known option messages (C-11, decision 3) -----------------------------------------------------
  {
    id: "PB-5.34",
    title: "C-11: an unknown sub-field of a known option message is kept raw with unknown-option (buf rejects it)",
    sources: {
      "a.proto": `${P3}import "buf/validate/validate.proto";\nmessage M {\n  string a = 1 [(buf.validate.field).ignore_empty = true, (buf.validate.field).string.min_len = 1];\n  string b = 2 [(buf.validate.field).string.not_a_rule = 5];\n  string c = 3 [(buf.validate.field) = { skipped: true string: { max_len: 3 legacy { x: 1 y: [1, 2] } } }];\n}\n`,
    },
    buf: "ignore_empty",
    issues: [
      `unknown-option @ ${M}/properties/a/options/buf.validate.field`,
      `unknown-option @ ${M}/properties/b/options/buf.validate.field`,
      `unknown-option @ ${M}/properties/c/options/buf.validate.field`,
      `unknown-option @ ${M}/properties/c/options/buf.validate.field`,
    ],
    check: (r, x) => {
      const p = props(r.document)
      x(p.a.minLength).toBe(1)
      x(p.a.options).toEqual({ "buf.validate.field": { ignore_empty: true } })
      x(p.b.options).toEqual({ "buf.validate.field": { string: { not_a_rule: 5 } } })
      x(p.c.maxLength).toBe(3)
      x(p.c.options).toEqual({ "buf.validate.field": { string: { legacy: { x: 1, y: [1, 2] } }, skipped: true } })
    },
  },
  {
    id: "PB-5.35",
    title: "C-11: an unknown field inside a built-in option message (FeatureSet) is kept raw (buf rejects it)",
    sources: { "a.proto": 'edition = "2023";\npackage v;\noption features.not_a_feature = 3;\nmessage M {}\n' },
    buf: "not_a_feature",
    issues: ["unknown-option @ #/files/a.proto/options/features"],
    check: (r, x) => x(r.document.files?.["a.proto"]?.options).toEqual({ features: { not_a_feature: 3 } }),
  },
  // ---- extension-range options (F-1) --------------------------------------------------------------------------------
  {
    id: "PB-5.36",
    title: "F-1: extensions stay merged; range options other than declaration go to extensionOptions",
    sources: {
      "a.proto": `${P2}${DESC}extend google.protobuf.ExtensionRangeOptions { optional int32 note = 50001; }\nmessage M {\n  extensions 100 to 199 [verification = UNVERIFIED];\n  extensions 200 to 299 [(note) = 7];\n  extensions 300 to 399;\n  extensions 1000 to max [(note) = 8, verification = UNVERIFIED];\n}\n`,
    },
    check: (r, x) => {
      const m = r.document.components?.messages?.["v.M"]
      x(m?.extensions).toEqual([
        [100, 399],
        [1000, 536870911],
      ])
      x(m?.extensionOptions).toEqual([
        { range: [100, 199], options: { verification: "UNVERIFIED" } },
        { range: [200, 299], options: { "v.note": 7 } },
        { range: [1000, 536870911], options: { verification: "UNVERIFIED", "v.note": 8 } },
      ])
      x(Object.keys(m ?? {})).toEqual([
        "title",
        "file",
        "type",
        "properties",
        "extensions",
        "extensionOptions",
        "jsonFormat",
      ])
    },
  },
  {
    id: "PB-5.37",
    title: "F-1: one range statement with two ranges gives one entry per range",
    sources: {
      "a.proto": `${P2}${DESC}extend google.protobuf.ExtensionRangeOptions { optional int32 note = 50001; }\nmessage M {\n  extensions 10 to 19, 30 to 39 [(note) = 1];\n}\n`,
    },
    check: (r, x) => {
      const m = r.document.components?.messages?.["v.M"]
      x(m?.extensions).toEqual([
        [10, 19],
        [30, 39],
      ])
      x(m?.extensionOptions).toEqual([
        { range: [10, 19], options: { "v.note": 1 } },
        { range: [30, 39], options: { "v.note": 1 } },
      ])
    },
  },
]
