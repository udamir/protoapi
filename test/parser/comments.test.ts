import { describe, expect, test } from "vite-plus/test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type * as ast from "../../src/parser/index.ts"
import { as, comments, fixturesDir, parseOk, topLevel } from "./helpers.ts"
import { type SciLocation, compareComments } from "./sci.ts"
import { IMAGES, fixtureSets, loadImage, loadSources } from "../helpers.ts"
import { bundledFiles } from "../../src/index.ts"

/** The SourceCodeInfo locations of one file of a set's buf image. */
const locationsOf = (set: string, name: string): SciLocation[] =>
  (loadImage(set) as unknown as { file: { name: string; sourceCodeInfo?: { location: SciLocation[] } }[] }).file.find(
    (f) => f.name === name,
  )?.sourceCodeInfo?.location ?? []

const messageBodyOf = (text: string) => as(topLevel(text)[0], "message").messageBody.statements

const fixture = (name: string) => readFileSync(join(fixturesDir, "appendix-a", name), "utf8")

/** Statements of a body, keyed by declared name. */
function byName(
  statements: readonly (ast.Statement | ast.OneofBodyStatement)[],
): Record<string, ast.Statement | ast.OneofBodyStatement> {
  const out: Record<string, ast.Statement | ast.OneofBodyStatement> = {}
  for (const s of statements) {
    const name =
      "fieldName" in s && s.fieldName
        ? s.fieldName.text
        : "messageName" in s
          ? s.messageName.text
          : "enumName" in s
            ? s.enumName.text
            : "serviceName" in s
              ? s.serviceName.text
              : "rpcName" in s
                ? s.rpcName.text
                : "oneofName" in s
                  ? s.oneofName.text
                  : "mapName" in s
                    ? s.mapName.text
                    : `#${Object.keys(out).length}`
    out[name] = s
  }
  return out
}

describe("protoc attachment rules (SourceCodeInfo documentation, EX-CMT-1)", () => {
  // Expected groups are protoc's documented ones; buf 1.75.0 produces the same for this file.
  const statements = topLevel(fixture("ex-cmt-1.proto"))
  const attach = as(statements[1], "message")
  const fields = byName(attach.messageBody.statements)

  test("same-line trailing comment", () => {
    expect(comments(fields.foo)).toEqual({ L: [], T: [["// Comment attached to foo."]], D: [] })
  })
  test("leading comment directly above", () => {
    expect(comments(fields.bar)).toEqual({ L: [["// Comment attached to bar."]], T: [], D: [] })
  })
  test("trailing comment on the following lines, ended by a blank line", () => {
    expect(comments(fields.baz)).toEqual({
      L: [],
      T: [["// Comment attached to baz.", "// Another line attached to baz."]],
      D: [],
    })
  })
  test("multi-line leading comment with an empty `//` line", () => {
    expect(comments(fields.moo)).toEqual({
      L: [["// Comment attached to moo.", "//", "// Another line attached to moo."]],
      T: [],
      D: [],
    })
  })
  test("detached comments, block trailing comment", () => {
    expect(comments(fields.corge)).toEqual({
      L: [],
      T: [["/* Block comment attached\n   * to corge.  Leading asterisks\n   * will be removed. */"]],
      D: [
        [
          "// Detached comment for corge. This is not leading or trailing comments",
          "// to moo or corge because there are blank lines separating it from",
          "// both.",
        ],
        ["// Detached comment for corge paragraph 2."],
      ],
    })
  })
  test("block leading comment after a block trailing comment", () => {
    expect(comments(fields.grault)).toEqual({
      L: [["/* Block comment attached to\n   * grault. */"]],
      T: [],
      D: [],
    })
  })
  test("message itself has no comments", () => {
    expect(comments(attach)).toEqual({ L: [], T: [], D: [] })
  })
})

