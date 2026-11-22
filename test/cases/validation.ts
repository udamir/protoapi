// Definition checks of the text producer (validation decision D-E, report §6): every input buf rejects gets an
// issue, and the inputs around each rule that buf accepts stay issue-free and conform. `buf` is the substring of
// buf 1.75's error recorded in test/images/cases/validation.json.

import type { Case } from "./types.ts"

const P2 = 'syntax = "proto2";\npackage p;\nimport "google/protobuf/descriptor.proto";\n'
const P3 = 'syntax = "proto3";\npackage p;\n'
const E = (edition: string) => `edition = "${edition}";\npackage p;\n`
const OPTS = `extend google.protobuf.FileOptions {
  optional int32 i32 = 50001; optional uint32 u32 = 50002; optional uint64 u64 = 50003; optional bool b = 50004;
  optional double d = 50005; optional E e = 50006; optional string s = 50007; optional float f = 50008;
  optional Agg agg = 50009; optional bytes by = 50010; optional int64 i64 = 50011;
}
enum E { E0 = 0; E1 = 1; }
message Agg { optional int32 i = 1; optional bool b = 2; optional E e = 3; optional Agg sub = 4; optional double d = 6; optional uint64 u = 8; }
`
const FO = "#/files/a.proto/options"
const opt = (id: string, title: string, statement: string, bufError?: string, issues: string[] = []): Case => ({
  id,
  title,
  sources: { "a.proto": `${P2}${OPTS}option ${statement};\n` },
  ...(bufError ? { buf: bufError } : {}),
  issues,
})
const M = "#/components/messages/p.M"
const def = (id: string, title: string, field: string, bufError?: string, issues: string[] = []): Case => ({
  id,
  title,
  sources: { "a.proto": `${P2}enum E2 { A = 0; B = 1; }\nmessage M { ${field} }\n` },
  ...(bufError ? { buf: bufError } : {}),
  issues,
})

