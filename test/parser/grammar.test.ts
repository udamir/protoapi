import { describe, expect, test } from "vite-plus/test"
import { decodeStrLit, parseProto } from "../../src/parser/index.ts"
import { as, bs, enumBody, messageBody, optionNameText, parseOk, topLevel, typeText } from "./helpers.ts"

describe("edition 2024 symbol visibility", () => {
  const text = `edition = "2024";
package shop.v2;
import option "acme/opts.proto";
export message Pet {
  local message Secret { string s = 1; }
  export enum Kind { KIND_UNKNOWN = 0; }
  Secret secret = 1;
}
local enum Internal { INTERNAL_UNKNOWN = 0; }
message Plain {}
export /* note */ message Commented {}
`
  test("top-level and nested modifiers", () => {
    const statements = topLevel(text)
    const pet = as(statements[3], "message")
    expect(pet.visibility?.type).toBe("keyword")
    expect(pet.visibility?.text).toBe("export")
    expect(pet.keyword.text).toBe("message")
    expect(pet.messageName.text).toBe("Pet")
    expect(pet.start).toBe(text.indexOf("export message Pet"))
    const secret = as(pet.messageBody.statements[0], "message")
    expect(secret.visibility?.text).toBe("local")
    expect(secret.messageName.text).toBe("Secret")
    const kind = as(pet.messageBody.statements[1], "enum")
    expect(kind.visibility?.text).toBe("export")
    expect(kind.enumName.text).toBe("Kind")
    as(pet.messageBody.statements[2], "field")
    const internal = as(statements[4], "enum")
    expect(internal.visibility?.text).toBe("local")
    expect(internal.enumName.text).toBe("Internal")
    const plain = as(statements[5], "message")
    expect(plain.visibility).toBeUndefined()
    expect("visibility" in plain).toBe(false)
    const commented = as(statements[6], "message")
    expect(commented.visibility?.text).toBe("export")
    expect(commented.messageName.text).toBe("Commented")
  })

  test("`export` / `local` as type names, field names and message names", () => {
    const body = messageBody(`message M {
  local foo = 1;
  export message = 2;
  local.Foo bar = 3;
  repeated export items = 4;
  local enum = 5;
  message export {}
  enum local { LOCAL_UNKNOWN = 0; }
  export message local {}
}`)
    const f1 = as(body[0], "field")
    expect([typeText(f1.fieldType), f1.fieldName.text]).toEqual(["local", "foo"])
    const f2 = as(body[1], "field")
    expect([typeText(f2.fieldType), f2.fieldName.text]).toEqual(["export", "message"])
    const f3 = as(body[2], "field")
    expect([typeText(f3.fieldType), f3.fieldName.text]).toEqual(["local.Foo", "bar"])
    const f4 = as(body[3], "field")
    expect([f4.fieldLabel?.text, typeText(f4.fieldType), f4.fieldName.text]).toEqual(["repeated", "export", "items"])
    const f5 = as(body[4], "field")
    expect([typeText(f5.fieldType), f5.fieldName.text]).toEqual(["local", "enum"])
    const m = as(body[5], "message")
    expect([m.visibility, m.messageName.text]).toEqual([undefined, "export"])
    const e = as(body[6], "enum")
    expect([e.visibility, e.enumName.text]).toEqual([undefined, "local"])
    const m2 = as(body[7], "message")
    expect([m2.visibility?.text, m2.messageName.text]).toEqual(["export", "local"])
  })
})

describe("imports", () => {
  test("plain, public, weak and option imports", () => {
    const statements = topLevel(`import "a.proto";
import public "b.proto";
import weak "c.proto";
import option "d.proto";
`)
    const mods = statements.map((s) => as(s, "import").weakOrPublic?.text)
    expect(mods).toEqual([undefined, "public", "weak", "option"])
    expect(statements.map((s) => decodeStrLit(as(s, "import").strLit))).toEqual([
      "a.proto",
      "b.proto",
      "c.proto",
      "d.proto",
    ])
  })
})

