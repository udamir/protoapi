import { describe, expect, test } from "bun:test"
import { createLineIndex } from "../../src/parser"
import { as, parseOk } from "./helpers"

describe("createLineIndex", () => {
  test("multi-line text, zero-based lines and columns", () => {
    const text = "ab\ncde\n\nf"
    const index = createLineIndex(text)
    expect(index.lineCount).toBe(4)
    const at = (o: number) => index.toPosition(o)
    expect(at(0)).toEqual({ line: 0, column: 0 })
    expect(at(2)).toEqual({ line: 0, column: 2 }) // the "\n" itself ends line 0
    expect(at(3)).toEqual({ line: 1, column: 0 })
    expect(at(5)).toEqual({ line: 1, column: 2 })
    expect(at(7)).toEqual({ line: 2, column: 0 }) // empty line
    expect(at(8)).toEqual({ line: 3, column: 0 })
    expect(at(9)).toEqual({ line: 3, column: 1 }) // end of input
  })

  test("clamps out-of-range offsets", () => {
    const index = createLineIndex("a\nb")
    expect(index.toPosition(-5)).toEqual({ line: 0, column: 0 })
    expect(index.toPosition(100)).toEqual({ line: 1, column: 1 })
  })

  test("empty text and a trailing newline", () => {
    expect(createLineIndex("").toPosition(0)).toEqual({ line: 0, column: 0 })
    const index = createLineIndex("a\n")
    expect(index.lineCount).toBe(2)
    expect(index.toPosition(2)).toEqual({ line: 1, column: 0 })
  })

  test("CRLF: lines split on \\n, \\r is a column character", () => {
    const text = "a\r\nbc\r\n"
    const index = createLineIndex(text)
    expect(index.toPosition(1)).toEqual({ line: 0, column: 1 }) // "\r"
    expect(index.toPosition(2)).toEqual({ line: 0, column: 2 }) // "\n"
    expect(index.toPosition(3)).toEqual({ line: 1, column: 0 }) // "b"
    expect(index.toPosition(5)).toEqual({ line: 1, column: 2 }) // "\r"
    expect(index.toPosition(7)).toEqual({ line: 2, column: 0 })
  })

  test("a lone \\r does not start a line", () => {
    expect(createLineIndex("a\rb").toPosition(2)).toEqual({ line: 0, column: 2 })
  })

  test("UTF-16 code units: surrogate pairs count as two columns", () => {
    const text = '// \u{1F600} smile\nmessage A { string s = 1 [default = "\u{1F600}é"]; } // é\u{1F600}x'
    const r = parseOk(text)
    const index = createLineIndex(text)
    const message = as(r.ast.statements[0], "message")
    expect(index.toPosition(message.keyword.start)).toEqual({ line: 1, column: 0 })
    const field = as(message.messageBody.statements[0], "field")
    expect(index.toPosition(field.fieldName.start)).toEqual({ line: 1, column: 19 })
    const bracketClose = field.fieldOptions?.bracketClose
    // `[default = "` is 12 code units from column 25, the emoji takes 2, `é` 1, `"` 1
    expect(index.toPosition(bracketClose?.start ?? -1)).toEqual({ line: 1, column: 25 + 12 + 2 + 1 + 1 })
    const last = r.comments[r.comments.length - 1]
    expect(index.toPosition(last.end)).toEqual({ line: 1, column: text.length - text.indexOf("\n") - 1 })
    const x = text.lastIndexOf("x")
    expect(index.toPosition(x).column - index.toPosition(text.lastIndexOf("é")).column).toBe(3)
  })

  test("large input: positions agree with a naive scan", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `${"x".repeat(i % 37)}\r`)
    const text = lines.join("\n")
    const index = createLineIndex(text)
    let line = 0
    let column = 0
    let mismatches = 0
    for (let o = 0; o <= text.length; o++) {
      const p = index.toPosition(o)
      if (p.line !== line || p.column !== column) mismatches++
      if (text[o] === "\n") {
        line++
        column = 0
      } else column++
    }
    expect(mismatches).toBe(0)
  })
})
