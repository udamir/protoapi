// Text front end fixes (phase B): keyword type names (text#13), syntax-error files (text#14), missing imports per
// importer (C-17). buf 1.75 is the oracle.

import type { Case } from "./types.ts"

export const cases: Case[] = [
  {
    id: "TXT-1",
    title: "text#13: label-less fields whose type name is a keyword (proto3)",
    sources: {
      "a.proto": `syntax = "proto3";\npackage p;\nmessage message { message Inner {} }\nmessage enum {}\nmessage reserved {}\nmessage extensions {}\nmessage oneof {}\nmessage extend {}\nmessage optional {}\nmessage repeated {}\nmessage group {}\nmessage M {\n  message message = 5;\n  enum e = 7;\n  reserved r = 2;\n  extensions x = 3;\n  oneof o = 4;\n  extend xt = 6;\n  optional op = 9;\n  repeated rp = 10;\n  message.Inner mi = 11;\n  message /* c */ mc = 12 [deprecated = true];\n  group g = 13;\n  oneof choice { group gg = 14; message mm = 15; }\n  reserved 100;\n  reserved "gone";\n}\n`,
    },
    check: (r, x) =>
      x(r.document.components?.messages?.["p.M"]?.properties.message.$ref).toBe("#/components/messages/p.message"),
  },
  {
    id: "TXT-2",
    title: "text#13: the same names in editions",
    sources: {
      "a.proto":
        'edition = "2023";\npackage p;\nmessage message {}\nmessage enum {}\nmessage M {\n  message message = 5;\n  enum e = 7;\n}\n',
    },
  },
  {
    id: "TXT-3",
    title: "text#13: in proto2 the same fields need a label (buf: unexpected type name)",
    sources: {
      "a.proto":
        'syntax = "proto2";\npackage p;\nmessage message {}\nmessage M { message m = 1; optional message n = 2; }\n',
    },
    buf: "unexpected type name",
    issues: ["invalid-definition @ #/components/messages/p.M/properties/m"],
  },
  {
    id: "TXT-4",
    title: "text#14: a syntax error keeps the syntax and package parsed before it",
    sources: {
      "a.proto": 'syntax = "proto3";\npackage p.q;\nmessage M { int32 a = ; }\n',
      "b.proto": 'syntax = "proto3";\npackage g;\nmessage Ok {}\n',
    },
    buf: "missing message field tag in declaration",
    issues: ["syntax @ * at a.proto:2:22"],
    check: (r, x) => {
      x(r.document.files?.["a.proto"]).toEqual({ syntax: "proto3", package: "p.q" })
      x(r.document.components?.messages?.["g.Ok"]).toBeDefined()
    },
  },
  {
    id: "TXT-5",
    title: "text#14: an error before the package keeps the syntax only",
    sources: { "a.proto": 'edition = "2023";\nmessage M { int32 a = ; }\npackage p.q;\n' },
    buf: "missing message field tag in declaration",
    issues: ["syntax @ * at a.proto:1:22"],
    check: (r, x) => x(r.document.files?.["a.proto"]).toEqual({ syntax: "2023" }),
  },
  {
    id: "TXT-6",
    title: "text#14: an error in the first statement: no syntax is invented",
    sources: { "a.proto": 'message M { int32 a = ; }\nsyntax = "proto3";\n' },
    buf: "missing message field tag in declaration",
    issues: ["syntax @ * at a.proto:0:22"],
    check: (r, x) => {
      x(r.document.files?.["a.proto"]).toEqual({})
      x(r.document.files?.["a.proto"]?.syntax).toBeUndefined()
    },
  },
  {
    id: "TXT-7",
    title: "text#14: a complete first statement that is not syntax means proto2",
    sources: { "a.proto": "package p;\nmessage M { optional int32 a = ; }\n" },
    buf: "missing message field tag in declaration",
    issues: ["syntax @ * at a.proto:1:31"],
    check: (r, x) => x(r.document.files?.["a.proto"]).toEqual({ syntax: "proto2", package: "p" }),
  },
  {
    id: "TXT-8",
    title: "C-17: a missing import is reported at every importing statement",
    sources: {
      "a.proto": 'syntax = "proto3";\npackage a;\nimport "x.proto";\n',
      "b.proto": 'syntax = "proto3";\npackage b;\nimport "y.proto";\nimport "x.proto";\n',
    },
    buf: "imported file does not exist",
    issues: [
      "missing-import @ #/files/a.proto/imports/0",
      "missing-import @ #/files/b.proto/imports/0",
      "missing-import @ #/files/b.proto/imports/1",
    ],
  },
]