describe("extension ranges", () => {
  test("extension range options with declarations", () => {
    const body = messageBody(`syntax = "proto2";
message Ext {
  extensions 4 to 1000 [
    declaration = { number: 4, full_name: ".pkg.ext", type: "string" },
    declaration = { number: 5, full_name: ".pkg.other", type: ".pkg.Msg", repeated: true },
    verification = DECLARATION
  ];
  extensions 1001, 2000 to max;
}`)
    const ext = as(body[0], "extensions")
    const range = as(ext.ranges.rangeOrCommas[0], "range")
    expect(range.rangeStart.value.text).toBe("4")
    expect(as(range.rangeEnd, "signed-int-lit").value.text).toBe("1000")
    const options = ext.fieldOptions?.fieldOptionOrCommas.filter((x) => x.type === "field-option") ?? []
    expect(options.map((o) => optionNameText(as(o, "field-option").optionName))).toEqual([
      "declaration",
      "declaration",
      "verification",
    ])
    const decl = as(as(options[0], "field-option").constant, "aggregate")
    const fields = decl.statements.filter((s) => s.type === "textproto-field").map((s) => as(s, "textproto-field"))
    expect(fields.map((f) => as(f.fieldName, "textproto-ident").text)).toEqual(["number", "full_name", "type"])
    expect(as(fields[0].value, "textproto-signed-dec-lit").value.text).toBe("4")
    expect(as(fields[1].value, "textproto-str-lit").tokens[0].text).toBe('".pkg.ext"')
    const verification = as(as(options[2], "field-option").constant, "full-ident")
    expect(typeText(verification)).toBe("DECLARATION")
    const ext2 = as(body[1], "extensions")
    const [r1, , r2] = ext2.ranges.rangeOrCommas
    expect(as(r1, "range").rangeEnd).toBeUndefined()
    expect(as(as(r2, "range").rangeEnd, "max").text).toBe("max")
  })
})

describe("reserved", () => {
  test("editions identifiers, string literals and mixed", () => {
    const body = messageBody(`edition = "2023";
message R {
  reserved OLD, LEGACY;
  reserved "foo", 'bar';
  reserved 2, 15, 9 to 11;
}`)
    const idents = as(as(body[0], "reserved").reserved, "field-names")
    expect(idents.strLitOrCommas.map((x) => x.type)).toEqual(["ident", "comma", "ident"])
    expect(idents.strLitOrCommas.filter((x) => x.type === "ident").map((x) => as(x, "ident").text)).toEqual([
      "OLD",
      "LEGACY",
    ])
    const strings = as(as(body[1], "reserved").reserved, "field-names")
    expect(
      strings.strLitOrCommas.filter((x) => x.type === "str-lit").map((x) => decodeStrLit(as(x, "str-lit"))),
    ).toEqual(["foo", "bar"])
    const ranges = as(as(body[2], "reserved").reserved, "ranges")
    expect(ranges.rangeOrCommas.filter((x) => x.type === "range")).toHaveLength(3)
  })

  test("enum reserved: max, negative ranges, identifiers", () => {
    const body = enumBody(`enum Delta {
  DELTA_ZERO = 0;
  reserved -10 to -1, 2 to 9;
  reserved 100 to max;
  reserved OLD_VALUE;
  reserved "LEGACY";
}`)
    const ranges = as(as(body[1], "reserved").reserved, "ranges")
    const first = as(ranges.rangeOrCommas[0], "range")
    expect(first.rangeStart.sign?.text).toBe("-")
    expect(first.rangeStart.value.text).toBe("10")
    const firstEnd = as(first.rangeEnd, "signed-int-lit")
    expect([firstEnd.sign?.text, firstEnd.value.text]).toEqual(["-", "1"])
    const max = as(as(body[2], "reserved").reserved, "ranges")
    expect(as(as(max.rangeOrCommas[0], "range").rangeEnd, "max").text).toBe("max")
    const ident = as(as(body[3], "reserved").reserved, "field-names")
    expect(as(ident.strLitOrCommas[0], "ident").text).toBe("OLD_VALUE")
    as(as(as(body[4], "reserved").reserved, "field-names").strLitOrCommas[0], "str-lit")
  })
})