describe("EX-CMT-2 and EX-CMT-3 (checked against buf 1.75.0)", () => {
  test("doc block, trailing after `{`, every element kind", () => {
    const s = byName(topLevel(fixture("ex-cmt-2.proto")))
    expect(comments(s.Pet)).toEqual({ L: [["/**\n * A pet.\n */"]], T: [["// pets are animals"]], D: [] })
    const pet = byName(as(s.Pet, "message").messageBody.statements)
    expect(comments(pet.name)).toEqual({ L: [["// The name."]], T: [["// shown in the UI"]], D: [] })
    expect(comments(s.Status)).toEqual({ L: [["// Status of a pet."]], T: [], D: [] })
    const status = byName(as(s.Status, "enum").enumBody.statements)
    expect(comments(status.STATUS_UNSPECIFIED)).toEqual({ L: [], T: [["// not set"]], D: [] })
    expect(comments(s.PetService)).toEqual({ L: [], T: [], D: [] })
    const svc = byName(as(s.PetService, "service").serviceBody.statements)
    expect(comments(svc.GetPet)).toEqual({ L: [["// Gets one pet."]], T: [["// cheap"]], D: [] })
  })

  test("comments on oneofs, options inside methods, markers and whitespace kept raw", () => {
    const s = byName(topLevel(fixture("ex-cmt-3.proto")))
    const svc = byName(as(s.PetService, "service").serviceBody.statements)
    const getPet = as(svc.GetPet, "rpc")
    expect(comments(getPet)).toEqual({ L: [["// Gets a pet."]], T: [], D: [] })
    const option = as(getPet.semiOrRpcBody, "rpc-body").statements[0]
    expect(comments(option)).toEqual({ L: [["// Not attached to the method."]], T: [], D: [] })
    const pet = byName(as(s.Pet, "message").messageBody.statements)
    expect(comments(pet.kind)).toEqual({ L: [["// Kind of pet."]], T: [], D: [] })
    const kind = byName(as(pet.kind, "oneof").oneofBody.statements)
    expect(comments(kind.dog)).toEqual({ L: [], T: [["// a dog"]], D: [] })
    expect(comments(kind.cat)).toEqual({ L: [], T: [], D: [] })
    expect(comments(pet.notes)).toEqual({ L: [["// Lists:", "//", "//   * one", "//   * two"]], T: [], D: [] })
    expect(comments(pet.raw)).toEqual({ L: [["//no space after the marker"]], T: [], D: [] })
    // raw text keeps inner and trailing whitespace (`trim()` in the helper only strips the ends)
    const spaced = as(pet.spaced, "field").leadingComments[0].comments[0].text
    expect(spaced).toBe("// Inner    spaces and a\ttab.   \n")
  })
})

