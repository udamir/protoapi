// PB-4: name resolution (design §5.3) — import-visibility-aware scope walk (C-1), edition 2024+ symbol visibility,
// `import option` types (decision 18), comments inside names (C-15), option name scopes and kinds. buf 1.75 is the
// oracle; `buf` holds the substring of its error when it rejects the input.

import type { Case } from "./types.ts"

const e = (edition: string, pkg: string, body = "") => `edition = "${edition}";\npackage ${pkg};\n${body}`
const P3 = (pkg: string, body = "") => `syntax = "proto3";\n${pkg ? `package ${pkg};\n` : ""}${body}`
const P2 = (body: string) => `syntax = "proto2";\npackage p;\nimport "google/protobuf/descriptor.proto";\n${body}`

const ref = (fqn: string) => `#/components/messages/${fqn}`

export const cases: Case[] = [
  // ---- C-1: symbols outside the import closure are not found; the search continues outward ----------------------
  {
    id: "PB-4.1",
    title: "C-1: a package symbol of a file that is not imported does not shadow an imported root symbol",
    sources: {
      "a.proto": P3("x", 'import "root.proto";\nmessage A { Foo f = 1; }\n'),
      "root.proto": P3("", "message Foo {}\n"),
      "b.proto": P3("x", "message Foo {}\n"),
    },
    check: (r, x) => x(r.document.components?.messages?.["x.A"]?.properties.f.$ref).toBe(ref("Foo")),
  },
  {
    id: "PB-4.2",
    title: "C-1: a package declared only by a file that is not imported is skipped (first component)",
    sources: {
      "a.proto": P3("x", 'import "root.proto";\nmessage A { y.Foo f = 1; }\n'),
      "root.proto": P3("", "message y { message Foo {} }\n"),
      "b.proto": P3("x.y", "message Foo {}\n"),
    },
    check: (r, x) => x(r.document.components?.messages?.["x.A"]?.properties.f.$ref).toBe(ref("y.Foo")),
  },
  {
    id: "PB-4.3",
    title: "C-1: a symbol only in a file that is not imported stays unresolved (message names the file)",
    sources: { "a.proto": P3("x", "message A { Foo f = 1; }\n"), "b.proto": P3("x", "message Foo {}\n") },
    buf: "cannot find `Foo` in this scope",
    issues: ["unresolved-type @ #/components/messages/x.A/properties/f"],
    check: (r, x) => x(r.issues[0].message).toContain("defined in b.proto, which is not imported"),
  },
  {
    id: "PB-4.4",
    title: "C-1: public imports are visible transitively; a plain import of an import is not",
    sources: {
      "a.proto": P3("p", 'import "b.proto";\nmessage A { q.B b = 1; r.C c = 2; }\n'),
      "b.proto": P3("q", 'import public "c.proto";\nmessage B {}\n'),
      "c.proto": P3("r", 'import "d.proto";\nmessage C {}\n'),
      "d.proto": P3("s", "message D {}\n"),
    },
  },
  {
    id: "PB-4.5",
    title: "C-1: an import of an import is not visible",
    sources: {
      "a.proto": P3("p", 'import "b.proto";\nmessage A { r.C c = 1; }\n'),
      "b.proto": P3("q", 'import "c.proto";\nmessage B {}\n'),
      "c.proto": P3("r", "message C {}\n"),
    },
    entry: ["a.proto"],
    buf: "cannot find `r.C` in this scope",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/c"],
    check: (r, x) => x(r.issues[0].message).toContain("r.C is defined in c.proto, which is not imported"),
  },
  // ---- edition 2024+ visibility --------------------------------------------------------------------------------------
  {
    id: "PB-4.6",
    title: "2024: a local symbol is skipped and the search continues outward (root Foo)",
    sources: {
      "a.proto": e("2024", "p", 'import "b.proto";\nimport "c.proto";\nmessage A { Foo f = 1; }\n'),
      "b.proto": e("2024", "p", "local message Foo {}\n"),
      "c.proto": 'edition = "2024";\nexport message Foo {}\n',
    },
    entry: ["a.proto"],
    check: (r, x) => x(r.document.components?.messages?.["p.A"]?.properties.f.$ref).toBe(ref("Foo")),
  },
  {
    id: "PB-4.7",
    title: "2024: EXPORT_TOP_LEVEL — a nested message is local by default",
    sources: {
      "a.proto": e("2024", "p", 'import "b.proto";\nmessage A { q.Outer.Inner i = 1; }\n'),
      "b.proto": e("2024", "q", "message Outer { message Inner {} }\n"),
    },
    entry: ["a.proto"],
    buf: "found unexported message type `q.Outer.Inner`",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/i"],
    check: (r, x) =>
      x(r.issues[0].message).toContain("q.Outer.Inner is a message type that is not exported from b.proto"),
  },
  {
    id: "PB-4.8",
    title: "2024: EXPORT_TOP_LEVEL — a nested enum is local by default",
    sources: {
      "a.proto": e("2024", "p", 'import "b.proto";\nmessage A { q.Outer.E e = 1; }\n'),
      "b.proto": e("2024", "q", "message Outer { enum E { E_UNSPECIFIED = 0; } }\n"),
    },
    entry: ["a.proto"],
    buf: "found unexported enum type `q.Outer.E`",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/e"],
  },
  {
    id: "PB-4.9",
    title: "2024: `export` makes a nested message and enum visible",
    sources: {
      "a.proto": e("2024", "p", 'import "b.proto";\nmessage A { q.Outer.Inner i = 1; q.Outer.E e = 2; }\n'),
      "b.proto": e("2024", "q", "message Outer { export message Inner {} export enum E { E_UNSPECIFIED = 0; } }\n"),
    },
    entry: ["a.proto"],
  },
  {
    id: "PB-4.10",
    title: "2024: an explicit `local` top-level message — the message says not exported, not 'not imported'",
    sources: {
      "a.proto": e("2024", "p", 'import "b.proto";\nmessage A { q.Outer o = 1; }\n'),
      "b.proto": e("2024", "q", "local message Outer {}\n"),
    },
    entry: ["a.proto"],
    buf: "found unexported message type `q.Outer`",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/o"],
    check: (r, x) => {
      x(r.issues[0].message).toContain("is a message type that is not exported from b.proto")
      x(r.issues[0].message).not.toContain("not imported")
    },
  },
  {
    id: "PB-4.11",
    title: "2024: default_symbol_visibility = LOCAL_ALL makes top-level types local",
    sources: {
      "a.proto": e("2024", "p", 'import "b.proto";\nmessage A { q.Outer o = 1; }\n'),
      "b.proto": e("2024", "q", "option features.default_symbol_visibility = LOCAL_ALL;\nmessage Outer {}\n"),
    },
    entry: ["a.proto"],
    buf: "found unexported message type `q.Outer`",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/o"],
  },
  {
    id: "PB-4.12",
    title: "2024: LOCAL_ALL with `export`, EXPORT_ALL with a nested type",
    sources: {
      "a.proto": e(
        "2024",
        "p",
        'import "b.proto";\nimport "c.proto";\nmessage A { q.Outer o = 1; r.Outer.Inner i = 2; }\n',
      ),
      "b.proto": e("2024", "q", "option features.default_symbol_visibility = LOCAL_ALL;\nexport message Outer {}\n"),
      "c.proto": e(
        "2024",
        "r",
        "option features.default_symbol_visibility = EXPORT_ALL;\nmessage Outer { message Inner {} }\n",
      ),
    },
    entry: ["a.proto"],
  },
  {
    id: "PB-4.13",
    title: "2024: STRICT — top-level types are local unless exported",
    sources: {
      "a.proto": e("2024", "p", 'import "b.proto";\nmessage A { q.Outer o = 1; q.Other x = 2; }\n'),
      "b.proto": e(
        "2024",
        "q",
        "option features.default_symbol_visibility = STRICT;\nexport message Outer {}\nmessage Other {}\n",
      ),
    },
    entry: ["a.proto"],
    buf: "found unexported message type `q.Other`",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/x"],
  },
  {
    id: "PB-4.14",
    title: "2026: STRICT by default — an exported top-level message is visible, a plain one is not",
    sources: {
      "a.proto": e("2026", "p", 'import "b.proto";\nmessage A { q.Outer o = 1; q.Other x = 2; }\n'),
      "b.proto": e("2026", "q", "export message Outer {}\nmessage Other {}\n"),
    },
    entry: ["a.proto"],
    buf: "found unexported message type `q.Other`",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/x"],
  },
  {
    id: "PB-4.15",
    title: "STRICT: the namespace pattern exports a nested enum from a local message reserving 1 to max",
    sources: {
      "a.proto": e("2026", "p", 'import "b.proto";\nexport message A { q.Ns.E e = 1; }\n'),
      "b.proto": e("2026", "q", "message Ns { export enum E { E_UNSPECIFIED = 0; } reserved 1 to max; }\n"),
    },
    entry: ["a.proto"],
  },
  {
    id: "PB-4.16",
    title: "same file: local and nested types resolve within their file",
    sources: { "a.proto": e("2024", "p", "local message A { message B {} }\nmessage C { A.B b = 1; A a = 2; }\n") },
  },
  // ---- import option (decision 18) ----------------------------------------------------------------------------------
  {
    id: "PB-4.17",
    title: "decision 18: an `import option` file's extensions are usable in option names and aggregate values",
    sources: {
      "a.proto": e("2024", "p", 'import option "b.proto";\nmessage A { option (q.o) = 1; option (q.m) = { x: 1 }; }\n'),
      "b.proto": e(
        "2024",
        "q",
        'import "google/protobuf/descriptor.proto";\nextend google.protobuf.MessageOptions { int32 o = 50001; B m = 50002; }\nmessage B { int32 x = 1; }\n',
      ),
    },
    entry: ["a.proto"],
  },
  {
    id: "PB-4.18",
    title: "decision 18: a type of an `import option` file is not a field type",
    sources: {
      "a.proto": e("2024", "p", 'import option "b.proto";\nmessage A { q.B b = 1; }\n'),
      "b.proto": e("2024", "q", "message B {}\n"),
    },
    entry: ["a.proto"],
    buf: "`q.B` is only imported for use in options",
    issues: ["unresolved-type @ #/components/messages/p.A/properties/b"],
    check: (r, x) =>
      x(r.issues[0].message).toContain("q.B is defined in b.proto, which is only imported for use in options"),
  },
  {
    id: "PB-4.19",
    title: "decision 18: an extendee of an `import option` file is not visible to `extend`",
    sources: {
      "a.proto": e(
        "2024",
        "p",
        'import option "google/protobuf/descriptor.proto";\nextend google.protobuf.FieldOptions { int32 foo = 50001; }\n',
      ),
    },
    buf: "`google.protobuf.FieldOptions` is only imported for use in options",
    issues: ["unresolved-extendee @ #/components/extensions/p.foo"],
  },
  // ---- C-15: comments inside qualified names ---------------------------------------------------------------------
  {
    id: "PB-4.20",
    title: "C-15: comments between the tokens of type names, package, option names and rpc types",
    sources: {
      "a.proto": `syntax = "proto3";\npackage p /* x */ . /* y */ q;\nimport "google/protobuf/descriptor.proto";\nmessage Outer { enum E { E0 = 0; } }\nmessage M {\n  Outer /*c*/ . E e = 3;\n  .p . q.Outer o = 4;\n  int32 x = 5 [(opts /* c */ .flag) = true];\n}\nmessage opts { extend google.protobuf.FieldOptions { bool flag = 50001; } }\nservice S { rpc A (p /* c */ .q.M) returns (.p.q . M); }\n`,
    },
    check: (r, x) => {
      x(r.document.files?.["a.proto"]?.package).toBe("p.q")
      x(r.document.components?.messages?.["p.q.M"]?.properties.e.$ref).toBe("#/components/enums/p.q.Outer.E")
    },
  },
  // ---- option name scopes and kinds ---------------------------------------------------------------------------------
  {
    id: "PB-4.21",
    title: "message options are looked up from the enclosing scope: a nested message does not shadow",
    sources: {
      "a.proto": P2(
        "extend google.protobuf.MessageOptions { optional int32 foo = 50001; }\nextend google.protobuf.OneofOptions { optional int32 bar = 50002; }\nextend google.protobuf.ExtensionRangeOptions { optional int32 baz = 50003; }\nmessage M {\n  message foo {}\n  message bar {}\n  message baz {}\n  option (foo) = 1;\n  oneof o { option (bar) = 2; int32 a = 1; }\n  extensions 100 to 200 [(baz) = 3];\n}\n",
      ),
    },
  },
  {
    id: "PB-4.22",
    title: "a nested message's options see its parent's scope: a sibling message shadows the extension",
    sources: {
      "a.proto": P2(
        "extend google.protobuf.MessageOptions { optional int32 foo = 50001; }\nmessage M { message foo {} message N { option (foo) = 1; } }\n",
      ),
    },
    buf: "expected message extension, found message type `p.M.foo`",
    issues: ["unresolved-type @ #/components/messages/p.M.N/options/foo"],
  },
  {
    id: "PB-4.23",
    title: "field options see the message scope: a field of the same name shadows the extension",
    sources: {
      "a.proto": P2(
        "extend google.protobuf.FieldOptions { optional int32 foo = 50001; }\nmessage M { optional int32 foo = 1 [(foo) = 1]; }\n",
      ),
    },
    buf: "extension, found message field",
    issues: ["unresolved-type @ #/components/messages/p.M/properties/foo/options/foo"],
  },
  {
    id: "PB-4.24",
    title: "method options see the service scope: a method of the same name shadows the extension",
    sources: {
      "a.proto": P2(
        "extend google.protobuf.MethodOptions { optional int32 foo = 50001; }\nmessage R {}\nservice S { rpc foo (R) returns (R) { option (foo) = 1; } }\n",
      ),
    },
    buf: "expected message extension, found service method `p.S.foo`",
    issues: ["unresolved-type @ #/services/p.S/methods/foo/options/foo"],
  },
  {
    id: "PB-4.25",
    title: "an option name that resolves to a message (wrong kind)",
    sources: { "a.proto": P2("message foo {}\noption (foo) = 1;\n") },
    buf: "expected message extension, found message type `p.foo`",
    issues: ["unresolved-type @ #/files/a.proto/options/foo"],
    check: (r, x) => x(r.document.files?.["a.proto"]?.options).toEqual({ foo: "1" }),
  },
  {
    id: "PB-4.26",
    title: "a field type that resolves to a service or a package (wrong kind)",
    sources: { "a.proto": P3("p", "service S {}\nmessage M { S s = 1; p q = 2; }\n") },
    buf: "expected type, found service definition `p.S`",
    issues: [
      "unresolved-type @ #/components/messages/p.M/properties/s",
      "unresolved-type @ #/components/messages/p.M/properties/q",
    ],
    check: (r, x) => {
      x(r.issues[0].message).toContain("S resolves to service p.S, which is not a message or enum type")
      x(r.issues[1].message).toContain("p resolves to package p")
    },
  },
  {
    id: "PB-4.27",
    title: "an rpc request / response that is an enum (wrong kind)",
    sources: {
      "a.proto": P3(
        "p",
        "enum E { E0 = 0; }\nmessage M {}\nservice S { rpc A (E) returns (M); rpc B (M) returns (E); }\n",
      ),
    },
    buf: "expected message type, found enum type `p.E`",
    issues: [
      "unresolved-type @ #/services/p.S/methods/A/request",
      "unresolved-type @ #/services/p.S/methods/B/response",
    ],
    check: (r, x) => x(r.document.services?.["p.S"]?.methods.A.request.schema.$ref).toBe("#/components/enums/p.E"),
  },
  {
    id: "PB-4.28",
    title: "an extendee that is an enum (wrong kind)",
    sources: { "a.proto": P2("enum E { E0 = 0; }\nextend E { optional int32 x = 1; }\n") },
    buf: "expected message type, found enum type `p.E`",
    issues: ["unresolved-extendee @ #/components/extensions/p.x"],
  },
  {
    id: "PB-4.29",
    title: "protoc's first-component rule still applies after a hidden symbol (no backtracking past a visible match)",
    sources: {
      "a.proto": P3("a", 'import "b.proto";\nmessage M { message Foo {} Foo.Bar f = 1; }\n'),
      "b.proto": P3("a", "message Foo { message Bar {} }\n"),
    },
    entry: ["a.proto"],
    buf: "cannot find `Foo.Bar` in this scope",
    issues: ["unresolved-type @ #/components/messages/a.M/properties/f"],
  },
]
