// PB-3 annotation layer (design §3.8, D13, D14) and the phase C fixes A-1 … A-15 with agent-decided items 4–10 of
// the validation report. buf 1.75 is the oracle: an accepted case is also a conformance test; issues of the shared
// annotation layer are reported by both producers (`descriptorIssues`).

import type { Case } from "./types.ts"

const OA = "grpc.gateway.protoc_gen_openapiv2.options"
const HEAD = `syntax = "proto3";
package t;
import "buf/validate/validate.proto";
import "validate/validate.proto";
import "google/api/field_info.proto";
import "google/api/field_behavior.proto";
import "protoc-gen-openapiv2/options/annotations.proto";
import "google/protobuf/wrappers.proto";
import "google/protobuf/duration.proto";
`

const src = (body: string) => ({ "t.proto": `${HEAD}${body}` })
const M = "#/components/messages/t.M"
type Doc = {
  components?: { messages?: Record<string, Record<string, unknown>> }
  services?: Record<string, { methods: Record<string, Record<string, unknown>> }>
}
const msg = (d: unknown, name = "M") => (d as Doc).components?.messages?.[`t.${name}`] as Record<string, unknown>
const props = (d: unknown, name = "M") => msg(d, name)?.properties as Record<string, Record<string, unknown>>
/** S1: the message carries no `required` array; the names of the fields that carry `required: true` */
const req = (d: unknown, name = "M") => [
  msg(d, name)?.required,
  Object.keys(props(d, name)).filter((k) => props(d, name)[k].required === true),
]

/** the same issues from both producers */
const both = (issues: string[]) => ({ issues, descriptorIssues: issues })