describe("further rules (buf 1.75; every expectation is buf's SourceCodeInfo for this text)", () => {
  const text = `// P6 header
syntax = "proto3"; // P17 syntax trailing
package c;
message M1 {
  int32 a = 1;
  // P1 single group then blank

  int32 b = 2;
  // P2 g1

  // P2 g2
}
message M3 {
  int32 a = 1; // P3 t
  // P3 next

  int32 b = 2; /* P4 t */ // P4 u
  int32 c = 3;
  /* P5 a */ /* P5 b */
  int32 d = 4;
  // P13 l1
  /* P13 b */
  // P13 l2
  int32 e = 5;
}
message M7 {
  // P7 only comment
}
message M9 { /* P9 x */ }
enum E10 { A = 0; }  // P10 after close
// P10 leading of F
message F10 {}
message M15 {
  // P15 d

  // P15 l
  int32 a = 1;
}
message M20 {
  int32 a = 1; /* P20 block
     trailing */
  int32 b = 2;
}
`
  const s = byName(topLevel(text))
  const body = (name: string) => byName(as(s[name], "message").messageBody.statements)

  test("file header comment leads `syntax`; same-line comment trails it", () => {
    expect(comments(s["#0"])).toEqual({ L: [["// P6 header"]], T: [["// P17 syntax trailing"]], D: [] })
  })
  test("a group on the next line followed by a blank line trails the previous declaration", () => {
    expect(comments(body("M1").a)).toEqual({ L: [], T: [["// P1 single group then blank"]], D: [] })
  })
  test("before `}`: the first group trails the last declaration, the rest is dropped", () => {
    expect(comments(body("M1").b)).toEqual({ L: [], T: [["// P2 g1"]], D: [] })
  })
  // Q0-P phase C (IN-10): protoc makes `P3 next` a detached comment of `b`
  test("after a same-line trailing comment, a next-line group followed by a blank line is attached to nothing", () => {
    expect(comments(body("M3").b)).toEqual({ L: [], T: [["/* P4 t */"]], D: [] })
  })
  // Q0-P phase C (IN-10): protoc drops both comments
  test("a same-line block comment followed by a `//` comment: the block trails, the `//` comment leads the next", () => {
    expect(comments(body("M3").c)).toEqual({ L: [["// P4 u"]], T: [["/* P5 a */"]], D: [] })
  })
  test("two block comments on one line: the first trails, the second leads", () => {
    expect(comments(body("M3").d)).toEqual({ L: [["/* P5 b */"]], T: [["// P13 l1"]], D: [] })
  })
  test("switching between `//` and `/* */` starts a new group", () => {
    expect(comments(body("M3").e)).toEqual({ L: [["// P13 l2"]], T: [], D: [["/* P13 b */"]] })
  })
  test("a comment alone in a body trails the block's `{`", () => {
    expect(comments(s.M7)).toEqual({ L: [], T: [["// P7 only comment"]], D: [] })
  })
  // Q0-P phase C (IN-10): protoc drops it
  test("a block comment between `{` and `}` on one line trails the block", () => {
    expect(comments(s.M9)).toEqual({ L: [], T: [["/* P9 x */"]], D: [] })
  })
  test("a comment after `}` is not attached; the next line leads the next declaration", () => {
    expect(comments(s.E10)).toEqual({ L: [], T: [], D: [] })
    expect(comments(s.F10)).toEqual({ L: [["// P10 leading of F"]], T: [], D: [] })
    // Q0-P phase C (IN-10): a block comment after `}` and a newline leads the next declaration (protoc: the `}`'s trailing comment, hence dropped)
    const [d, e] = topLevel("message D {} /* after D */\nmessage E {}")
    expect(comments(d)).toEqual({ L: [], T: [], D: [] })
    expect(comments(e)).toEqual({ L: [["/* after D */"]], T: [], D: [] })
  })
  test("after `{`: first group + blank line trails the block, the next group leads the first statement", () => {
    expect(comments(s.M15)).toEqual({ L: [], T: [["// P15 d"]], D: [] })
    expect(comments(body("M15").a)).toEqual({ L: [["// P15 l"]], T: [], D: [] })
  })
  // Q0-P phase C (IN-10): protoc makes it the trailing comment of `a`
  test("a multi-line block comment starting on the declaration's line leads the next declaration", () => {
    expect(comments(body("M20").a)).toEqual({ L: [], T: [], D: [] })
    expect(comments(body("M20").b)).toEqual({ L: [["/* P20 block\n     trailing */"]], T: [], D: [] })
  })

  test("a single block comment on the first line before the first token is dropped (buf; protoc: detached)", () => {
    const [syntax] = topLevel(`/* c */ syntax = "proto3";`)
    expect(comments(syntax)).toEqual({ L: [], T: [], D: [] })
    const [header] = topLevel(`// h\n\n/* c */ syntax = "proto3";`)
    expect(comments(header)).toEqual({ L: [], T: [], D: [["// h"], ["/* c */"]] })
  })

  // final cleanup: this was a syntax error; Q0-P phase C (IN-10): protoc drops `b`
  test("a same-line block comment followed by more comments before `}` parses; the block comment trails", () => {
    const [m] = topLevel("message M {\n  int32 a = 1; /* b */ // l\n /* m\n */}\n")
    expect(comments(as(m, "message").messageBody.statements[0])).toEqual({ L: [], T: [["/* b */"]], D: [] })
  })

  // Q0-P phase C (IN-10): protoc makes `t` the trailing comment of the option
  test("comments after the last token of the input are attached to nothing", () => {
    const [, option] = topLevel('syntax = "proto3";\noption java_package = "x"; // t\n// u\n')
    expect(comments(option)).toEqual({ L: [], T: [], D: [] })
  })

  test("detached comments: the blank lines are counted from the previous token in the body and to the token after the next one", () => {
    // `b` has no blank line around it, yet it is detached: buf counts from `a = 1;` (the previous token) and to `e` (the token after `int32`), across the other comments
    const fields = byName(
      messageBodyOf("message M {\n  int32 a = 1;\n  /* a */\n  /* b */\n  /* c */\n  int32 e = 5;\n}"),
    )
    expect(comments(fields.a)).toEqual({ L: [], T: [["/* a */"]], D: [] })
    expect(comments(fields.e)).toEqual({ L: [["/* c */"]], T: [], D: [["/* b */"]] })
    // the token after the next one on another line adds its newlines
    const split = byName(messageBodyOf("message M {\n  int32 a = 1;\n  /* a */\n  /* b */\n  int32\n  e = 5;\n}"))
    expect(comments(split.e)).toEqual({ L: [["/* b */"]], T: [], D: [] })
    // at the end of a body there is no token after the next one: nothing is detached
    const [m] = topLevel("message M {\n  // a\n\n  // b\n\n  // c\n}")
    expect(comments(m)).toEqual({ L: [], T: [["// a"]], D: [] })
  })

  test("CRLF line endings", () => {
    const crlf =
      'syntax = "proto3";\r\n// lead\r\nmessage A { // t\r\n  int32 a = 1; // a\r\n\r\n  // b lead\r\n  int32 b = 2;\r\n}\r\n'
    const [, a] = topLevel(crlf)
    expect(comments(a)).toEqual({ L: [["// lead"]], T: [["// t"]], D: [] })
    const fields = byName(as(a, "message").messageBody.statements)
    expect(comments(fields.a)).toEqual({ L: [], T: [["// a"]], D: [] })
    expect(comments(fields.b)).toEqual({ L: [["// b lead"]], T: [], D: [] })
    expect(as(fields.b, "field").leadingComments[0].comments[0].text).toBe("// b lead\r\n")
  })
})

