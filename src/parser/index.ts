/**
 * `.proto` parser: a strict TypeScript port of pbkit 0.0.72's `core/parser` + `core/ast` (MIT OR Apache-2.0, see ./NOTICE), extended for editions 2023 / 2024 and with buf 1.75's comment attachment.
 */
import type { BuildIssue } from "../types"
import type * as ast from "./ast/index"
import { createLineIndex } from "./position"
import { type Comment, type ParseError, parse, parseConstant } from "./proto"
import { parseTextprotoMessage } from "./textproto"

export type * from "./ast/index"
export type { Comment as ProtoComment, ParseError, ParseResult, ProtoParser } from "./proto"
export type { TextprotoParseResult } from "./textproto"
export type { LineIndex, Position } from "./position"
export type { Span, Token } from "./recursive-descent-parser"
export { createLineIndex } from "./position"
export { decodeBytesLit, decodeStrLit, decodeUtf8, parseFloatLit, parseIntLit } from "./literals"
export { parseConstant, parseTextprotoMessage }

export interface ParseProtoResult {
  /**
   * The file's statements. With a syntax error: the complete top-level statements that end before it (a partial
   * AST; the builders still take no declarations from such a file, design EX-DIAG-3).
   */
  ast: ast.Proto
  /**
   * Every comment in the file, in source order, each once: `//` and `/* *\/` comments, plus `#` comments inside
   * aggregate option values (`ast.TextprotoComment`), which protoc itself rejects.
   */
  comments: (ast.Comment | ast.TextprotoComment)[]
  /** The syntax error as a build issue (`code: "syntax"`), located like the builders locate it; empty without one. */
  issues: BuildIssue[]
  /** The first syntax error in parser form; `offset` is the string index of the unexpected token. */
  error?: ParseError
}

/**
 * Parses `.proto` source text (design §4.3, validation decision 14). `path` names the file in the issues (default
 * `"input.proto"`); columns use buf's tab stop of 4, like the builders' default `tabWidth`. Never throws on bad
 * input; throws a TypeError when `text` is not a string.
 */
export function parseProto(text: string, path = "input.proto"): ParseProtoResult {
  if (typeof text !== "string" || typeof path !== "string") throw new TypeError("parseProto: text and path are strings")
  const { ast, comments, error, partial } = parse(text)
  const result: ParseProtoResult = { ast, comments: comments as Comment[], issues: [] }
  if (error) {
    result.ast = { statements: partial ?? [] }
    result.error = error
    const lines = createLineIndex(text, { tabWidth: 4 })
    const at = lines.toPosition(error.offset)
    result.issues.push({
      code: "syntax",
      message: error.message,
      file: path,
      location: { file: path, start: at, end: at },
    })
  }
  return result
}
