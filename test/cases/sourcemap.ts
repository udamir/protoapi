// PB-6 source-map cases (design §9, validation L-2, L-3, phase D): the pointer table per element kind, per-index
// reserved / extensions entries, keyword-level annotation entries (option statement or tag line) and the entries of
// the resolved keywords. Both producers must give the same pointers and spans (the runner compares the source maps
// with the descriptor build of buf's image); `check` pins the spans of the text build.

import type { BuildResult } from "../../src/index.ts"
import type { Case } from "./types.ts"

const L = (...lines: string[]) => lines.join("\n")

/** `line:column-line:column` of a pointer, or undefined. */
export const spanOf = (r: BuildResult, p: string): string | undefined => {
  const l = r.sourceMap[p]
  return l && `${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}`
}

/** The span of `needle` on line `line` of `text` (first occurrence at or after `from`). */
export const find = (text: string, line: number, needle: string, from = 0): string => {
  const col = text.split("\n")[line].indexOf(needle, from)
  if (col < 0) throw new Error(`${needle} not on line ${line}`)
  return `${line}:${col}-${line}:${col + needle.length}`
}

export const SM_PROTO2 = L(
  'syntax = "proto2";',
  "package sm;",
  'import "google/protobuf/descriptor.proto";',
  'import "buf/validate/validate.proto";',
  'option java_package = "x.y";',
  "// Pet doc",
  "message Pet {",
  "  option deprecated = true;",
  "  // @Minimum 1",
  '  optional int32 id = 1 [default = 5, json_name = "ID", (buf.validate.field).int32.lt = 10];',
  "  required string name = 2;",
  "  repeated Pet kids = 3;",
  "  map<string, Pet> by_name = 4;",
  "  // Deprecated: gone",
  "  oneof kind { int32 a = 5; string b = 6; }",
  "  // @MaxItems 3",
  "  repeated int32 codes = 7;",
  "  reserved 10, 20 to 30;",
  "  reserved 40;",
  '  reserved "foo", "bar";',
  "  extensions 100 to 199;",
  "  extensions 300 to 399 [verification = UNVERIFIED];",
  "}",
  "enum Color { RED = 1; reserved 5 to max; }",
  "extend Pet { optional int32 tagged = 100; }",
  "service Svc {",
  "  rpc Get(Pet) returns (stream Pet) { option idempotency_level = NO_SIDE_EFFECTS; option deprecated = true; }",
  "}",
  "",
)

export const SM_EDITIONS = L(
  'edition = "2023";',
  "package ed;",
  "message M {",
  "  option features.json_format = LEGACY_BEST_EFFORT;",
  "  repeated int32 r = 1 [features.repeated_field_encoding = EXPANDED];",
  "  string s = 2 [features.utf8_validation = NONE];",
  "  map<string, string> m = 3 [features.utf8_validation = NONE];",
  "  repeated string t = 4 [features.utf8_validation = NONE];",
  "}",
  "enum E {",
  "  option features.json_format = LEGACY_BEST_EFFORT;",
  "  E_UNKNOWN = 0;",
  "}",
  "",
)

/** S1: every source of the field keyword `required` (design §9: the option statement, the tag or prefix line, the
 *  message's option statement for json_schema.required) */
export const SM_REQUIRED = L(
  'syntax = "proto3";',
  "package rq;",
  'import "google/api/field_behavior.proto";',
  'import "buf/validate/validate.proto";',
  'import "validate/validate.proto";',
  'import "protoc-gen-openapiv2/options/annotations.proto";',
  "message M {",
  '  option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_schema) = { json_schema: { required: ["g", "hJson"] } };',
  "  // @Required",
  "  string a = 1;",
  "  // Required. The b.",
  "  string b = 2;",
  "  string c = 3 [(google.api.field_behavior) = REQUIRED];",
  "  string d = 4 [(buf.validate.field).required = true];",
  "  N e = 5 [(validate.rules).message.required = true];",
  "  string g = 7;",
  '  string h = 8 [json_name = "hJson"];',
  "}",
  "message N {}",
  "",
)

const P = "#/components/messages/sm.Pet"
const T = SM_PROTO2