describe("a block comment ending on the line of the next token (buf 1.75, PB-2.7)", () => {
  // Every expectation below is buf 1.75.0's SourceCodeInfo for this text (protocompile experimental/fdp). protoc makes the block comment the leading comment of the next declaration.
  const text = `syntax = "proto3";
message M {
  int32 a = 1;
  /* c1 */ int32 b = 2;
  // x
  /* c2 */ int32 c = 3;

  /* c3 */ int32 d = 4;
  /* c5 */ /* c6 */ int32 e = 5;
  /* c7
  */ int32 f = 6;

  // d4

  /* c8 */ int32 g = 7;

  // d6
  /* c9 */ int32 h = 8;

  // d10

  // d11
  /* c12 */ int32 i = 9;
  // d13

  // d14
  /* c15 */ int32 j = 10;
}
enum E {
  /* e1 */ E0 = 0;
}
service S {
  /* s1 */ rpc R(M) returns (M);
}
/* o1 */ option java_package = "x";
`
  const s = byName(topLevel(text))
  const body = byName(as(s.M, "message").messageBody.statements)
  const none = { L: [], T: [], D: [] }

  test("alone: leads nothing (message field, enum value, method, option)", () => {
    expect(comments(body.b)).toEqual({ L: [], T: [["// x"]], D: [] })
    expect(comments(body.f)).toEqual(none)
    expect(comments(as(s.E, "enum").enumBody.statements[0])).toEqual(none)
    expect(comments(as(s.S, "service").serviceBody.statements[0])).toEqual(none)
    expect(comments(s["#4"])).toEqual(none)
  })
  test("after another group: the first group still trails the previous declaration", () => {
    expect(comments(body.c)).toEqual(none)
    expect(comments(body.d)).toEqual({ L: [], T: [["/* c5 */"]], D: [] })
    expect(comments(body.e)).toEqual(none)
  })
  test("detached from the first group with a blank line before and after it, the block comment included", () => {
    expect(comments(body.g)).toEqual({ L: [], T: [], D: [["// d4"], ["/* c8 */"]] })
    expect(comments(body.h)).toEqual(none)
    expect(comments(body.i)).toEqual({ L: [], T: [["// d13"]], D: [["// d10"], ["// d11"], ["/* c12 */"]] })
    expect(comments(body.j)).toEqual(none)
  })
})

