// Source-map positions of the text producer against buf's SourceCodeInfo (C-8 / decision D-A: tab stops of 4, no
// width for a BOM, `\r`, `\f`, `\v`), option statement spans (IN-5, C-10) and syntax-error locations (text#14).

import type { Case } from "./types.ts"

const span = (
  r: { sourceMap: Record<string, { start: { line: number; column: number }; end: { line: number; column: number } }> },
  p: string,
) => {
  const l = r.sourceMap[p]
  return l && `${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}`
}
const F = "#/components/messages/p.M/properties"
const OPTS = 'import "google/protobuf/descriptor.proto";\nmessage A { optional int32 i = 1; }\n'

export const cases: Case[] = [
  {
    id: "POS-1",
    title: "C-8: tabs advance to the next multiple of 4 (buf's tab stop)",
    sources: {
      "a.proto":
        'syntax = "proto3";\npackage p;\nmessage M {\n\tint32\ta = 1;\n  int32 b\t= 2;\n\t\tint32 c = 3;\n  int32 d =\t\t4;\nint32\tabc\t= 5;\n}\n',
    },
    check: (r, x) => {
      x(span(r, `${F}/a/type`)).toBe("3:4-3:9")
      x(span(r, `${F}/a/number`)).toBe("3:16-3:17")
      x(span(r, `${F}/abc/number`)).toBe("7:14-7:15")
    },
  },
  {
    id: "POS-2",
    title: "C-8: a byte order mark has no width (also before a tab)",
    sources: {
      "a.proto": '﻿syntax = "proto3";\npackage p;\nmessage M { int32 a = 1; }\n',
      "b.proto": '﻿\tsyntax = "proto3";\npackage q;\nmessage M { int32 a = 1; }\n',
    },
    check: (r, x) => {
      x(span(r, "#/files/a.proto/syntax")).toBe("0:0-0:18")
      x(span(r, "#/files/b.proto/syntax")).toBe("0:4-0:22")
    },
  },
  {
    id: "POS-3",
    title: "CRLF line endings",
    sources: { "a.proto": 'syntax = "proto3";\r\npackage p;\r\nmessage M {\r\n  int32 a = 1;\r\n}\r\n' },
  },
  {
    id: "POS-4",
    title: "CR-only line endings: one line, `\\r` has no width (as buf)",
    sources: { "a.proto": 'syntax = "proto3";\rpackage p;\rmessage M {\r  int32 a = 1;\r}\r' },
    check: (r, x) => x(span(r, `${F}/a`)).toBe("0:41-0:53"),
  },
  {
    id: "POS-5",
    title: "`\\f` and `\\v` have no width",
    sources: { "a.proto": 'syntax = "proto3";\npackage p;\nmessage M {\f int32 a = 1;\n\v int32 b = 2;\n}\n' },
    check: (r, x) => x(span(r, `${F}/b/type`)).toBe("3:1-3:6"),
  },
  {
    id: "POS-6",
    title: "UTF-16 columns: a character outside the BMP counts as two",
    sources: {
      "a.proto":
        'syntax = "proto3";\npackage p;\n// \u{1F600}\nmessage M { /* \u{1F600}é */ int32 a = 1; int32 b = 2 [json_name = "é\u{1F600}"]; int32 c = 3; }\n',
    },
    check: (r, x) => x(span(r, `${F}/a/type`)).toBe("3:22-3:27"),
  },
  {
    id: "POS-7",
    title: "D-A: tabWidth 8 (protoc's tab stop) and 1",
    sources: { "a.proto": 'syntax = "proto3";\npackage p;\nmessage M {\n\tint32\ta = 1;\n}\n' },
    options: { tabWidth: 8 },
    check: (r, x) => {
      x(span(r, `${F}/a/type`)).toBe("3:8-3:13")
      x(span(r, `${F}/a`)).toBe("3:8-3:22")
    },
  },
  {
    id: "POS-8",
    title: "C-10: repeated aggregate options cover the whole statement; singular ones the name to `}`",
    sources: {
      "a.proto": `syntax = "proto2";\npackage p;\n${OPTS}extend google.protobuf.MessageOptions { repeated A aggs = 50001; optional A one = 50002; }\nmessage M {\n  option (aggs) = { i: 1 };\n  option (aggs) = { i: 2 };\n  option (one) = { i: 3 };\n}\n`,
    },
    check: (r, x) => {
      x(span(r, "#/components/messages/p.M/options/p.aggs")).toBe("6:2-6:27")
      x(span(r, "#/components/messages/p.M/options/p.one")).toBe("8:9-8:25")
    },
  },
  {
    id: "POS-9",
    title: "C-10: repeated aggregate options in field options and enum values",
    sources: {
      "a.proto": `syntax = "proto2";\npackage p;\n${OPTS}extend google.protobuf.FieldOptions { repeated A aggs = 50001; }\nextend google.protobuf.EnumValueOptions { repeated A vaggs = 50002; }\nmessage M { optional int32 f = 1 [(aggs) = { i: 1 }, (aggs) = { i: 2 }]; }\nenum E { X = 0 [(vaggs) = { i: 1 }]; }\n`,
    },
  },
  {
    id: "POS-10",
    title: "file-level aggregate options span the name to `}` like other elements; repeated ones the statement",
    sources: {
      "a.proto": `syntax = "proto2";\npackage p;\n${OPTS}extend google.protobuf.FileOptions { optional A one = 50001; repeated A aggs = 50002; }\noption (one) = { i: 1 };\noption (aggs) = { i: 1 };\noption (aggs) = { i: 2 };\n`,
      "b.proto": 'edition = "2023";\npackage q;\noption features = { field_presence: IMPLICIT };\n',
    },
    check: (r, x) => {
      x(span(r, "#/files/a.proto/options/p.one")).toBe("5:7-5:23")
      x(span(r, "#/files/a.proto/options/p.aggs")).toBe("6:0-6:25")
    },
  },
  // ---- syntax-error locations (text#14) -------------------------------------------------------------------------------
  {
    id: "POS-11",
    title: "text#14: an invalid escape is reported at its backslash",
    sources: {
      "a.proto": 'syntax = "proto2";\npackage p;\nmessage M { optional string a = 1 [default = "ab\\qc"]; }\n',
    },
    buf: "invalid escape sequence",
    issues: ["syntax @ * at a.proto:2:48"],
    check: (r, x) => x(r.issues[0].message).toBe("invalid escape sequence"),
  },
  {
    id: "POS-12",
    title: "text#14: an unterminated string is reported at its opening quote",
    sources: { "a.proto": 'syntax = "proto2";\npackage p;\nmessage M { optional string a = 1 [default = "abc]; }\n' },
    buf: "unterminated string literal",
    issues: ["syntax @ * at a.proto:2:45"],
  },
  {
    id: "POS-13",
    title: "text#14: a short \\u escape, an escape in an import path and in an aggregate",
    sources: {
      "a.proto": 'syntax = "proto2";\npackage p;\nmessage M { optional string a = 1 [default = "\\u12"]; }\n',
      "b.proto": 'syntax = "proto2";\npackage q;\nimport "a\\qb.proto";\n',
      "c.proto": `syntax = "proto2";\npackage r;\n${OPTS}extend google.protobuf.FileOptions { optional string s = 50001; }\noption (s) = "x\\q";\n`,
    },
    buf: "invalid escape sequence",
    issues: ["syntax @ * at a.proto:2:46", "syntax @ * at b.proto:2:9", "syntax @ * at c.proto:5:15"],
  },
  {
    id: "POS-14",
    title:
      "a surrogate (even a \\u high + low pair) or a code point above U+10FFFF is an invalid escape at its backslash",
    sources: {
      "a.proto": 'syntax = "proto2";\npackage p;\nmessage M { optional string a = 1 [default = "a\\uD83Dz"]; }\n',
      "b.proto": 'syntax = "proto2";\npackage q;\nmessage M { optional string a = 1 [default = "\\uD83D\\uD83D"]; }\n',
      "c.proto":
        'syntax = "proto2";\npackage r;\nmessage M { optional string a = 1 [default = "ab\\uD83D\\U0000DE00"]; }\n',
      "d.proto":
        'syntax = "proto2";\npackage s;\nmessage M { optional string a = 1 [default = "\\uDE00" "\\U0000D83D"]; }\n',
      "e.proto": 'syntax = "proto2";\npackage t;\nmessage M { optional string a = 1 [json_name = "\\U00110000"]; }\n',
      "f.proto": `syntax = "proto2";\npackage u;\n${OPTS}message B { optional string s = 1; }\nextend google.protobuf.FileOptions { optional B b = 50001; }\noption (b) = { s: "\\uD83D" };\n`,
      "g.proto": 'syntax = "proto2";\npackage v;\nmessage M { optional string a = 1 [default = "\\uD83D\\uDE00"]; }\n',
      "h.proto": `syntax = "proto2";\npackage w;\n${OPTS}message B { optional string s = 1; }\nextend google.protobuf.FileOptions { optional B b = 50002; }\noption (b) = { s: "x\\ud83d\\ude00" };\n`,
    },
    buf: "invalid escape sequence",
    issues: [
      "syntax @ * at a.proto:2:47",
      "syntax @ * at b.proto:2:46",
      "syntax @ * at c.proto:2:48",
      "syntax @ * at d.proto:2:46",
      "syntax @ * at e.proto:2:48",
      "syntax @ * at f.proto:6:19",
      "syntax @ * at g.proto:2:46",
      "syntax @ * at h.proto:6:20",
    ],
    check: (r, x) => x(new Set(r.issues.map((i) => i.message))).toEqual(new Set(["invalid escape sequence"])),
  },
  {
    id: "POS-15",
    title:
      "the first syntax error of a field wins over a malformed token later in the field (no recovery inside a field)",
    sources: {
      "a.proto": 'syntax = "proto2";\npackage p;\nmessage M {\n  optional int32 x 1 [json_name = "\\q"];\n}\n',
      "b.proto":
        'syntax = "proto2";\npackage q;\nmessage M { extensions 1 to 9; }\nextend M {\n  optional int32 x 1 [default = "\\q"];\n}\n',
    },
    buf: "unexpected integer literal",
    issues: ["syntax @ * at a.proto:3:19", "syntax @ * at b.proto:4:19"],
    check: (r, x) => x(r.issues.map((i) => i.message)).toEqual(['expected "=", got "1"', 'expected "=", got "1"']),
  },
]