describe("option names", () => {
  test("features with parenthesised extension segments", () => {
    const text = `edition = "2023";
option features.(pb.cpp).string_type = CORD;
option (my.opt).sub.(other.ext).leaf = 1;
message Doc {
  string body = 1 [features.(pb.cpp).string_type = CORD, features.field_presence = EXPLICIT];
}`
    const statements = topLevel(text)
    const opt = as(statements[1], "option")
    const segs = opt.optionName.optionNameSegmentOrDots
    expect(segs.map((s) => s.type)).toEqual([
      "option-name-segment",
      "dot",
      "option-name-segment",
      "dot",
      "option-name-segment",
    ])
    const plain = as(segs[0], "option-name-segment")
    expect([plain.bracketOpen, typeText(plain.name)]).toEqual([undefined, "features"])
    const ext = as(segs[2], "option-name-segment")
    expect([ext.bracketOpen?.text, typeText(ext.name), ext.bracketClose?.text]).toEqual(["(", "pb.cpp", ")"])
    expect(typeText(as(opt.constant, "full-ident"))).toBe("CORD")
    expect(optionNameText(as(statements[2], "option").optionName)).toBe("(my.opt).sub.(other.ext).leaf")
    const field = as(as(statements[3], "message").messageBody.statements[0], "field")
    const fieldOpts = field.fieldOptions?.fieldOptionOrCommas.filter((x) => x.type === "field-option") ?? []
    expect(fieldOpts.map((o) => optionNameText(as(o, "field-option").optionName))).toEqual([
      "features.(pb.cpp).string_type",
      "features.field_presence",
    ])
  })
})

describe("groups", () => {
  test("optional / repeated / required groups and oneof groups", () => {
    const body = messageBody(`syntax = "proto2";
message SearchResponse {
  repeated group Result = 1 {
    required string url = 2;
    optional group Inner = 3 [deprecated = true] { optional int32 x = 1; }
  }
  optional group Meta = 4 { optional int32 total = 1; }
  required group Header = 5 { required int32 version = 1; }
  oneof choice {
    group Pick = 6 { optional string name = 1; }
    group Flagged = 7 [deprecated = true] { }
    string other = 8;
  }
}`)
    const result = as(body[0], "group")
    expect([result.groupLabel?.text, result.keyword.text, result.groupName.text, result.fieldNumber.text]).toEqual([
      "repeated",
      "group",
      "Result",
      "1",
    ])
    as(result.messageBody.statements[0], "field")
    const inner = as(result.messageBody.statements[1], "group")
    expect(inner.groupName.text).toBe("Inner")
    expect(inner.fieldOptions?.fieldOptionOrCommas).toHaveLength(1)
    expect(as(body[1], "group").groupLabel?.text).toBe("optional")
    expect(as(body[2], "group").groupLabel?.text).toBe("required")
    const oneof = as(body[3], "oneof")
    const pick = as(oneof.oneofBody.statements[0], "oneof-group")
    expect([pick.groupName.text, pick.fieldNumber.text, pick.fieldOptions]).toEqual(["Pick", "6", undefined])
    as(pick.messageBody.statements[0], "field")
    const flagged = as(oneof.oneofBody.statements[1], "oneof-group")
    expect(flagged.fieldOptions?.fieldOptionOrCommas).toHaveLength(1)
    as(oneof.oneofBody.statements[2], "oneof-field")
  })

  test("groups in extend blocks", () => {
    const statements = topLevel(`syntax = "proto2";
extend Foo { optional group Ext = 100 { optional int32 a = 1; } }`)
    const ext = as(statements[1], "extend")
    expect(as(ext.extendBody.statements[0], "group").groupName.text).toBe("Ext")
  })
})

