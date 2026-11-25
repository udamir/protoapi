// Text front end fixes (phase B): keyword type names (text#13), syntax-error files (text#14), missing imports per
// importer (C-17), names that are members of Object.prototype. buf 1.75 is the oracle.

import type { Case } from "./types.ts"
import { locateDiff, locatePointer } from "../../src/index.ts"

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
  {
    id: "TXT-9",
    title: "names that are members of Object.prototype (constructor, __proto__, toString, …) are ordinary names",
    sources: {
      "a.proto": `syntax = "proto2";
package constructor;
import "google/protobuf/descriptor.proto";

message toString {
  optional string constructor = 1;
  optional string __proto__ = 2;
  optional int32 toString = 3;
  oneof valueOf { string isPrototypeOf = 4; int32 propertyIsEnumerable = 5; }
  message hasOwnProperty { optional int32 __proto__ = 1; }
  map<string, int32> __defineGetter__ = 6;
  extensions 100 to 200;
  message Inner { enum hasOwnProperty_ { constructor = 0; __proto__ = 1; toString = 2; } }
}
enum valueOf { hasOwnProperty = 0; __proto__ = 1; }
message Opt { optional string constructor = 1; optional int32 __proto__ = 2; map<string, int32> toString = 3; optional int32 hasOwnProperty = 4; }
extend google.protobuf.FieldOptions { optional Opt constructor = 5000; optional int32 hasOwnProperty_ = 5001; }
extend toString { optional string toLocaleString = 100; optional int32 __lookupGetter__ = 101; }
service hasOwnProperty_svc {
  rpc constructor(toString) returns (toString.hasOwnProperty);
  rpc __proto__(toString) returns (toString) { option deprecated = true; }
}
message User {
  optional int32 a = 1 [(constructor) = { constructor: "x", __proto__: 3, toString: { key: "__proto__", value: 1 }, toString: { key: "constructor", value: 2 }, hasOwnProperty: 4 }, (hasOwnProperty_) = 7];
}
`,
    },
    check: (r, x) => {
      const c = r.document.components
      const m = c?.messages?.["constructor.toString"]
      const keys = (o: object | undefined) => Object.keys(o ?? {})
      x(keys(m?.properties)).toEqual([
        "constructor",
        "__proto__",
        "toString",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "__defineGetter__",
      ])
      x(Object.getPrototypeOf(m?.properties)).toBe(Object.prototype)
      x(keys(m?.oneofs)).toEqual(["valueOf"])
      x(keys(c?.messages?.["constructor.toString.hasOwnProperty"]?.properties)).toEqual(["__proto__"])
      x(keys(c?.enums?.["constructor.valueOf"]?.values)).toEqual(["hasOwnProperty", "__proto__"])
      x(keys(c?.enums?.["constructor.toString.Inner.hasOwnProperty_"]?.values)).toEqual([
        "constructor",
        "__proto__",
        "toString",
      ])
      x(keys(c?.extensions)).toEqual([
        "constructor.constructor",
        "constructor.hasOwnProperty_",
        "constructor.toLocaleString",
        "constructor.__lookupGetter__",
      ])
      x(keys(r.document.services?.["constructor.hasOwnProperty_svc"]?.methods)).toEqual(["constructor", "__proto__"])
      x(JSON.stringify(c?.messages?.["constructor.User"]?.properties.a.options)).toBe(
        '{"constructor.constructor":{"constructor":"x","__proto__":3,"toString":{"__proto__":1,"constructor":2},"hasOwnProperty":4},"constructor.hasOwnProperty_":7}',
      )
      // source map pointers and their lookups
      const at = (p: string) => locatePointer(p, r.sourceMap)?.start.line
      x(at("#/components/messages/constructor.toString/properties/__proto__")).toBe(6)
      x(at("#/components/messages/constructor.toString/properties/toString/type")).toBe(7)
      x(at("#/components/messages/constructor.toString/oneofs/valueOf")).toBe(8)
      x(at("#/components/enums/constructor.valueOf/values/__proto__")).toBe(14)
      x(at("#/services/constructor.hasOwnProperty_svc/methods/__proto__")).toBe(20)
      x(at("#/components/extensions/constructor.__lookupGetter__")).toBe(17)
      x(at("#/components/messages/constructor.User/properties/a/options/constructor.constructor")).toBe(23)
      x(at("#/components/messages/constructor.toString/properties/valueOf")).toBe(4)
      const props = ["components", "messages", "constructor.toString", "properties"]
      x(locateDiff({ action: "remove", path: [...props, "__proto__"] }, r.sourceMap, r.sourceMap)?.start.line).toBe(6)
      x(
        locateDiff(
          { action: "rename", path: props, before: "toString", after: "constructor" },
          r.sourceMap,
          r.sourceMap,
        )?.start.line,
      ).toBe(5)
      x(locateDiff({ action: "add", path: [...props, "hasOwnProperty"] }, r.sourceMap, r.sourceMap)?.start.line).toBe(4)
    },
  },
  {
    id: "TXT-10",
    title: "Object.prototype names without a package: components, conventions, option map and Struct keys",
    sources: {
      "b.proto": `syntax = "proto3";
import "google/protobuf/descriptor.proto";
import "google/protobuf/struct.proto";
import "google/protobuf/any.proto";
import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "buf/validate/validate.proto";

// A message named __proto__.
message __proto__ {
  // @MinLength 2
  string constructor = 1 [(buf.validate.field).string.max_len = 5];
  // Required. The value.
  int32 toString = 2 [(google.api.field_behavior) = OUTPUT_ONLY];
  repeated constructor hasOwnProperty = 3;
  map<string, constructor> valueOf = 4;
  oneof isPrototypeOf { string propertyIsEnumerable = 6; }
}
message constructor { toString __proto__ = 1; }
enum toString { valueOf = 0; constructor_ = 1; }
message Opts { google.protobuf.Struct s = 1; google.protobuf.Any a = 2; map<string, string> m = 3; }
extend google.protobuf.MessageOptions { Opts hasOwnProperty = 50000; int32 __defineGetter__ = 50001; }
message User {
  option (hasOwnProperty) = { s: { fields: { key: "__proto__" value: { string_value: "x" } } fields: { key: "constructor" value: { number_value: 1 } } } a: { [type.googleapis.com/constructor] { __proto__: constructor_ } } m: { key: "toString" value: "y" } };
  option (__defineGetter__) = 3;
}
service __defineSetter__ {
  rpc __proto__(.__proto__) returns (constructor) { option (google.api.http) = { get: "/v1/{constructor}" }; }
}
`,
    },
    check: (r, x) => {
      const c = r.document.components
      x(Object.keys(c?.messages ?? {}).filter((k) => !k.includes("."))).toEqual([
        "__proto__",
        "constructor",
        "Opts",
        "User",
      ])
      x(Object.keys(c?.enums ?? {}).filter((k) => !k.includes("."))).toEqual(["toString"])
      x(Object.keys(c?.extensions ?? {})).toEqual(["hasOwnProperty", "__defineGetter__"])
      x(Object.keys(r.document.services ?? {})).toEqual(["__defineSetter__"])
      const props = c?.messages?.["__proto__"]?.properties ?? {}
      // by a string key: TypeScript types `props.toString` as the member of Object.prototype
      const p = (name: string) => (Object.hasOwn(props, name) ? props[name] : undefined)
      x(JSON.stringify(p("constructor"))).toBe('{"number":1,"type":"string","minLength":2,"maxLength":5}')
      x(p("toString")?.required).toBe(true)
      x(p("valueOf")?.additionalProperties).toEqual({ $ref: "#/components/messages/constructor" })
      x(JSON.stringify(c?.messages?.User?.options)).toBe(
        '{"hasOwnProperty":{"s":{"fields":{"__proto__":{"string_value":"x"},"constructor":{"number_value":1}}},"a":{"@type":"type.googleapis.com/constructor","__proto__":"constructor_"},"m":{"toString":"y"}},"__defineGetter__":3}',
      )
      x(r.document.services?.__defineSetter__?.methods.__proto__.http).toEqual({
        method: "GET",
        path: "/v1/{constructor}",
      })
      x(
        locatePointer("#/components/messages/__proto__/properties/constructor/minLength", r.sourceMap)?.start.line,
      ).toBe(10)
      x(locatePointer("#/components/messages/User/options/__defineGetter__", r.sourceMap)?.start.line).toBe(24)
    },
  },
]