describe("comments list", () => {
  test("every comment once, in source order, including trailing ones and comments inside statements", () => {
    const text = `// a
syntax = "proto3"; // b
message /* c */ M { // d
  optional /* e */ Foo x = 1 [ /* f */ (o) = { # g
    k: 1 // h
  }]; // i
  local foo = 2; // j
}
// k`
    const r = parseOk(text)
    expect(r.comments.map((c) => c.text.replace(/^(\/\/|\/\*|#)\s*/, "").trim()[0])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
    ])
    expect(r.comments.map((c) => c.type)).toEqual([
      "singleline-comment",
      "singleline-comment",
      "multiline-comment",
      "singleline-comment",
      "multiline-comment",
      "multiline-comment",
      "textproto-comment",
      "singleline-comment",
      "singleline-comment",
      "singleline-comment",
      "singleline-comment",
    ])
    for (const c of r.comments) expect(text.slice(c.start, c.end)).toBe(c.text)
  })
})

describe("buf 1.75 images as the oracle (IN-10, Q0-P phase C)", () => {
  // every comment group of syntax, package, messages, fields, oneofs, enums, values, services and methods equals the buf image's SourceCodeInfo; named/comments-fuzz is the differential fuzz of scripts/comment-fuzz.ts (seed 1), with no layout excluded
  const sets = fixtureSets().filter((s) => s === "named/comments" || s.startsWith("named/comments-"))
  test("the comment fixtures", () => {
    expect(sets).toEqual([
      "named/comments",
      "named/comments-after-trailing",
      "named/comments-at-eof",
      "named/comments-block-after-close",
      "named/comments-block-after-decl",
      "named/comments-block-in-empty-body",
      "named/comments-block-then-line",
      "named/comments-fuzz",
      "named/comments-multiline-block-after-decl",
      "named/comments-same-line",
    ])
  })
  for (const set of sets) {
    test(set, () => {
      for (const [name, text] of Object.entries(loadSources(set))) {
        const locations = locationsOf(set, name)
        expect(locations.length).toBeGreaterThan(0)
        expect({ name, diffs: compareComments(text, locations) }).toEqual({ name, diffs: [] })
      }
    })
  }
  test("every fixture set with a buf image (bundle subsets, catalogue, corpora, buf breaking testdata)", () => {
    let files = 0
    for (const set of fixtureSets()) {
      if (!existsSync(join(IMAGES, `${set}.json`))) continue
      for (const [name, text] of Object.entries(loadSources(set))) {
        const locations = locationsOf(set, name)
        if (!locations.length) continue
        files++
        expect({ set, name, diffs: compareComments(text, locations) }).toEqual({ set, name, diffs: [] })
      }
    }
    expect(files).toBeGreaterThan(400)
  })
  test("every bundled file (test/images/bundle.json)", () => {
    for (const [name, text] of Object.entries(bundledFiles)) {
      const locations = locationsOf("bundle", name)
      expect(locations.length).toBeGreaterThan(0)
      expect({ name, diffs: compareComments(text, locations) }).toEqual({ name, diffs: [] })
    }
  })
  test("the fuzz fixture covers many declarations with comments", () => {
    const located = locationsOf("named/comments-fuzz", "fuzz.proto")
    expect(located.filter((l) => l.leadingComments !== undefined).length).toBeGreaterThan(300)
    expect(located.filter((l) => l.trailingComments !== undefined).length).toBeGreaterThan(300)
    expect(located.filter((l) => l.leadingDetachedComments?.length).length).toBeGreaterThan(100)
  })
})