export const cases: Case[] = [
  {
    id: "PB-3.1",
    title: "A-1: invalid numeric tag values are invalid-tag issues, never null; decimal values are accepted",
    sources: src(`message M {
  // @MinLength abc
  string a = 1;
  // @Max Infinity
  double b = 2;
  // @MinLength 1.5
  string c = 3;
  // @Minimum 0x10
  int32 d = 4;
  // @Maximum 1e3
  int32 e = 5;
  // @ExclusiveMinimum -2.5
  double f = 6;
  // @MultipleOf 0.5
  float g = 7;
}
`),
    ...both([
      `invalid-tag @ ${M}/properties/a`,
      `invalid-tag @ ${M}/properties/b`,
      `invalid-tag @ ${M}/properties/c`,
      `invalid-tag @ ${M}/properties/d`,
    ]),
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.minLength, p.b.maximum, p.c.minLength, p.d.minimum]).toEqual([undefined, undefined, undefined, undefined])
      x([p.e.maximum, p.f.exclusiveMinimum, p.g.multipleOf]).toEqual([1000, -2.5, 0.5])
      x(p.a.description).toBeUndefined()
    },
  },
  {
    id: "PB-3.2",
    title: 'A-2: non-finite protovalidate float bounds are "Infinity" strings, like const and in',
    sources: src(`message M {
  float a = 1 [(buf.validate.field).float = { gt: -inf, lt: inf }];
  double b = 2 [(buf.validate.field).double = { in: [inf, 1.5], const: nan }];
  double c = 3 [(buf.validate.field).double = { gte: -1e308, lte: 1.5 }];
}
`),
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.exclusiveMinimum, p.a.exclusiveMaximum]).toEqual(["-Infinity", "Infinity"])
      x([p.b.enum, p.b.const]).toEqual([["Infinity", 1.5], "NaN"])
      x([p.c.minimum, p.c.maximum]).toEqual([-1e308, 1.5])
    },
  },
  {
    id: "PB-3.3",
    title: "A-3: openapiv2 title beats @Title (D13), the conflict is recorded and reported",
    sources: src(`message M {
  // @Title T
  string a = 1 [(${OA}.openapiv2_field) = { title: "OA" }];
  // @Title Tag only
  string b = 2;
}
`),
    ...both([`annotation-conflict @ ${M}/properties/a/x-annotation-conflicts/0`]),
    check: (r, x) => {
      const p = props(r.document)
      x(p.a.title).toBe("OA")
      x(p.a["x-annotation-conflicts"]).toEqual([
        { keyword: "title", kept: { source: "openapiv2", value: "OA" }, dropped: { source: "tag", value: "T" } },
      ])
      x(p.b.title).toBe("Tag only")
    },
  },
  {
    id: "PB-3.4",
    title: "A-4: a @Deprecated tag or Deprecated: line on a oneof gives its deprecation",
    sources: src(`message M {
  // Lead.
  // @Deprecated gone
  oneof o { string a = 1; }
  // Deprecated: use x
  oneof p { string b = 2; }
  // @Deprecated
  oneof q { string c = 3; }
}
`),
    check: (r, x) =>
      x(msg(r.document).oneofs).toEqual({
        o: { description: "Lead.", deprecation: { reason: "gone" } },
        p: { deprecation: { reason: "use x" } },
        q: { deprecation: {} },
      }),
  },
  {
    id: "PB-3.5",
    title: "A-5 (phase B): an aggregate after a sub-path on the same option is an invalid-option (buf rejects it)",
    sources: src(`message M {
  string a = 1 [(buf.validate.field).string.min_len = 1, (buf.validate.field).string = { min_len: 2 }];
}
`),
    buf: "multiple times",
    issues: [`invalid-option @ ${M}/properties/a/options/buf.validate.field`],
  },
  {
    id: "PB-3.6",
    title: "A-6: 64-bit bound tags accept decimal integer digits only, kept exact as strings",
    sources: src(`message M {
  // @Min 1e3
  int64 a = 1;
  // @Min 1.5
  int64 b = 2;
  // @Minimum 9007199254740993
  int64 c = 3;
  // @Maximum -0010
  sint64 d = 4;
  // @Minimum 0x10
  uint64 e = 5;
  // @Minimum 5
  google.protobuf.Int64Value w = 6;
}
`),
    ...both([`invalid-tag @ ${M}/properties/a`, `invalid-tag @ ${M}/properties/b`, `invalid-tag @ ${M}/properties/e`]),
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.minimum, p.b.minimum, p.c.minimum, p.d.maximum, p.e.minimum, p.w.minimum]).toEqual([
        undefined,
        undefined,
        "9007199254740993",
        "-10",
        undefined,
        "5",
      ])
    },
  },
  {
    id: "PB-3.7",
    title: "A-7: google.api.field_info.format is lifted on string positions only",
    sources: src(`message M {
  int32 a = 1 [(google.api.field_info).format = UUID4];
  string b = 2 [(google.api.field_info).format = IPV4];
  repeated string c = 3 [(google.api.field_info).format = IPV6];
  google.protobuf.StringValue d = 4 [(google.api.field_info).format = UUID4];
  map<string, string> e = 5 [(google.api.field_info).format = IPV4_OR_IPV6];
}
`),
    check: (r, x) => {
      const p = props(r.document)
      x(p.a.format).toBeUndefined()
      x(p.a.options).toEqual({ "google.api.field_info": { format: "UUID4" } })
      x(p.b.format).toBe("ipv4")
      x((p.c.items as Record<string, unknown>).format).toBe("ipv6")
      x(p.d.format).toBe("uuid")
      x(p.e.options).toEqual({ "google.api.field_info": { format: "IPV4_OR_IPV6" } })
    },
  },
  {
    id: "PB-3.8",
    title: "A-8 / decision 4: @MinItems / @MaxItems count map entries; on a singular field they are invalid",
    sources: src(`message M {
  // @MinItems 1
  // @MaxItems 3
  map<string, string> a = 1;
  // @MinItems 2
  string b = 2;
  // @MaxItems 4
  repeated string c = 3;
  // @MinItems -1
  repeated string d = 4;
}
`),
    ...both([`invalid-tag @ ${M}/properties/b`, `invalid-tag @ ${M}/properties/d`]),
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.minProperties, p.a.maxProperties, p.a.minItems]).toEqual([1, 3, undefined])
      x(p.b.minItems).toBeUndefined()
      x(p.c.maxItems).toBe(4)
    },
  },
  {
    id: "PB-3.9",
    title: "A-9 / D-D: an exclusive range (lower bound above the upper) stays raw, no bound keywords",
    sources: src(`message M {
  int32 a = 1 [(buf.validate.field).int32 = { gt: 10, lt: 5 }];
  int32 b = 2 [(buf.validate.field).int32 = { gte: 5, lte: 5 }];
  int64 c = 3 [(buf.validate.field).int64 = { gte: 9007199254740993, lt: 1, in: [3] }];
  double d = 4 [(validate.rules).double = { gt: 1.5, lte: -1 }];
  uint32 e = 5 [(buf.validate.field).uint32 = { gt: 1, lt: 9 }];
}
`),
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.exclusiveMinimum, p.a.exclusiveMaximum]).toEqual([undefined, undefined])
      x(p.a.options).toEqual({ "buf.validate.field": { int32: { gt: 10, lt: 5 } } })
      x([p.b.minimum, p.b.maximum]).toEqual([5, 5])
      x([p.c.minimum, p.c.exclusiveMaximum, p.c.enum]).toEqual([undefined, undefined, ["3"]])
      x(p.c.options).toEqual({ "buf.validate.field": { int64: { gte: "9007199254740993", lt: "1" } } })
      x(p.d.options).toEqual({ "validate.rules": { double: { gt: 1.5, lte: -1 } } })
      x([p.e.exclusiveMinimum, p.e.exclusiveMaximum]).toEqual([1, 9])
    },
  },
  {
    id: "PB-3.10",
    title: "A-10 / decision 5: openapiv2 on repeated fields: item counts on the array, value keywords on items",
    sources: src(`message M {
  repeated string a = 1 [(${OA}.openapiv2_field) = { pattern: "^a$", format: "email", max_length: 3, min_items: 1, max_items: 5, unique_items: true, title: "T", read_only: true }];
  map<string, int32> b = 2 [(${OA}.openapiv2_field) = { min_items: 1, max_items: 2, minimum: 2, unique_items: true }];
  // @Pattern ^b$
  repeated string c = 3 [(${OA}.openapiv2_field) = { pattern: "^a$" }];
}
`),
    ...both([`annotation-conflict @ ${M}/properties/c/x-annotation-conflicts/0`]),
    check: (r, x) => {
      const p = props(r.document)
      x(p.a).toEqual({
        title: "T",
        number: 1,
        type: "array",
        items: { type: "string", format: "email", maxLength: 3, pattern: "^a$" },
        readOnly: true,
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
      })
      x([p.b.minProperties, p.b.maxProperties]).toEqual([1, 2])
      x((p.b.additionalProperties as Record<string, unknown>).minimum).toBe(2)
      x(p.b.options).toEqual({ [`${OA}.openapiv2_field`]: { unique_items: true } })
      x((p.c.items as Record<string, unknown>).pattern).toBe("^a$")
      x(p.c["x-annotation-conflicts"]).toEqual([
        {
          keyword: "items.pattern",
          kept: { source: "openapiv2", value: "^a$" },
          dropped: { source: "tag", value: "^b$" },
        },
      ])
    },
  },
  {
    id: "PB-3.11",
    title:
      "A-11 / decision 6: a rule family that does not fit the field is an invalid-option; wrappers take scalar rules",
    sources: src(`message N {}
message M {
  repeated string a = 1 [(buf.validate.field).string.min_len = 1];
  int32 b = 2 [(buf.validate.field).string.min_len = 1];
  google.protobuf.StringValue c = 3 [(buf.validate.field).string.email = true];
  // @Format uuid
  google.protobuf.StringValue d = 4;
  google.protobuf.Int64Value e = 5 [(buf.validate.field).int64.gt = 0];
  google.protobuf.Duration f = 6 [(buf.validate.field).duration.gt = { seconds: 1 }];
  google.protobuf.Duration g = 7 [(buf.validate.field).int32.gt = 1];
  map<string, int32> h = 8 [(buf.validate.field).repeated.min_items = 1];
  sint32 i = 9 [(buf.validate.field).int32.gt = 1];
  N j = 10 [(validate.rules).message.required = true];
  string k = 11 [(validate.rules).message.required = true];
  repeated int32 l = 12 [(buf.validate.field).repeated.items.string.min_len = 1];
}
`),
    ...both([
      `invalid-option @ ${M}/properties/a/options/buf.validate.field`,
      `invalid-option @ ${M}/properties/b/options/buf.validate.field`,
      `invalid-option @ ${M}/properties/g/options/buf.validate.field`,
      `invalid-option @ ${M}/properties/h/options/buf.validate.field`,
      `invalid-option @ ${M}/properties/i/options/buf.validate.field`,
      `invalid-option @ ${M}/properties/k/options/validate.rules`,
      `invalid-option @ ${M}/properties/l/options/buf.validate.field`,
    ]),
    check: (r, x) => {
      const p = props(r.document)
      x(p.a.options).toEqual({ "buf.validate.field": { string: { min_len: "1" } } })
      x([p.a.minLength, (p.a.items as Record<string, unknown>).minLength]).toEqual([undefined, undefined])
      x(p.b.options).toEqual({ "buf.validate.field": { string: { min_len: "1" } } })
      x([p.c.format, p.d.format, p.e.exclusiveMinimum]).toEqual(["email", "uuid", "0"])
      x(p.f.options).toEqual({ "buf.validate.field": { duration: { gt: { seconds: "1" } } } })
      x(p.i.exclusiveMinimum).toBeUndefined()
      x(req(r.document)).toEqual([undefined, ["j"]])
    },
  },
  {
    id: "PB-3.12",
    title: "A-12: protovalidate names before 1.0 are kept raw with unknown-option (buf rejects them)",
    sources: src(`message M {
  string a = 1 [(buf.validate.field).ignore_empty = true, (buf.validate.field).string.min_len = 1];
  string b = 2 [(buf.validate.field).skipped = true];
}
message N { option (buf.validate.message).disabled = true; }
`),
    buf: "ignore_empty",
    issues: [
      `unknown-option @ ${M}/properties/a/options/buf.validate.field`,
      `unknown-option @ ${M}/properties/b/options/buf.validate.field`,
      "unknown-option @ #/components/messages/t.N/options/buf.validate.message",
    ],
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.minLength, p.a.options]).toEqual([1, { "buf.validate.field": { ignore_empty: true } }])
      x(p.b.options).toEqual({ "buf.validate.field": { skipped: true } })
      x(msg(r.document, "N").options).toEqual({ "buf.validate.message": { disabled: true } })
    },
  },
  {
    id: "PB-3.13",
    title:
      "A-13 / decision 7: protovalidate example, openapiv2_schema title / required, openapiv2_operation.deprecated",
    sources: src(`enum E { E_UNSPECIFIED = 0; E_ONE = 1; }
message M {
  option (${OA}.openapiv2_schema) = { json_schema: { title: "Schema title", required: ["a", "bJson", "nope"], description: "x" } };
  string a = 1 [(buf.validate.field).string = { example: "x", example: "y", ulid: true }];
  string b = 2 [json_name = "bJson"];
  int64 c = 3 [(buf.validate.field).int64.example = 5];
  E e = 4 [(buf.validate.field).enum.example = 1];
  string d = 5 [(buf.validate.field).string.protobuf_fqn = true];
  repeated int32 f = 6 [(buf.validate.field).repeated.items.int32 = { example: 1, gt: 0 }];
}
service S {
  rpc R(M) returns (M) { option (${OA}.openapiv2_operation) = { deprecated: true, summary: "s" }; }
}
`),
    check: (r, x) => {
      const m = msg(r.document)
      const p = props(r.document)
      x(m.title).toBe("Schema title")
      x(req(r.document)).toEqual([undefined, ["a", "b"]])
      x(m.options).toEqual({ [`${OA}.openapiv2_schema`]: { json_schema: { description: "x", required: ["nope"] } } })
      x([p.a.examples, p.a.options]).toEqual([["x", "y"], { "buf.validate.field": { string: { ulid: true } } }])
      x([p.c.examples, p.e.examples]).toEqual([["5"], ["E_ONE"]])
      x(p.d.options).toEqual({ "buf.validate.field": { string: { protobuf_fqn: true } } })
      x(p.f.items).toEqual({ type: "int32", exclusiveMinimum: 0, examples: [1] })
      const rpc = (r.document as Doc).services?.["t.S"]?.methods.R
      x([rpc?.deprecation, rpc?.options]).toEqual([{}, { [`${OA}.openapiv2_operation`]: { summary: "s" } }])
    },
  },
  {
    id: "PB-3.14",
    title: "A-14 / decision 8: tag parsing (empty values, quoted @Enum, boolean tags, mixed indentation)",
    sources: src(`message M {
  // @Title
  string a = 1;
  // @Enum "a,b", c, 'd'
  string b = 2;
  // @ReadOnly false
  string c = 3;
  // @ReadOnly yes
  string d = 4;
  // @WriteOnly true
  string e = 5;
  // @Required false
  string f = 6;
  //   Indented   text   here
  //\ttabbed
  string g = 7;
  // @Pattern
  string h = 8;
  // @Default null
  // @Example [1, null]
  string i = 9;
}
`),
    ...both([`invalid-tag @ ${M}/properties/a`, `invalid-tag @ ${M}/properties/d`, `invalid-tag @ ${M}/properties/h`]),
    check: (r, x) => {
      const p = props(r.document)
      x(p.a.title).toBeUndefined()
      x(p.b.enum).toEqual(["a,b", "c", "d"])
      x([p.c.readOnly, p.d.readOnly, p.e.writeOnly]).toEqual([undefined, undefined, true])
      x(req(r.document)).toEqual([undefined, []])
      x(p.g.description).toBe("Indented text here\ntabbed")
      x(p.h.pattern).toBeUndefined()
      x([p.i["x-default"], p.i.examples]).toEqual(["null", ["[1, null]"]])
    },
  },
  {
    id: "PB-3.15",
    title: "A-14: a tag rename that takes another tag's name is an invalid-tag; the rename wins",
    sources: src(`message M {
  // @Example 5
  int32 a = 1;
}
`),
    options: { tags: { default: "Example" } },
    ...both(["invalid-tag @ *"]),
    check: (r, x) => {
      const a = props(r.document).a
      x([a["x-default"], a.examples]).toEqual([5, undefined])
    },
  },
  {
    id: "PB-3.16",
    title: "A-15 / decision 9: every recorded conflict is also an annotation-conflict issue (fields and messages)",
    sources: src(`// @Title Tag title
message M {
  option (${OA}.openapiv2_schema) = { json_schema: { title: "Schema title" } };
  // Required. Text.
  // @MaxLength 9
  string a = 1 [(google.api.field_behavior) = OPTIONAL, (buf.validate.field).string.max_len = 5];
}
`),
    ...both([
      `annotation-conflict @ ${M}/x-annotation-conflicts/0`,
      `annotation-conflict @ ${M}/properties/a/x-annotation-conflicts/0`,
      `annotation-conflict @ ${M}/properties/a/x-annotation-conflicts/1`,
    ]),
    check: (r, x) => {
      // S1: OPTIONAL beats the prefix, so the field carries no `required` keyword (and the message no array)
      x(req(r.document)).toEqual([undefined, []])
      const m = msg(r.document)
      x([m.title, m["x-annotation-conflicts"]]).toEqual([
        "Schema title",
        [
          {
            keyword: "title",
            kept: { source: "openapiv2", value: "Schema title" },
            dropped: { source: "tag", value: "Tag title" },
          },
        ],
      ])
      x(props(r.document).a["x-annotation-conflicts"]).toEqual([
        { keyword: "maxLength", kept: { source: "buf.validate", value: 5 }, dropped: { source: "tag", value: 9 } },
        {
          keyword: "required",
          kept: { source: "google.api", value: false },
          dropped: { source: "prefix", value: true },
        },
      ])
    },
  },
  {
    id: "PB-3.17",
    title: "item 10: AIP prefixes and Deprecated: apply to the description as a whole, also from a trailing comment",
    sources: src(`message M {
  string a = 1; // Required. The id.
  string b = 2; // Deprecated: use c
  // @MaxLength 3
  string c = 3; // Output only. Text.
  // Leading.
  string d = 4; // Required. Not the first line.
}
enum E {
  E_UNSPECIFIED = 0; // Deprecated: no longer used
}
`),
    check: (r, x) => {
      const p = props(r.document)
      x(req(r.document)).toEqual([undefined, ["a"]])
      x(p.a.description).toBe("The id.")
      x([p.b.deprecation, p.b.description]).toEqual([{ reason: "use c" }, undefined])
      x([p.c.readOnly, p.c.maxLength, p.c.description]).toEqual([true, 3, "Text."])
      x(p.d.description).toBe("Leading.\nRequired. Not the first line.")
      const e = (r.document as { components?: { enums?: Record<string, { values: Record<string, unknown> }> } })
        .components?.enums?.["t.E"]
      x(e?.values.E_UNSPECIFIED).toEqual({ deprecation: { reason: "no longer used" }, number: 0 })
    },
  },
  {
    id: "PB-3.18",
    title: "PGV: exclusive ranges, family check and wrappers follow the protovalidate rules",
    sources: src(`message M {
  int32 a = 1 [(validate.rules).int32 = { gt: 10, lt: 5 }];
  google.protobuf.StringValue b = 2 [(validate.rules).string.min_len = 2];
  int64 c = 3 [(validate.rules).string.min_len = 2];
  google.protobuf.Int32Value d = 4 [(validate.rules).message.required = true];
}
`),
    ...both([`invalid-option @ ${M}/properties/c/options/validate.rules`]),
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.exclusiveMinimum, p.a.options]).toEqual([undefined, { "validate.rules": { int32: { gt: 10, lt: 5 } } }])
      x(p.b.minLength).toBe(2)
      x(req(r.document)).toEqual([undefined, ["d"]])
    },
  },
  {
    id: "PB-3.19",
    title: "decision 11: @Enum on numeric, wrapper and enum fields, canonical like protovalidate `in`",
    sources: src(`enum Color {
  COLOR_UNSPECIFIED = 0;
  RED = 1;
  BLUE = 2;
}
message M {
  // @Enum 1, 2, 3
  int32 a = 1;
  // @Enum 1, 18446744073709551615
  uint64 b = 2;
  // @Enum 0.1, 2
  float c = 3;
  // @Enum RED, 2, 7
  Color d = 4;
  // @Enum 5, 6
  google.protobuf.Int64Value e = 5;
  // @Enum 1.5
  int32 f = 6;
  // @Enum PURPLE
  Color g = 7;
  // @Enum 1
  bool h = 8;
  int32 i = 9 [(buf.validate.field).int32 = { in: [1, 2, 3] }];
}
`),
    ...both([`invalid-tag @ ${M}/properties/f`, `invalid-tag @ ${M}/properties/g`, `invalid-tag @ ${M}/properties/h`]),
    check: (r, x) => {
      const p = props(r.document)
      x(p.a.enum).toEqual([1, 2, 3])
      x(p.b.enum).toEqual(["1", "18446744073709551615"])
      x(p.c.enum).toEqual([0.1, 2])
      x(p.d.enum).toEqual(["RED", "BLUE", 7])
      x(p.e.enum).toEqual(["5", "6"])
      x([p.f.enum, p.g.enum, p.h.enum]).toEqual([undefined, undefined, undefined])
      // the tag and the protovalidate rule give the same keyword
      x(p.i.enum).toEqual(p.a.enum)
      x(r.issues.find((i) => i.pointer?.endsWith("/f"))?.message).toContain("1.5 is not an integer")
    },
  },
  {
    id: "PB-3.22",
    title:
      "S1: every annotation source sets the field keyword `required: true`; json_schema.required by proto and JSON name",
    sources: src(`message M {
  option (${OA}.openapiv2_schema) = { json_schema: { required: ["g", "hJson", "i", "nope"] } };
  // @Required
  string a = 1;
  // Required. The b.
  string b = 2;
  string c = 3 [(google.api.field_behavior) = REQUIRED];
  string d = 4 [(buf.validate.field).required = true];
  N e = 5 [(validate.rules).message.required = true];
  // @Required
  // @Format email
  string f = 6 [(buf.validate.field).string.max_len = 9];
  string g = 7;
  string h = 8 [json_name = "hJson"];
  string i = 9 [(google.api.field_behavior) = OPTIONAL];
  // @Required false
  string j = 10;
  N k = 11 [(buf.validate.field).required = true];
  repeated string l = 12 [(buf.validate.field).required = true];
}
message N {}
`),
    ...both([`annotation-conflict @ ${M}/properties/i/x-annotation-conflicts/0`]),
    check: (r, x) => {
      const p = props(r.document)
      x(req(r.document)).toEqual([undefined, ["a", "b", "c", "d", "e", "f", "g", "h", "k", "l"]])
      // the sources are lifted: nothing of them stays under options
      for (const f of "abcdefghkl") x([f, p[f].options]).toEqual([f, undefined])
      x(p.b.description).toBe("The b.")
      // `required` opens the annotation keywords (design §7)
      x(Object.keys(p.f)).toEqual(["number", "type", "required", "format", "maxLength"])
      x(Object.keys(p.h)).toEqual(["number", "type", "jsonName", "required"])
      x(Object.keys(p.e)).toEqual(["number", "$ref", "required"])
      // unmatched names stay under the message's options; OPTIONAL beats json_schema.required, recorded on the field
      x(msg(r.document).options).toEqual({ [`${OA}.openapiv2_schema`]: { json_schema: { required: ["nope"] } } })
      x([p.i.required, p.i.options, p.i["x-annotation-conflicts"]]).toEqual([
        undefined,
        { "google.api.field_behavior": ["OPTIONAL"] },
        [
          {
            keyword: "required",
            kept: { source: "google.api", value: false },
            dropped: { source: "openapiv2", value: true },
          },
        ],
      ])
      x(p.j.required).toBeUndefined()
    },
  },
  {
    id: "PB-3.23",
    title: "S1: a `required` label is wire-level (`presence: required`) and never sets the field keyword; extensions",
    sources: {
      "t2.proto": `syntax = "proto2";
package t;
import "google/api/field_behavior.proto";
message M {
  required string a = 1;
  // @Required
  required string b = 2;
  optional string c = 3 [(google.api.field_behavior) = REQUIRED];
  extensions 100 to 199;
}
extend M {
  // Required. The x.
  optional int32 x = 100;
}
`,
    },
    check: (r, x) => {
      const p = props(r.document)
      x([p.a.presence, p.a.required]).toEqual(["required", undefined])
      x([p.b.presence, p.b.required]).toEqual(["required", true])
      x([p.c.presence, p.c.required]).toEqual(["explicit", true])
      x(msg(r.document).required).toBeUndefined()
      const ext = (r.document as { components?: { extensions?: Record<string, Record<string, unknown>> } }).components
        ?.extensions?.["t.x"]
      x([ext?.required, ext?.description]).toEqual([true, "The x."])
    },
  },
]
