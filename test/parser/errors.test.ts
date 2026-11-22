import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parseConstant, parseProto, parseTextprotoMessage } from "../../src/parser"
import { bundleDir, listProtoFiles } from "./helpers"

describe("syntax errors", () => {
  test("EX-DIAG-3: missing field number", () => {
    const text = "message Pet { string name = ; }"
    const r = parseProto(text)
    expect(r.ast).toEqual({ statements: [] })
    expect(r.error?.offset).toBe(text.indexOf(";"))
    expect(r.error?.offset).toBe(28)
    expect(r.error?.found).toBe(";")
    expect(r.error?.expected).toEqual(["integer literal"])
    expect(r.error?.message).toBe('expected integer literal, got ";"')
  })

  test("the first error wins when recovery continues", () => {
    const text = 'syntax = "proto3";\nmessage A {\n  string a = ;\n  int32 b = 2;\n  bad bad bad;\n}'
    const r = parseProto(text)
    expect(r.error?.offset).toBe(text.indexOf("= ;") + 2)
  })

  test("trailing garbage after the last statement", () => {
    const text = "message A {}\ngarbage here"
    const r = parseProto(text)
    // decision 14 (phase D): the statements before the error are the partial AST
    expect(r.ast.statements.map((s) => s.type)).toEqual(["message"])
    expect(r.issues).toEqual([
      {
        code: "syntax",
        message: r.error?.message ?? "",
        file: "input.proto",
        location: { file: "input.proto", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      },
    ])
    expect(r.error?.offset).toBe(text.indexOf("garbage"))
    expect(r.error?.found).toBe("garbage")
    expect(r.error?.expected).toContain('"message"')
  })

  test("unexpected end of input", () => {
    const text = "message A {\n  int32 a = 1;\n"
    const r = parseProto(text)
    expect(r.error?.offset).toBe(text.length)
    expect(r.error?.found).toBeUndefined()
    expect(r.error?.expected).toEqual(['"}"'])
    expect(r.error?.message).toBe('expected "}", got <EOF>')
  })

  test("missing semicolon", () => {
    const text = 'syntax = "proto3"\nmessage A {}'
    const r = parseProto(text)
    expect(r.error?.offset).toBe(text.indexOf("message"))
    expect(r.error?.found).toBe("message")
  })

  test("unterminated string and block comment", () => {
    const s = 'option x = "abc;\nmessage A {}'
    expect(parseProto(s).error?.offset).toBe(s.indexOf('"'))
    const c = "message A {} /* never closed"
    expect(parseProto(c).error?.offset).toBe(c.indexOf("/*"))
  })

  test("invalid statement in a body", () => {
    const text = "enum E { A = 0; 42; }"
    const r = parseProto(text)
    expect(r.error?.offset).toBe(text.indexOf("42"))
    expect(r.error?.found).toBe("42")
  })

  test("parseProto never throws on mutated real files", () => {
    const files = listProtoFiles(bundleDir).map((f) => readFileSync(f, "utf8"))
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const junk = ["{", "}", ";", "=", '"', "/*", "//", "[", "(", "<", "-", "\n", "x", "0x", "\\"]
    let errors = 0
    for (let i = 0; i < 300; i++) {
      const text = files[Math.floor(random() * files.length)]
      const at = Math.floor(random() * text.length)
      const mutated =
        random() < 0.5
          ? text.slice(0, at)
          : text.slice(0, at) + junk[Math.floor(random() * junk.length)] + text.slice(at)
      const r = parseProto(mutated)
      if (r.error) {
        errors++
        // decision 14 (phase D): a partial AST of the statements that end before the error
        expect(r.ast.statements.every((s) => s.end <= (r.error?.offset ?? 0))).toBe(true)
        expect(r.issues.map((i) => i.code)).toEqual(["syntax"])
        expect(r.error.offset).toBeGreaterThanOrEqual(0)
        expect(r.error.offset).toBeLessThanOrEqual(mutated.length)
      }
    }
    expect(errors).toBeGreaterThan(100)
  })

  test("deep nesting does not throw", () => {
    const depth = 20000
    const text = `${"message A { ".repeat(depth)}${"} ".repeat(depth)}`
    const r = parseProto(text)
    expect(r.error === undefined || typeof r.error.message === "string").toBe(true)
  })
})

describe("other entry points", () => {
  test("parseConstant", () => {
    expect(parseConstant("1").ast?.type).toBe("signed-int-lit")
    expect(parseConstant(" -inf ").ast?.type).toBe("signed-float-lit")
    expect(parseConstant('{ a: 1 b: "x" }').ast?.type).toBe("aggregate")
    const bad = parseConstant("1 2")
    expect(bad.ast).toBeUndefined()
    expect(bad.error?.offset).toBe(2)
  })

  test("parseTextprotoMessage", () => {
    const r = parseTextprotoMessage('a: 1 # c\nb { c: "d" } e: [1, 2] f: -0x10')
    expect(r.error).toBeUndefined()
    expect(r.ast.statements.map((s) => s.type)).toEqual([
      "textproto-field",
      "textproto-field",
      "textproto-field",
      "textproto-field",
    ])
    expect(r.comments.map((c) => c.text)).toEqual(["# c\n"])
    const bad = parseTextprotoMessage("a: 1 }")
    expect(bad.error?.offset).toBe(5)
    expect(bad.ast.statements).toEqual([])
  })
})