export const cases: Case[] = [
  // ---- values in options and defaults (invalid-option) ------------------------------------------------------------
  opt("VAL-1", "int32 option out of range", "(i32) = 2147483648", "literal out of range for `int32`", [
    `invalid-option @ ${FO}/p.i32`,
  ]),
  opt("VAL-2", "int32 option below range", "(i32) = -2147483649", "literal out of range for `int32`", [
    `invalid-option @ ${FO}/p.i32`,
  ]),
  opt("VAL-3", "uint32 option negative", "(u32) = -1", "literal out of range for `uint32`", [
    `invalid-option @ ${FO}/p.u32`,
  ]),
  opt("VAL-4", "uint64 option 2^64", "(u64) = 18446744073709551616", "literal out of range for `uint64`", [
    `invalid-option @ ${FO}/p.u64`,
  ]),
  opt("VAL-5", "int64 option 2^63", "(i64) = 9223372036854775808", "literal out of range for `int64`", [
    `invalid-option @ ${FO}/p.i64`,
  ]),
  opt("VAL-6", "int32 hex beyond range", "(i32) = 0x80000000", "literal out of range for `int32`", [
    `invalid-option @ ${FO}/p.i32`,
  ]),
  opt(
    "VAL-7",
    "accepted integer spellings: 2^64-1, -2^63, hex, octal, 1e3",
    "(u64) = 18446744073709551615; option (i64) = -9223372036854775808; option (i32) = 1e3; option (u32) = 0xffffffff; option (agg).i = 017",
  ),
  opt("VAL-8", "unknown enum identifier", "(e) = BLUE", "cannot find `BLUE` in this scope", [
    `invalid-option @ ${FO}/p.e`,
  ]),
  opt("VAL-9", "qualified enum value", "(e) = p.E1", "qualified enum value reference", [`invalid-option @ ${FO}/p.e`]),
  opt("VAL-10", "enum option by number (buf accepts)", "(e) = 1"),
  opt("VAL-11", "bool option 1", "(b) = 1", "mismatched types", [`invalid-option @ ${FO}/p.b`]),
  opt(
    "VAL-12",
    "bool option True (text-format spelling)",
    "(b) = True",
    "non-canonical `bool` literal outside of message expression",
    [`invalid-option @ ${FO}/p.b`],
  ),
  opt("VAL-13", "bool option t", "(b) = t", "non-canonical `bool` literal", [`invalid-option @ ${FO}/p.b`]),
  opt(
    "VAL-14",
    "double option INF",
    "(d) = INF",
    "non-canonical floating-point literal outside of message expression",
    [`invalid-option @ ${FO}/p.d`],
  ),
  opt("VAL-15", "double option hex", "(d) = 0x10", "unsupported base for floating-point literal", [
    `invalid-option @ ${FO}/p.d`,
  ]),
  opt(
    "VAL-16",
    "accepted float spellings: inf, -inf, nan, -nan, ints, octal, exponent",
    "(d) = -inf; option (f) = nan; option (agg).d = 010",
  ),
  opt("VAL-17", "string option with invalid UTF-8", '(s) = "\\377"', "invalid UTF-8", [`invalid-option @ ${FO}/p.s`]),
  opt("VAL-18", "bytes option with any bytes (buf accepts)", '(by) = "\\377\\000"'),
  opt("VAL-19", "int32 option from a float literal", "(i32) = 1.5", "mismatched types", [
    `invalid-option @ ${FO}/p.i32`,
  ]),
  opt("VAL-20", "int32 option from a string", '(i32) = "5"', "mismatched types", [`invalid-option @ ${FO}/p.i32`]),
  opt("VAL-21", "string option from an identifier", "(s) = foo", "cannot find `foo` in this scope", [
    `invalid-option @ ${FO}/p.s`,
  ]),
  opt("VAL-22", "aggregate: int32 out of range", "(agg) = { i: 2147483648 }", "literal out of range for `int32`", [
    `invalid-option @ ${FO}/p.agg`,
  ]),
  opt("VAL-23", "aggregate: uint64 negative", "(agg) = { u: -1 }", "literal out of range for `uint64`", [
    `invalid-option @ ${FO}/p.agg`,
  ]),
  opt("VAL-24", "aggregate: bool 1", "(agg) = { b: 1 }", "mismatched types", [`invalid-option @ ${FO}/p.agg`]),
  opt("VAL-25", "aggregate: unknown enum identifier", "(agg) = { e: BLUE }", "cannot find `BLUE` in this scope", [
    `invalid-option @ ${FO}/p.agg`,
  ]),
  opt("VAL-26", "aggregate: hex double", "(agg) = { d: 0x10 }", "unsupported base for floating-point literal", [
    `invalid-option @ ${FO}/p.agg`,
  ]),
  opt("VAL-27", "aggregate: float suffix", "(agg) = { d: 1.5f }", "invalid digit in decimal floating-point literal", [
    `invalid-option @ ${FO}/p.agg`,
  ]),
  opt("VAL-28", "aggregate: int from a float literal", "(agg) = { i: 1.0 }", "mismatched types", [
    `invalid-option @ ${FO}/p.agg`,
  ]),
  opt(
    "VAL-29",
    "aggregate: text-format spellings buf accepts (True, t, INF, Infinity, NaN, enum numbers, hex int)",
    "(agg) = { b: True sub { b: t d: INF } e: 7 d: -Infinity i: 0x10 }",
  ),
  // A-5: a sub-path and an aggregate on the same option
  opt(
    "VAL-30",
    "A-5: aggregate after a sub-path",
    "(agg).i = 1; option (agg) = { b: true }",
    "message extension `p.agg` set multiple times",
    [`invalid-option @ ${FO}/p.agg`],
  ),
  opt(
    "VAL-31",
    "A-5: aggregate after a nested sub-path",
    "(agg).sub.i = 1; option (agg) = { sub { b: true } }",
    "set multiple times",
    [`invalid-option @ ${FO}/p.agg`],
  ),
  opt("VAL-32", "A-5: two aggregates", "(agg) = { i: 1 }; option (agg) = { b: true }", "set multiple times", [
    `invalid-option @ ${FO}/p.agg`,
  ]),
  opt("VAL-33", "A-5: a sub-path after an aggregate merges (buf accepts)", "(agg) = { b: true }; option (agg).i = 1"),
  opt(
    "VAL-34",
    "a sub-path set twice",
    "(agg).i = 1; option (agg).i = 2",
    "message field `p.Agg.i` set multiple times",
    [`invalid-option @ ${FO}/p.agg`],
  ),
  def("VAL-35", "default: int32 from a float", "optional int32 a = 1 [default = 1.5];", "mismatched types", [
    `invalid-option @ ${M}/properties/a`,
  ]),
  def("VAL-36", "default: string from a number", "optional string a = 1 [default = 5];", "mismatched types", [
    `invalid-option @ ${M}/properties/a`,
  ]),
  def(
    "VAL-37",
    "default: unknown enum value",
    "optional E2 a = 1 [default = NOPE];",
    "cannot find `NOPE` in this scope",
    [`invalid-option @ ${M}/properties/a`],
  ),
  def("VAL-38", "default: invalid UTF-8 string", 'optional string a = 1 [default = "\\377"];', "invalid UTF-8", [
    `invalid-option @ ${M}/properties/a`,
  ]),
  def(
    "VAL-39",
    "default: int32 out of range",
    "optional int32 a = 1 [default = 2147483648];",
    "literal out of range for `int32`",
    [`invalid-option @ ${M}/properties/a`],
  ),
  def("VAL-40", "default: bool 1", "optional bool a = 1 [default = 1];", "mismatched types", [
    `invalid-option @ ${M}/properties/a`,
  ]),
  def("VAL-41", "default: bool True", "optional bool a = 1 [default = True];", "non-canonical `bool` literal", [
    `invalid-option @ ${M}/properties/a`,
  ]),
  def(
    "VAL-42",
    "default: double INF",
    "optional double a = 1 [default = INF];",
    "non-canonical floating-point literal",
    [`invalid-option @ ${M}/properties/a`],
  ),
  def(
    "VAL-43",
    "default: double hex",
    "optional double a = 1 [default = 0x10];",
    "unsupported base for floating-point literal",
    [`invalid-option @ ${M}/properties/a`],
  ),
  def(
    "VAL-44",
    "default: uint32 negative",
    "optional uint32 a = 1 [default = -1];",
    "literal out of range for `uint32`",
    [`invalid-option @ ${M}/properties/a`],
  ),
  def(
    "VAL-45",
    "defaults buf accepts: float inf, enum by name, int from 1e3",
    "optional float a = 1 [default = inf]; optional E2 b = 2 [default = B]; optional int32 c = 3 [default = 1e3];",
  ),
  {
    id: "VAL-46",
    title: "features: unknown enum identifier",
    sources: { "a.proto": `${E("2023")}option features.enum_type = WRONG;\n` },
    buf: "cannot find `WRONG` in this scope",
    issues: ["invalid-option @ #/files/a.proto/options/features"],
  },
  {
    id: "VAL-47",
    title: "features: the UNKNOWN (zero) value",
    sources: { "a.proto": `${E("2023")}option features.enum_type = ENUM_TYPE_UNKNOWN;\n` },
    buf: "feature field `enum_type` must resolve to a known value",
    issues: ["invalid-option @ #/files/a.proto/options/features"],
  },
  {
    id: "VAL-48",
    title: "json_name on an extension",
    sources: {
      "a.proto": `${P2}message M { extensions 10 to 20; }\nextend M { optional int32 x = 10 [json_name = "y"]; }\n`,
    },
    buf: "message extension cannot specify `json_name`",
    issues: ["invalid-option @ #/components/extensions/p.x"],
  },
  {
    id: "VAL-49",
    title: "packed in editions (true and false)",
    sources: {
      "a.proto": `${E("2023")}message M { repeated int32 x = 1 [packed = true]; repeated int32 y = 2 [packed = false]; }\n`,
    },
    buf: "`packed` is not supported in Edition 2023",
    issues: [
      "invalid-option @ #/components/messages/p.M/properties/x/options/packed",
      "invalid-option @ #/components/messages/p.M/properties/y/options/packed",
    ],
  },
  {
    id: "VAL-50",
    title: "file-level LEGACY_REQUIRED",
    sources: {
      "a.proto": `${E("2023")}option features.field_presence = LEGACY_REQUIRED;\nmessage M { int32 x = 1; }\n`,
    },
    buf: "cannot set `LEGACY_REQUIRED` at the file level",
    issues: ["invalid-option @ #/files/a.proto/options/features"],
  },
  // ---- option targets and edition support (generic, from the definitions) ----------------------------------------
  {
    id: "VAL-51",
    title: "IN-5e: a feature on the wrong target (field_presence on a message)",
    sources: { "a.proto": `${E("2023")}message M { option features.field_presence = IMPLICIT; int32 x = 1; }\n` },
    buf: "unsupported option target for `field_presence`",
    issues: ["invalid-option @ #/components/messages/p.M/options/features"],
  },
  {
    id: "VAL-52",
    title: "a custom option on the wrong target (targets = TARGET_TYPE_MESSAGE on a field)",
    sources: {
      "a.proto": `${P2}extend google.protobuf.FieldOptions { optional int32 t = 50001 [targets = TARGET_TYPE_MESSAGE]; }\nmessage M { optional int32 a = 1 [(t) = 1]; }\n`,
    },
    buf: "unsupported option target for `t`",
    issues: ["invalid-option @ #/components/messages/p.M/properties/a/options/p.t"],
  },
  {
    id: "VAL-53",
    title: "2026: enforce_proto_limits at file level (targets exclude FILE)",
    sources: { "a.proto": `${E("2026")}option features.enforce_proto_limits = LEGACY_NO_EXPLICIT_LIMITS;\n` },
    buf: "unsupported option target for `enforce_proto_limits`",
    issues: ["invalid-option @ #/files/a.proto/options/features"],
  },
  {
    id: "VAL-54",
    title: "features in proto3 and proto2",
    sources: {
      "a.proto": `${P3}option features.field_presence = IMPLICIT;\n`,
      "b.proto":
        'syntax = "proto2";\npackage q;\nmessage M { optional int32 x = 1 [features.field_presence = IMPLICIT]; }\n',
    },
    buf: '`features` cannot be set in "proto3"',
    issues: [
      "invalid-definition @ #/files/a.proto/options/features",
      "invalid-definition @ #/components/messages/q.M/properties/x/options/features",
    ],
  },
  {
    id: "VAL-55",
    title: "2023: enforce_naming_style was introduced in 2024 (feature_support)",
    sources: { "a.proto": `${E("2023")}option features.enforce_naming_style = STYLE2024;\n` },
    buf: "`enforce_naming_style` is not supported in Edition 2023",
    issues: ["invalid-definition @ #/files/a.proto/options/features"],
  },
  {
    id: "VAL-56",
    title: "2024: java_multiple_files was removed in 2024 (feature_support)",
    sources: { "a.proto": `${E("2024")}option java_multiple_files = true;\n` },
    buf: "`java_multiple_files` is not supported in Edition 2024",
    issues: ["invalid-definition @ #/files/a.proto/options/java_multiple_files"],
  },
  {
    id: "VAL-57",
    title: "2026: cc_enable_arenas was removed in 2026, also when set to its default",
    sources: { "a.proto": `${E("2026")}option cc_enable_arenas = true;\n` },
    buf: "`cc_enable_arenas` is not supported in Edition 2026",
    issues: ["invalid-definition @ #/files/a.proto/options/cc_enable_arenas"],
  },
  {
    id: "VAL-58",
    title: "2024: ctype",
    sources: { "a.proto": `${E("2024")}message M { string a = 1 [ctype = CORD]; }\n` },
    buf: "`ctype` is not supported in Edition 2024",
    issues: ["invalid-definition @ #/components/messages/p.M/properties/a/options/ctype"],
  },
  {
    id: "VAL-59",
    title: "language features in their editions (buf accepts)",
    sources: {
      "a.proto": `${E("2023")}import "google/protobuf/cpp_features.proto";\nimport "google/protobuf/java_features.proto";\noption features.(pb.cpp).string_type = VIEW;\noption features.(pb.java).legacy_closed_enum = true;\nmessage M { string s = 1 [features.(pb.cpp).string_type = CORD]; }\n`,
    },
  },
  {
    id: "VAL-60",
    title: "2024: a language feature introduced in 2024 and a removed feature value",
    sources: {
      "a.proto": `${E("2023")}import "google/protobuf/java_features.proto";\nmessage M { option features.(pb.java).nest_in_file_class = YES; }\n`,
      "b.proto":
        'edition = "2024";\npackage q;\nimport "google/protobuf/java_features.proto";\nmessage M { option features.(pb.java).nest_in_file_class = LEGACY; }\n',
    },
    buf: "`nest_in_file_class` is not supported in Edition 2023",
    issues: [
      "invalid-definition @ #/components/messages/p.M/options/features",
      "invalid-definition @ #/components/messages/q.M/options/features",
    ],
  },
  // ---- kinds (unresolved-type, wrong kind) --------------------------------------------------------------------------
  ...[
    "enum E { E0 = 0; }\nmessage M { map<E, int32> m = 1; }",
    "message M { map<float, int32> m = 1; }",
    "message M { map<double, int32> m = 1; }",
    "message M { map<bytes, int32> m = 1; }",
    "message K {}\nmessage M { map<K, int32> m = 1; }",
  ].map((body, i): Case => ({
    id: `VAL-${61 + i}`,
    title: `map key kind: ${/map<(\w+)/.exec(body)?.[1]}`,
    sources: { "a.proto": `${P3}${body}\n` },
    buf: "expected map key type",
    issues: ["unresolved-type @ #/components/messages/p.M/properties/m/propertyNames"],
  })),
  {
    id: "VAL-66",
    title: "map keys buf accepts: integers, bool, string",
    sources: {
      "a.proto": `${P3}message M { map<int64, int32> a = 1; map<bool, int32> b = 2; map<string, int32> c = 3; map<sfixed32, int32> d = 4; }\n`,
    },
  },
  // ---- numbers and names ----------------------------------------------------------------------------------------------
  {
    id: "VAL-67",
    title: "reserved ranges overlap",
    sources: { "a.proto": `${P2}message M { reserved 1 to 5, 3 to 7; }\n` },
    buf: "overlapping field number ranges",
    issues: [`reserved-conflict @ ${M}/reserved`],
  },
  {
    id: "VAL-68",
    title: "reserved range inverted",
    sources: { "a.proto": `${P2}message M { reserved 5 to 1; }\n` },
    buf: "empty reserved range",
    issues: [`invalid-number @ ${M}/reserved`],
  },
  {
    id: "VAL-69",
    title: "reserved number twice",
    sources: { "a.proto": `${P2}message M { reserved 3; reserved 3; }\n` },
    buf: "overlapping field number ranges",
    issues: [`reserved-conflict @ ${M}/reserved`],
  },
  {
    id: "VAL-70",
    title: "reserved name twice",
    sources: { "a.proto": `${P2}message M { reserved "a", "a"; }\n` },
    buf: "reserved more than once",
    issues: [`reserved-conflict @ ${M}/reserved`],
  },
  {
    id: "VAL-71",
    title: "reserved 0",
    sources: { "a.proto": `${P2}message M { reserved 0; }\n` },
    buf: "field number out of range",
    issues: [`invalid-number @ ${M}/reserved`],
  },
  {
    id: "VAL-72",
    title: "extension ranges overlap",
    sources: { "a.proto": `${P2}message M { extensions 1 to 10; extensions 5 to 20; }\n` },
    buf: "overlapping field number ranges",
    issues: [`duplicate-number @ ${M}/extensions`],
  },
  {
    id: "VAL-73",
    title: "extension range overlaps a reserved range",
    sources: { "a.proto": `${P2}message M { extensions 1 to 10; reserved 5; }\n` },
    buf: "overlapping field number ranges",
    issues: [`reserved-conflict @ ${M}/extensions`],
  },
  {
    id: "VAL-74",
    title: "extension range inverted",
    sources: { "a.proto": `${P2}message M { extensions 10 to 1; }\n` },
    buf: "empty extension range",
    issues: [`invalid-number @ ${M}/extensions`],
  },
  {
    id: "VAL-75",
    title: "a field number inside an extension range",
    sources: { "a.proto": `${P2}message M { extensions 1 to 10; optional int32 a = 5; }\n` },
    buf: "use of reserved field number `5`",
    issues: [`invalid-number @ ${M}/properties/a`],
  },
  {
    id: "VAL-76",
    title: "an extension number outside the extendee's ranges",
    sources: { "a.proto": `${P2}message M { extensions 1 to 10; }\nextend M { optional int32 x = 20; }\n` },
    buf: "extension with unreserved number `20`",
    issues: ["invalid-number @ #/components/extensions/p.x"],
  },
  {
    id: "VAL-77",
    title: "two extensions with one number",
    sources: {
      "a.proto": `${P2}message M { extensions 1 to 10; }\nextend M { optional int32 x = 2; optional int32 y = 2; }\n`,
    },
    buf: "field number `2` used more than once",
    issues: ["duplicate-number @ #/components/extensions/p.y"],
  },
  {
    id: "VAL-78",
    title: "ranges buf accepts: adjacent reserved and extension ranges, message-set maximum (C-7, editions)",
    sources: { "a.proto": `${P2}message M { reserved 1 to 5, 6; extensions 7 to 10, 11 to max; }\n` },
  },
  {
    id: "VAL-78.editions",
    title: "C-7: `reserved N to max` in a message set ends at 2147483646",
    sources: {
      "a.proto":
        'edition = "2023";\npackage p;\nmessage S { option message_set_wire_format = true; extensions 4 to 999; reserved 1000 to max; }\n',
    },
    check: (r, x) => x(r.document.components?.messages?.["p.S"]?.reserved?.numbers).toEqual([[1000, 2147483646]]),
  },
  {
    id: "VAL-78.proto2",
    title: "C-7 in proto2: protoc's 2147483646, which buf 1.75 fails to serialize (its own failure, not a rule)",
    sources: {
      "a.proto": `${P2}message S { option message_set_wire_format = true; extensions 4 to 999; reserved 1000 to max; }\n`,
    },
    buf: "reserved ranges has invalid field number: 2147483646",
    check: (r, x) => x(r.document.components?.messages?.["p.S"]?.reserved?.numbers).toEqual([[1000, 2147483646]]),
  },
  {
    id: "VAL-79",
    title: "duplicate enum numbers without allow_alias",
    sources: { "a.proto": `${P2}enum E { A = 0; B = 0; }\n` },
    buf: "enum value `0` used more than once",
    issues: ["duplicate-number @ #/components/enums/p.E/values/B"],
  },
  {
    id: "VAL-80",
    title: "allow_alias without aliases",
    sources: { "a.proto": `${P2}enum E { option allow_alias = true; A = 0; B = 1; }\n` },
    buf: "`allow_alias` requires at least one aliasing enum value",
    issues: ["invalid-option @ #/components/enums/p.E/options/allow_alias"],
  },
  {
    id: "VAL-81",
    title: "an enum value in a reserved number",
    sources: { "a.proto": `${P2}enum E { A = 0; B = 1; reserved 1; }\n` },
    buf: "use of reserved enum value `1`",
    issues: ["reserved-conflict @ #/components/enums/p.E/values/B"],
  },
  {
    id: "VAL-82",
    title: "an enum value with a reserved name",
    sources: { "a.proto": `${P2}enum E { A = 0; B = 1; reserved "B"; }\n` },
    buf: "use of reserved enum value name",
    issues: ["reserved-conflict @ #/components/enums/p.E/values/B"],
  },
  {
    id: "VAL-83",
    title: "enum reserved range inverted",
    sources: { "a.proto": `${P2}enum E { A = 0; reserved 5 to 1; }\n` },
    buf: "empty reserved range",
    issues: ["invalid-number @ #/components/enums/p.E/reserved"],
  },
  {
    id: "VAL-84",
    title: "enum reserved ranges overlap",
    sources: { "a.proto": `${P2}enum E { A = 0; reserved 1 to 5, 4; }\n` },
    buf: "overlapping enum value ranges",
    issues: ["reserved-conflict @ #/components/enums/p.E/reserved"],
  },
  {
    id: "VAL-85",
    title: "two enums of one scope with a value of the same name",
    sources: { "a.proto": `${P2}enum E { A = 0; }\nenum F { A = 1; }\n` },
    buf: "`A` declared multiple times",
    issues: ["duplicate-name @ #/components/enums/p.F/values/A"],
  },
  {
    id: "VAL-86",
    title: "an enum value named like a message",
    sources: { "a.proto": `${P2}enum E { A = 0; }\nmessage A {}\n` },
    buf: "`A` declared multiple times",
    issues: ["duplicate-name @ #/components/enums/p.E/values/A"],
  },
  {
    id: "VAL-87",
    title: "a field named like a nested message",
    sources: { "a.proto": `${P2}message M { message Foo {} optional int32 Foo = 1; }\n` },
    buf: "`Foo` declared multiple times",
    issues: [`duplicate-name @ ${M}/properties/Foo`],
  },
  {
    id: "VAL-88",
    title: "a field named like a nested enum",
    sources: { "a.proto": `${P2}message M { enum Foo { X = 0; } optional int32 Foo = 1; }\n` },
    buf: "`Foo` declared multiple times",
    issues: [`duplicate-name @ ${M}/properties/Foo`],
  },
  {
    id: "VAL-89",
    title: "a field named like a oneof",
    sources: { "a.proto": `${P3}message M { oneof foo { int32 a = 1; } int32 foo = 2; }\n` },
    buf: "`foo` declared multiple times",
    issues: [`duplicate-name @ ${M}/oneofs/foo`],
  },
  {
    id: "VAL-90",
    title: "a map field whose entry name is taken",
    sources: { "a.proto": `${P3}message M { map<string,int32> foo_bar = 1; message FooBarEntry {} }\n` },
    buf: "`FooBarEntry` declared multiple times",
    issues: [`duplicate-name @ ${M}/properties/foo_bar`],
  },
  {
    id: "VAL-91",
    title: "JSON name clash in proto3",
    sources: { "a.proto": `${P3}message M { int32 foo_bar = 1; int32 fooBar = 2; }\n` },
    buf: "message fields have the same JSON name",
    issues: [`duplicate-name @ ${M}/properties/fooBar`],
  },
  {
    id: "VAL-92",
    title: "JSON name clash of custom names in proto2",
    sources: {
      "a.proto": `${P2}message M { optional int32 a = 1 [json_name = "x"]; optional int32 b = 2 [json_name = "x"]; }\n`,
    },
    buf: "message fields have the same JSON name",
    issues: [`duplicate-name @ ${M}/properties/b`],
  },
  {
    id: "VAL-93",
    title: "JSON name clash of a custom and a default name in proto2",
    sources: { "a.proto": `${P2}message M { optional int32 a = 1 [json_name = "b"]; optional int32 b = 2; }\n` },
    buf: "message fields have the same JSON name",
    issues: [`duplicate-name @ ${M}/properties/b`],
  },
  {
    id: "VAL-94",
    title: "JSON name clash in editions (json_format ALLOW)",
    sources: { "a.proto": `${E("2023")}message M { int32 foo_bar = 1; int32 fooBar = 2; }\n` },
    buf: "message fields have the same JSON name",
    issues: [`duplicate-name @ ${M}/properties/fooBar`],
  },
  {
    id: "VAL-95",
    title: "JSON names buf accepts: default-name clash in proto2 and under LEGACY_BEST_EFFORT; case differs",
    sources: {
      "a.proto": `${P2}message M { optional int32 foo_bar = 1; optional int32 fooBar = 2; }\n`,
      "b.proto":
        'edition = "2023";\npackage q;\nmessage M { option features.json_format = LEGACY_BEST_EFFORT; int32 foo_bar = 1; int32 fooBar = 2; }\nmessage N { int32 foo = 1; int32 Foo = 2; }\n',
    },
  },
  {
    id: "VAL-96",
    title: "proto3 enum values equal without the enum prefix",
    sources: { "a.proto": `${P3}enum E { E_UNSPECIFIED = 0; UNSPECIFIED = 1; }\n` },
    buf: "enum values have the same name with the `E` prefix removed",
    issues: ["duplicate-name @ #/components/enums/p.E/values/UNSPECIFIED"],
  },
  {
    id: "VAL-97",
    title: "proto3 enum values equal ignoring case",
    sources: { "a.proto": `${P3}enum E { A = 0; a = 1; }\n` },
    buf: "enum values have the same name with the `E` prefix removed",
    issues: ["duplicate-name @ #/components/enums/p.E/values/a"],
  },
  {
    id: "VAL-98",
    title: "enum names buf accepts: proto2 case clash, aliases, FOO_BAR_BAZ vs FOO_BARBAZ",
    sources: {
      "a.proto": `${P2}enum E { A = 0; a = 1; }\n`,
      "b.proto":
        'syntax = "proto3";\npackage q;\nenum F { option allow_alias = true; F_X = 0; X = 0; }\nenum Foo { FOO_BAR_BAZ = 0; FOO_BARBAZ = 1; }\n',
    },
  },
  // ---- syntax and edition rules (invalid-definition) -------------------------------------------------------------
  {
    id: "VAL-99",
    title: "proto3 required",
    sources: { "a.proto": `${P3}message M { required int32 a = 1; }\n` },
    buf: "unexpected `required`",
    issues: [`invalid-definition @ ${M}/properties/a`],
  },
  {
    id: "VAL-100",
    title: "proto3 group",
    sources: { "a.proto": `${P3}message M { optional group G = 1 { optional int32 a = 1; } }\n` },
    buf: "group syntax is not supported",
    issues: [`invalid-definition @ ${M}/properties/g`],
  },
  {
    id: "VAL-101",
    title: "proto3 first enum value not zero",
    sources: { "a.proto": `${P3}enum E { A = 1; B = 0; }\n` },
    buf: "first value of open enum must be zero",
    issues: ["invalid-definition @ #/components/enums/p.E/values/A"],
  },
  {
    id: "VAL-102",
    title: "editions open enum first value not zero",
    sources: { "a.proto": `${E("2023")}enum E { A = 1; B = 0; }\n` },
    buf: "first value of open enum must be zero",
    issues: ["invalid-definition @ #/components/enums/p.E/values/A"],
  },
  {
    id: "VAL-103",
    title: "editions closed enum may start with any value (buf accepts)",
    sources: { "a.proto": `${E("2023")}enum E { option features.enum_type = CLOSED; A = 1; B = 0; }\n` },
  },
  {
    id: "VAL-104",
    title: "a closed proto2 enum in a proto3 message (singular, optional, repeated)",
    sources: {
      "a.proto": `${P3}import "b.proto";\nmessage M { q.E a = 1; optional q.E b = 2; repeated q.E c = 3; }\n`,
      "b.proto": 'syntax = "proto2";\npackage q;\nenum E { A = 1; }\n',
    },
    entry: ["a.proto"],
    buf: 'closed enum `q.E` cannot be used in a "proto3" message',
    issues: [
      `invalid-definition @ ${M}/properties/a`,
      `invalid-definition @ ${M}/properties/b`,
      `invalid-definition @ ${M}/properties/c`,
    ],
  },
  {
    id: "VAL-105",
    title: "editions: a closed enum on an implicit-presence field",
    sources: {
      "a.proto": `${E("2023")}enum E { option features.enum_type = CLOSED; A = 1; }\nmessage M { E e = 1 [features.field_presence = IMPLICIT]; }\n`,
    },
    buf: "closed enum `p.E` cannot be used in an implicit-presence field",
    issues: [`invalid-definition @ ${M}/properties/e`],
  },
  {
    id: "VAL-106",
    title: "editions optional label",
    sources: { "a.proto": `${E("2023")}message M { optional int32 a = 1; }\n` },
    buf: "unexpected `optional`",
    issues: [`invalid-definition @ ${M}/properties/a`],
  },
  {
    id: "VAL-107",
    title: "editions required label",
    sources: { "a.proto": `${E("2023")}message M { required int32 a = 1; }\n` },
    buf: "unexpected `required`",
    issues: [`invalid-definition @ ${M}/properties/a`],
  },
  {
    id: "VAL-108",
    title: "editions group (parsed best-effort, the rest of the file still builds)",
    sources: { "a.proto": `${E("2023")}message M { group G = 1 { int32 a = 1; } int32 b = 2; }\n` },
    buf: "group syntax is not supported",
    issues: [`invalid-definition @ ${M}/properties/g`],
    check: (r, x) => x(Object.keys(r.document.components?.messages?.["p.M"]?.properties ?? {})).toEqual(["g", "b"]),
  },
  {
    id: "VAL-109",
    title: "2023 export",
    sources: { "a.proto": `${E("2023")}export message M {}\n` },
    buf: "`export` is not supported in Edition 2023",
    issues: [`invalid-definition @ ${M}`],
  },
  {
    id: "VAL-110",
    title: "2023 local",
    sources: { "a.proto": `${E("2023")}local enum E { E_UNKNOWN = 0; }\n` },
    buf: "`local` is not supported in Edition 2023",
    issues: ["invalid-definition @ #/components/enums/p.E"],
  },
  {
    id: "VAL-111",
    title: "2023 import option",
    sources: { "a.proto": `${E("2023")}import option "google/protobuf/descriptor.proto";\n` },
    buf: "`import option` is not supported in Edition 2023",
    issues: ["invalid-definition @ #/files/a.proto/imports/0"],
  },
  {
    id: "VAL-112",
    title: "2024 import weak",
    sources: {
      "a.proto": `${E("2024")}import weak "b.proto";\n`,
      "b.proto": 'edition = "2024";\npackage q;\nmessage B {}\n',
    },
    entry: ["a.proto"],
    buf: "`import weak` is not supported in Edition 2024",
    issues: ["invalid-definition @ #/files/a.proto/imports/0"],
  },
  {
    id: "VAL-113",
    title: "2024 an import after `import option`",
    sources: {
      "a.proto": `${E("2024")}import option "google/protobuf/descriptor.proto";\nimport "b.proto";\n`,
      "b.proto": 'edition = "2024";\npackage q;\nmessage B {}\n',
    },
    entry: ["a.proto"],
    buf: "import after `import option`",
    issues: ["invalid-definition @ #/files/a.proto/imports/1"],
  },
  {
    id: "VAL-114",
    title: 'syntax = "proto4": reported, read as proto2',
    sources: { "a.proto": 'syntax = "proto4";\npackage p;\nmessage M { optional int32 a = 1; }\n' },
    buf: "unrecognized `syntax` declaration value",
    issues: ["invalid-definition @ #/files/a.proto/syntax"],
    check: (r, x) => {
      x(r.document.files?.["a.proto"]?.syntax).toBe("proto2")
      x(r.document.components?.messages?.["p.M"]?.properties.a.presence).toBe("explicit")
    },
  },
  {
    id: "VAL-115",
    title: "a second package statement (the first wins)",
    sources: { "a.proto": `${P3}package q;\nmessage M {}\n` },
    buf: "unexpected `package` declaration",
    issues: ["invalid-definition @ #/files/a.proto/package"],
    check: (r, x) => x(Object.keys(r.document.components?.messages ?? {})).toEqual(["p.M"]),
  },
  {
    id: "VAL-116",
    title: "syntax not first",
    sources: { "a.proto": 'package p;\nsyntax = "proto3";\n' },
    buf: "unexpected `syntax` declaration",
    issues: ["invalid-definition @ #/files/a.proto/syntax"],
  },
  {
    id: "VAL-117",
    title: "syntax twice",
    sources: { "a.proto": 'syntax = "proto3";\nsyntax = "proto3";\n' },
    buf: "unexpected `syntax` declaration",
    issues: ["invalid-definition @ #/files/a.proto/syntax"],
  },
  {
    id: "VAL-118",
    title: "syntax and edition",
    sources: { "a.proto": 'syntax = "proto3";\nedition = "2023";\n' },
    buf: "unexpected `edition` declaration",
    issues: ["invalid-definition @ #/files/a.proto/syntax"],
  },
  {
    id: "VAL-119",
    title: "a file that imports itself",
    sources: { "a.proto": `${P3}import "a.proto";\n` },
    buf: 'detected cyclic import while importing "a.proto"',
    issues: ["invalid-definition @ #/files/a.proto/imports/0"],
  },
  {
    id: "VAL-120",
    title: "a file imported twice",
    sources: {
      "a.proto": `${P3}import "b.proto";\nimport "b.proto";\n`,
      "b.proto": 'syntax = "proto3";\npackage q;\n',
    },
    entry: ["a.proto"],
    buf: "file imported multiple times",
    issues: ["invalid-definition @ #/files/a.proto/imports/1"],
  },
  {
    id: "VAL-121",
    title: "an import cycle (reported at the import that closes it)",
    sources: {
      "a.proto": `${P3}import "b.proto";\n`,
      "b.proto": 'syntax = "proto3";\npackage q;\nimport "a.proto";\n',
    },
    entry: ["a.proto"],
    buf: 'detected cyclic import while importing "a.proto"',
    issues: ["invalid-definition @ #/files/b.proto/imports/0"],
  },
  {
    id: "VAL-122",
    title: "an empty oneof",
    sources: { "a.proto": `${P2}message M { oneof o { } }\n` },
    buf: "oneof must define at least one member",
    issues: [`invalid-definition @ ${M}/oneofs/o`],
  },
  {
    id: "VAL-123",
    title: "proto3 extension range",
    sources: { "a.proto": `${P3}message M { extensions 1 to 10; }\n` },
    buf: 'extension range in "proto3"',
    issues: [`invalid-definition @ ${M}/extensions`],
  },
  {
    id: "VAL-124",
    title: "proto3 extend of a non-options message",
    sources: {
      "a.proto": `${P3}import "b.proto";\nextend q.B { int32 x = 10; }\n`,
      "b.proto": 'syntax = "proto2";\npackage q;\nmessage B { extensions 1 to 100; }\n',
    },
    entry: ["a.proto"],
    buf: "expected built-in options message",
    issues: ["invalid-definition @ #/components/extensions/p.x"],
  },
  {
    id: "VAL-125",
    title: "a required extension",
    sources: { "a.proto": `${P2}message M { extensions 1 to 10; }\nextend M { required int32 x = 1; }\n` },
    buf: "message extension cannot be required",
    issues: ["invalid-definition @ #/components/extensions/p.x"],
  },
  {
    id: "VAL-126",
    title: "a proto2 field without a label",
    sources: { "a.proto": `${P2}message M { int32 x = 1; }\n` },
    buf: "unexpected type name",
    issues: [`invalid-definition @ ${M}/properties/x`],
  },
  // ---- naming style (edition 2024 STYLE2024, 2026 STYLE2026) --------------------------------------------------------
  ...(["2024", "2026"] as const).flatMap((ed, k): Case[] => {
    const id = (n: number) => `VAL-${130 + k * 20 + n}`
    const H = (pkg = "p") => `edition = "${ed}";\npackage ${pkg};\n`
    const style = (n: number, title: string, text: string, bufError: string, pointer: string): Case => ({
      id: id(n),
      title: `${ed} naming: ${title}`,
      sources: { "a.proto": text },
      buf: bufError,
      issues: [`invalid-definition @ ${pointer}`],
    })
    return [
      style(
        0,
        "package not lower_snake_case",
        H("P.q"),
        "package name should be lower_snake_case",
        "#/files/a.proto/package",
      ),
      style(
        1,
        "package component v1_2",
        H("foo.v1_2"),
        "package name should be lower_snake_case",
        "#/files/a.proto/package",
      ),
      style(
        2,
        "message not PascalCase",
        `${H()}message foo_bar {}\n`,
        "message type name should be PascalCase",
        "#/components/messages/p.foo_bar",
      ),
      style(
        3,
        "field camelCase",
        `${H()}message M { int32 fooBar = 1; }\n`,
        "field name should be snake_case",
        `${M}/properties/fooBar`,
      ),
      style(
        4,
        "field foo_2",
        `${H()}message M { int32 foo_2 = 1; }\n`,
        "field name should be snake_case",
        `${M}/properties/foo_2`,
      ),
      style(
        5,
        "oneof camelCase",
        `${H()}message M { oneof fooBar { int32 a = 1; } }\n`,
        "oneof name should be snake_case",
        `${M}/oneofs/fooBar`,
      ),
      style(
        6,
        "enum not PascalCase",
        `${H()}enum e { E_UNSPECIFIED = 0; }\n`,
        "enum type name should be PascalCase",
        "#/components/enums/p.e",
      ),
      style(
        7,
        "enum value lower case",
        `${H()}enum E { e_unspecified = 0; }\n`,
        "enum value name should be SCREAMING_SNAKE_CASE",
        "#/components/enums/p.E/values/e_unspecified",
      ),
      style(
        8,
        "enum value E_2",
        `${H()}enum E { E_2 = 0; }\n`,
        "enum value name should be SCREAMING_SNAKE_CASE",
        "#/components/enums/p.E/values/E_2",
      ),
      style(9, "service not PascalCase", `${H()}service s {}\n`, "service name should be PascalCase", "#/services/p.s"),
      style(
        10,
        "method not PascalCase",
        `${H()}message M {}\nservice S { rpc foo (M) returns (M); }\n`,
        "RPC method name should be PascalCase",
        "#/services/p.S/methods/foo",
      ),
      style(
        11,
        "extension camelCase",
        `${H()}import "google/protobuf/descriptor.proto";\nextend google.protobuf.FieldOptions { int32 fooBar = 50001; }\n`,
        "extension name should be snake_case",
        "#/components/extensions/p.fooBar",
      ),
      style(
        12,
        "map field camelCase",
        `${H()}message M { map<string, int32> fooBar = 1; }\n`,
        "field name should be snake_case",
        `${M}/properties/fooBar`,
      ),
      {
        id: id(13),
        title: `${ed} naming: names buf accepts (ALLCAPS and acronyms, digits, no prefix) and STYLE_LEGACY`,
        sources: {
          "a.proto": `${H("p1.v2_beta.foo_bar")}message FOO { int32 foo2 = 1; }\nmessage FooHTTPBar {}\nmessage Foo2bar {}\nenum E { UNSPECIFIED = 0; FOO_BAR2 = 1; }\n`,
          "b.proto": `${H("Foo")}option features.enforce_naming_style = STYLE_LEGACY;\nmessage foo_bar { int32 Foo = 1; }\n`,
        },
      },
    ]
  }),
  // ---- STRICT visibility rules ------------------------------------------------------------------------------------
  {
    id: "VAL-170",
    title: "STRICT: a nested message marked export",
    sources: {
      "a.proto": `${E("2024")}option features.default_symbol_visibility = STRICT;\nmessage Outer { export message Inner {} }\n`,
    },
    buf: "nested message type marked as exported",
    issues: ["invalid-definition @ #/components/messages/p.Outer.Inner/options/visibility"],
  },
  {
    id: "VAL-171",
    title: "STRICT: a nested enum exported from an exported message",
    sources: {
      "a.proto": `${E("2026")}export message Outer { export enum E { E_UNSPECIFIED = 0; } reserved 1 to max; }\n`,
    },
    buf: "nested enum type marked as exported",
    issues: ["invalid-definition @ #/components/enums/p.Outer.E/options/visibility"],
  },
  {
    id: "VAL-172",
    title: "STRICT: a nested enum exported from a message that does not reserve all numbers",
    sources: { "a.proto": `${E("2026")}message Outer { export enum E { E_UNSPECIFIED = 0; } }\n` },
    buf: "does not reserve all field numbers",
    issues: ["invalid-definition @ #/components/enums/p.Outer.E/options/visibility"],
  },
  {
    id: "VAL-173",
    title: "STRICT: a nested enum exported from a message with two reserved ranges",
    sources: {
      "a.proto": `${E("2026")}message Outer { export enum E { E_UNSPECIFIED = 0; } reserved 1 to 100, 101 to max; }\n`,
    },
    buf: "expected exactly one reserved range",
    issues: ["invalid-definition @ #/components/enums/p.Outer.E/options/visibility"],
  },
  {
    id: "VAL-174",
    title: "an enum without values",
    sources: { "a.proto": `${P2}enum E {}\n` },
    buf: "enum type must define at least one value",
    issues: ["invalid-definition @ #/components/enums/p.E"],
  },
  {
    id: "VAL-175",
    title: "reserved names: identifiers in proto3 / proto2",
    sources: {
      "a.proto": `${P3}message M { reserved foo; }\n`,
      "b.proto": 'syntax = "proto2";\npackage q;\nenum E { A = 0; reserved foo; }\n',
    },
    buf: "cannot use identifiers in reserved range in syntax mode",
    issues: [
      "invalid-definition @ #/components/messages/p.M/reserved",
      "invalid-definition @ #/components/enums/q.E/reserved",
    ],
  },
  {
    id: "VAL-176",
    title: "reserved names: string literals in editions",
    sources: { "a.proto": `${E("2023")}message M { reserved "foo"; }\nenum E { A = 0; reserved "bar"; }\n` },
    buf: "cannot use string literals in reserved range in editions mode",
    issues: [
      "invalid-definition @ #/components/messages/p.M/reserved",
      "invalid-definition @ #/components/enums/p.E/reserved",
    ],
  },
  {
    id: "VAL-177",
    title: "reserved names that are not identifiers",
    sources: { "a.proto": `${P3}message M { reserved "foo bar", ""; }\n` },
    buf: "reserved message field name is not a valid identifier",
    issues: [
      "invalid-definition @ #/components/messages/p.M/reserved",
      "invalid-definition @ #/components/messages/p.M/reserved",
    ],
  },
]