export const cases: Case[] = [
  {
    id: "PB-6.5",
    title: "pointer table per element kind (files, messages, fields, oneofs, enums, extensions, services, methods)",
    sources: { "sm.proto": T },
    check: (r, x) => {
      const at = (p: string) => spanOf(r, p)
      x(at("#/files/sm.proto/syntax")).toBe(find(T, 0, 'syntax = "proto2";'))
      x(at("#/files/sm.proto/package")).toBe(find(T, 1, "package sm;"))
      x(at("#/files/sm.proto/imports/1")).toBe(find(T, 3, 'import "buf/validate/validate.proto";'))
      x(at("#/files/sm.proto/options/java_package")).toBe(find(T, 4, 'option java_package = "x.y";'))
      x(at(P)?.startsWith("6:0-")).toBe(true)
      x(at(`${P}/deprecation`)).toBe(find(T, 7, "option deprecated = true;"))
      x(at(`${P}/properties/id/number`)).toBe(find(T, 9, "1"))
      x(at(`${P}/properties/id/type`)).toBe(find(T, 9, "int32"))
      x(at(`${P}/properties/id/default`)).toBe(find(T, 9, "default = 5"))
      x(at(`${P}/properties/id/jsonName`)).toBe(find(T, 9, 'json_name = "ID"'))
      x(at(`${P}/properties/id/presence`)).toBe(find(T, 9, "optional"))
      x(at(`${P}/properties/name/presence`)).toBe(find(T, 10, "required"))
      x(at(`${P}/oneofs/kind`)).toBe(find(T, 14, "oneof kind { int32 a = 5; string b = 6; }"))
      x(at("#/components/enums/sm.Color/values/RED/number")).toBe(find(T, 23, "1"))
      x(at("#/components/extensions/sm.tagged/extendee")).toBe(find(T, 24, "Pet"))
      x(at("#/components/extensions/sm.tagged/number")).toBe(find(T, 24, "100"))
      x(at("#/services/sm.Svc/methods/Get/request")).toBe(find(T, 26, "Pet"))
      x(at("#/services/sm.Svc/methods/Get/response/stream")).toBe(find(T, 26, "stream"))
      x(at("#/services/sm.Svc/methods/Get/idempotency")).toBe(
        find(T, 26, "option idempotency_level = NO_SIDE_EFFECTS;"),
      )
      x(at("#/services/sm.Svc/methods/Get/deprecation")).toBe(find(T, 26, "option deprecated = true;"))
    },
  },
  {
    id: "PB-6.6",
    title: "L-2: one entry per reserved interval and name and per extensions interval; extensionOptions",
    sources: { "sm.proto": T },
    check: (r, x) => {
      const at = (p: string) => spanOf(r, p)
      x(at(`${P}/reserved`)).toBe(find(T, 17, "reserved 10, 20 to 30;"))
      x(at(`${P}/reserved/numbers/0`)).toBe(find(T, 17, "10"))
      x(at(`${P}/reserved/numbers/1`)).toBe(find(T, 17, "20 to 30"))
      x(at(`${P}/reserved/numbers/2`)).toBe(find(T, 18, "40"))
      // names are sorted: bar, foo
      x(at(`${P}/reserved/names/0`)).toBe(find(T, 19, '"bar"'))
      x(at(`${P}/reserved/names/1`)).toBe(find(T, 19, '"foo"'))
      x(at(`${P}/extensions/0`)).toBe(find(T, 20, "100 to 199"))
      x(at(`${P}/extensions/1`)).toBe(find(T, 21, "300 to 399"))
      x(at(`${P}/extensionOptions/0`)).toBe(find(T, 21, "extensions 300 to 399 [verification = UNVERIFIED];"))
      x(at(`${P}/extensionOptions/0/options/verification`)).toBe(find(T, 21, "verification = UNVERIFIED"))
      x(at("#/components/enums/sm.Color/reserved/numbers/0")).toBe(find(T, 23, "5 to max"))
    },
  },
  {
    id: "PB-6.7",
    title: "L-3: keyword entries point at the option statement or the tag line; oneof deprecation at its line",
    sources: { "sm.proto": T },
    check: (r, x) => {
      const at = (p: string) => spanOf(r, p)
      x(at(`${P}/properties/id/minimum`)).toBe(find(T, 8, "// @Minimum 1"))
      x(at(`${P}/properties/id/exclusiveMaximum`)).toBe(find(T, 9, "(buf.validate.field).int32.lt = 10"))
      x(at(`${P}/properties/codes/maxItems`)).toBe(find(T, 15, "// @MaxItems 3"))
      x(at(`${P}/oneofs/kind/deprecation`)).toBe(find(T, 13, "// Deprecated: gone"))
      // proto2 `packed: false` is the syntax default: no statement sets it
      x(r.document.components?.messages?.["sm.Pet"].properties.codes.packed).toBe(false)
      x(at(`${P}/properties/codes/packed`)).toBeUndefined()
    },
  },
  {
    id: "PB-6.8",
    title:
      "resolved keywords (F-3): packed, utf8Validation (every string position), jsonFormat point at the feature option",
    sources: { "ed.proto": SM_EDITIONS },
    check: (r, x) => {
      const E = SM_EDITIONS
      const M = "#/components/messages/ed.M"
      const at = (p: string) => spanOf(r, p)
      x(at(`${M}/jsonFormat`)).toBe(find(E, 3, "option features.json_format = LEGACY_BEST_EFFORT;"))
      x(at(`${M}/properties/r/packed`)).toBe(find(E, 4, "features.repeated_field_encoding = EXPANDED"))
      x(at(`${M}/properties/s/utf8Validation`)).toBe(find(E, 5, "features.utf8_validation = NONE"))
      x(at(`${M}/properties/m/propertyNames/utf8Validation`)).toBe(find(E, 6, "features.utf8_validation = NONE"))
      x(at(`${M}/properties/m/additionalProperties/utf8Validation`)).toBe(find(E, 6, "features.utf8_validation = NONE"))
      x(at(`${M}/properties/t/items/utf8Validation`)).toBe(find(E, 7, "features.utf8_validation = NONE"))
      x(at("#/components/enums/ed.E/jsonFormat")).toBe(find(E, 10, "option features.json_format = LEGACY_BEST_EFFORT;"))
    },
  },
  {
    id: "PB-6.9",
    title: "proto3 `[packed = false]` is the entry of `packed`",
    sources: {
      "p3.proto": L(
        'syntax = "proto3";',
        "package p3;",
        "message M {",
        "  repeated int32 r = 1 [packed = false];",
        "}",
        "",
      ),
    },
    check: (r, x) => {
      x(spanOf(r, "#/components/messages/p3.M/properties/r/packed")).toBe("3:24-3:38")
    },
  },
  {
    id: "PB-6.18",
    title: "S1: `…/properties/<f>/required` points at the option statement, the tag or prefix line, the message option",
    sources: { "rq.proto": SM_REQUIRED },
    check: (r, x) => {
      const R = SM_REQUIRED
      const M = "#/components/messages/rq.M"
      const at = (p: string) => spanOf(r, p)
      x(at(`${M}/properties/a/required`)).toBe(find(R, 8, "// @Required"))
      x(at(`${M}/properties/b/required`)).toBe(find(R, 10, "// Required. The b."))
      x(at(`${M}/properties/c/required`)).toBe(find(R, 12, "(google.api.field_behavior) = REQUIRED"))
      x(at(`${M}/properties/d/required`)).toBe(find(R, 13, "(buf.validate.field).required = true"))
      x(at(`${M}/properties/e/required`)).toBe(find(R, 14, "(validate.rules).message.required = true"))
      // json_schema.required (by proto name and by JSON name): the message's option statement
      const schema = find(
        R,
        7,
        '(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_schema) = { json_schema: { required: ["g", "hJson"] } }',
      )
      x([at(`${M}/properties/g/required`), at(`${M}/properties/h/required`)]).toEqual([schema, schema])
      // the message carries no `required` array, so no entry
      x(at(`${M}/required`)).toBeUndefined()
    },
  },
]