describe("message body constructs", () => {
  test("extend inside a message, oneof options, map fields", () => {
    const body = messageBody(`message Shipping {
  extend Order { optional Shipping shipping = 150; repeated string notes = 151; }
  oneof method {
    option (acme.opts.group) = "billing";
    string card_token = 1;
  }
  map<string, int32> counts = 2 [deprecated = true];
  map m = 3;
  optional string carrier = 4;
}`)
    const ext = as(body[0], "extend")
    expect(typeText(ext.messageType)).toBe("Order")
    expect(ext.extendBody.statements.map((s) => as(s, "field").fieldName.text)).toEqual(["shipping", "notes"])
    const oneof = as(body[1], "oneof")
    const opt = as(oneof.oneofBody.statements[0], "option")
    expect(optionNameText(opt.optionName)).toBe("(acme.opts.group)")
    expect(decodeStrLit(as(opt.constant, "str-lit"))).toBe("billing")
    const map = as(body[2], "map-field")
    expect([typeText(map.keyType), typeText(map.valueType), map.mapName.text]).toEqual(["string", "int32", "counts"])
    const mapAsType = as(body[3], "field")
    expect([typeText(mapAsType.fieldType), mapAsType.fieldName.text]).toEqual(["map", "m"])
    expect(as(body[4], "field").fieldLabel?.text).toBe("optional")
  })

  test("label keywords and other keywords as field names (EX-SCAL-3)", () => {
    const body = messageBody(`message Odd {
  string message  = 5;
  int32  optional = 1;
  bool   stream   = 3;
  string type     = 2;
  bytes  syntax   = 4;
  string reserved = 6;
  int32 required = 7;
  int32 repeated = 8;
  int32 group = 9;
  int32 map = 10;
  int32 option = 11;
  int32 oneof = 12;
}`)
    const fields = body.map((s) => as(s, "field"))
    expect(fields.map((f) => [f.fieldLabel, typeText(f.fieldType), f.fieldName.text])).toEqual([
      [undefined, "string", "message"],
      [undefined, "int32", "optional"],
      [undefined, "bool", "stream"],
      [undefined, "string", "type"],
      [undefined, "bytes", "syntax"],
      [undefined, "string", "reserved"],
      [undefined, "int32", "required"],
      [undefined, "int32", "repeated"],
      [undefined, "int32", "group"],
      [undefined, "int32", "map"],
      [undefined, "int32", "option"],
      [undefined, "int32", "oneof"],
    ])
  })

  test("type names starting with keywords (pbkit matched keyword prefixes)", () => {
    const body = messageBody(`message M {
  messageType a = 1;
  optionalFoo b = 2;
  mapping c = 3;
  enumValue d = 4;
  groupInfo e = 5;
  reservedWord f = 6;
  extensionsList g = 7;
  oneofCase h = 8;
  optional optional.Foo i = 9;
}`)
    const fields = body.map((s) => as(s, "field"))
    expect(fields.map((f) => [f.fieldLabel?.text, typeText(f.fieldType), f.fieldName.text])).toEqual([
      [undefined, "messageType", "a"],
      [undefined, "optionalFoo", "b"],
      [undefined, "mapping", "c"],
      [undefined, "enumValue", "d"],
      [undefined, "groupInfo", "e"],
      [undefined, "reservedWord", "f"],
      [undefined, "extensionsList", "g"],
      [undefined, "oneofCase", "h"],
      ["optional", "optional.Foo", "i"],
    ])
  })
})

describe("services", () => {
  test("stream keyword, stream as identifier, method bodies", () => {
    const statements = topLevel(`service S {
  rpc A(stream) returns (stream stream);
  rpc B(streamX) returns (stream .pkg.Foo) {}
  rpc C(stream Foo) returns (Bar) { option deprecated = true; }
  rpc D(Foo) returns (Bar) { ; option idempotency_level = IDEMPOTENT; ; }
  ;
  option (svc.opt) = true;
}
message stream {}`)
    const svc = as(statements[0], "service")
    const [a, b, c, d, empty, opt] = svc.serviceBody.statements
    const ra = as(a, "rpc")
    expect([ra.reqType.stream, typeText(ra.reqType.messageType)]).toEqual([undefined, "stream"])
    expect([ra.resType.stream?.text, typeText(ra.resType.messageType)]).toEqual(["stream", "stream"])
    as(ra.semiOrRpcBody, "semi")
    const rb = as(b, "rpc")
    expect([rb.reqType.stream, typeText(rb.reqType.messageType)]).toEqual([undefined, "streamX"])
    expect([rb.resType.stream?.text, typeText(rb.resType.messageType)]).toEqual(["stream", ".pkg.Foo"])
    expect(as(rb.semiOrRpcBody, "rpc-body").statements).toEqual([])
    const rc = as(c, "rpc")
    expect(rc.reqType.stream?.text).toBe("stream")
    const cBody = as(rc.semiOrRpcBody, "rpc-body")
    expect(optionNameText(as(cBody.statements[0], "option").optionName)).toBe("deprecated")
    const dBody = as(as(d, "rpc").semiOrRpcBody, "rpc-body")
    expect(dBody.statements.map((s) => s.type)).toEqual(["empty", "option", "empty"])
    as(empty, "empty")
    as(opt, "option")
    expect(as(statements[1], "message").messageName.text).toBe("stream")
  })
})

describe("empty statements", () => {
  test("at every level", () => {
    const statements = topLevel(`;
syntax = "proto3";;
message M { ; int32 a = 1;; oneof o { ; int32 b = 2; } }
enum E { ; A = 0; ; }
service S { ; }
`)
    expect(statements.map((s) => s.type)).toEqual(["empty", "syntax", "empty", "message", "enum", "service"])
    const m = as(statements[3], "message")
    expect(m.messageBody.statements.map((s) => s.type)).toEqual(["empty", "field", "empty", "oneof"])
    const oneof = as(m.messageBody.statements[3], "oneof")
    expect(oneof.oneofBody.statements.map((s) => s.type)).toEqual(["empty", "oneof-field"])
    expect(as(statements[4], "enum").enumBody.statements.map((s) => s.type)).toEqual(["empty", "enum-field", "empty"])
    expect(as(statements[5], "service").serviceBody.statements.map((s) => s.type)).toEqual(["empty"])
  })
})

describe("constants", () => {
  function fieldDefault(body: string): import("../../src/parser/index.ts").Constant {
    const field = as(messageBody(`syntax = "proto2"; message L { ${body} }`)[0], "field")
    const opt = field.fieldOptions?.fieldOptionOrCommas[0]
    return as(opt, "field-option").constant
  }

  test("string concatenation and quotes", () => {
    const c = as(fieldDefault(`optional string s = 1 [default = "multi" 'part' /* c */ "!"];`), "str-lit")
    expect(c.tokens.map((t) => t.text)).toEqual(['"multi"', "'part'", '"!"'])
    expect(decodeStrLit(c)).toBe("multipart!")
  })

  test("octal, hex and unicode escapes", () => {
    const src = `"${bs}101${bs}x42é${bs}"q${bs}"${bs}u00e9${bs}U0001F600${bs}0${bs}7${bs}77${bs}x4${bs}?"`
    const c = as(fieldDefault(`optional string s = 1 [default = ${src}];`), "str-lit")
    expect(c.tokens).toHaveLength(1)
    expect(decodeStrLit(c)).toBe('ABé"q"é\u{1F600}\u{0}\u{7}?\u{4}?')
  })

  test("float constants: inf, -inf, nan, exponents", () => {
    const values = ["inf", "-inf", "nan", "1e-3", "1E300", ".5", "1.", "-2.5e+10", "+1.5"].map((v) =>
      as(fieldDefault(`optional double d = 1 [default = ${v}];`), "signed-float-lit"),
    )
    expect(values.map((v) => `${v.sign?.text ?? ""}${v.value.text}`)).toEqual([
      "inf",
      "-inf",
      "nan",
      "1e-3",
      "1E300",
      ".5",
      "1.",
      "-2.5e+10",
      "+1.5",
    ])
  })

  test("identifiers that start like literals stay identifiers", () => {
    for (const v of ["information", "INF", "NAN", "nanos", "trueish", "false_value", "infinity"]) {
      expect(typeText(as(fieldDefault(`optional E e = 1 [default = ${v}];`), "full-ident"))).toBe(v)
    }
    expect(as(fieldDefault("optional bool b = 1 [default = true];"), "bool-lit").text).toBe("true")
  })

  test("integers: hex, octal, signs", () => {
    const values = ["0x10", "-0x7f", "017", "+5", "-9223372036854775808", "18446744073709551615", "0", "0X1F"].map(
      (v) => as(fieldDefault(`optional int64 i = 1 [default = ${v}];`), "signed-int-lit"),
    )
    expect(values.map((v) => [v.sign?.text, v.value.text])).toEqual([
      [undefined, "0x10"],
      ["-", "0x7f"],
      [undefined, "017"],
      ["+", "5"],
      ["-", "9223372036854775808"],
      [undefined, "18446744073709551615"],
      [undefined, "0"],
      [undefined, "0X1F"],
    ])
    const e = enumBody("enum E { A = -0x10; B = 017; C = -1; }").map((s) => as(s, "enum-field").fieldNumber)
    expect(e.map((n) => `${n.sign?.text ?? ""}${n.value.text}`)).toEqual(["-0x10", "017", "-1"])
  })

  test("aggregate values with nested messages, lists, hex, extension and Any names", () => {
    const statements = topLevel(`message Quota {
  option (acme.opts.limits) = {
    tier: HIGH
    max: 9007199254740993
    ratio: inf
    blob: "${bs}x00${bs}x01"
    ranges { lo: 1 hi: 2 }
    ranges: [{ lo: 5 hi: 9 }, < lo: 10 >]
    delta: -0x10;
    scale: 2.5f,
    [pkg.ext]: 1
    any { [type.googleapis.com/pkg.T] { a: 1 } }
    # textproto comment
    names: ["a" "b", 'c']
  };
}`)
    const opt = as(as(statements[0], "message").messageBody.statements[0], "option")
    const agg = as(opt.constant, "aggregate")
    const fields = agg.statements.map((s) => as(s, "textproto-field"))
    const name = (f: (typeof fields)[number]) =>
      f.fieldName.type === "textproto-ident" ? f.fieldName.text : f.fieldName.type
    expect(fields.map(name)).toEqual([
      "tier",
      "max",
      "ratio",
      "blob",
      "ranges",
      "ranges",
      "delta",
      "scale",
      "textproto-extension-name",
      "any",
      "names",
    ])
    expect(fields.map((f) => f.value.type)).toEqual([
      "textproto-signed-ident",
      "textproto-signed-dec-lit",
      "textproto-signed-ident",
      "textproto-str-lit",
      "textproto-message-value",
      "textproto-list-value",
      "textproto-signed-hex-lit",
      "textproto-signed-float-lit",
      "textproto-signed-dec-lit",
      "textproto-message-value",
      "textproto-list-value",
    ])
    const delta = as(fields[6].value, "textproto-signed-hex-lit")
    expect([delta.sign?.text, delta.value.text]).toEqual(["-", "0x10"])
    expect(fields[6].semiOrComma?.type).toBe("textproto-semi")
    expect(fields[7].semiOrComma?.type).toBe("textproto-comma")
    const any = as(as(fields[9].value, "textproto-message-value").statements[0], "textproto-field")
    const anyName = as(any.fieldName, "textproto-any-name")
    expect(anyName.domain.identOrDots.map((x) => x.text).join("")).toBe("type.googleapis.com")
    expect(anyName.typeName.identOrDots.map((x) => x.text).join("")).toBe("pkg.T")
    const list = as(fields[5].value, "textproto-list-value")
    expect(list.valueOrCommas.map((v) => v.type)).toEqual([
      "textproto-message-value",
      "textproto-comma",
      "textproto-message-value",
    ])
    expect(as(list.valueOrCommas[2], "textproto-message-value").bracketOpen.text).toBe("<")
    const names = as(fields[10].value, "textproto-list-value")
    expect(as(names.valueOrCommas[0], "textproto-str-lit").tokens).toHaveLength(2)
  })
})

describe("syntax, edition, package", () => {
  test("header statements", () => {
    const [syntax, pkg, opt] = topLevel(`syntax = 'proto2';\npackage a.b.c;\noption java_package = "x";`)
    expect(as(syntax, "syntax").syntax.text).toBe("proto2")
    expect(typeText(as(pkg, "package").fullIdent)).toBe("a.b.c")
    expect(optionNameText(as(opt, "option").optionName)).toBe("java_package")
    const [edition] = topLevel(`edition = "2023";`)
    expect(as(edition, "edition").edition.text).toBe("2023")
  })

  test("tiny inputs parse (pbkit's loop counter rejected them)", () => {
    expect(parseOk(";").ast.statements.map((s) => s.type)).toEqual(["empty"])
    expect(parseOk("message A{}").ast.statements.map((s) => s.type)).toEqual(["message"])
    expect(parseOk("").ast.statements).toEqual([])
    expect(parseProto("// only a comment").error).toBeUndefined()
  })
})
