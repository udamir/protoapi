/**
 * `.proto` parser: a strict TypeScript port of pbkit 0.0.72's `core/parser` + `core/ast` (MIT OR Apache-2.0, see ./NOTICE), extended for editions 2023 / 2024 and with buf 1.75's comment attachment.
 */
import type { BuildIssue } from "../types.ts"
import type * as ast from "./ast/index.ts"
import { createLineIndex } from "./position.ts"
import { type Comment, type ParseError, parse, parseConstant } from "./proto.ts"
import { parseTextprotoMessage } from "./textproto.ts"

export type * from "./ast/index.ts"
export type { Comment as ProtoComment, ParseError, ParseResult, ProtoParser } from "./proto.ts"
export type { TextprotoParseResult } from "./textproto.ts"
export type { LineIndex, Position } from "./position.ts"
export type { Span, Token } from "./scanner.ts"
export { createLineIndex } from "./position.ts"
export { decodeBytesLit, decodeStrLit, decodeUtf8, parseFloatLit, parseIntLit } from "./literals.ts"
export { parseConstant, parseTextprotoMessage }

export interface ParseProtoResult {
  /**
   * The file's statements. With a syntax error: the complete top-level statements that end before it (a partial AST; the builders still take no declarations from such a file).
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
 * Parses `.proto` source text. `path` names the file in the issues (default `"input.proto"`); columns use buf's tab stop of 4, like the builders' default `tabWidth`. Never throws on bad input; throws a TypeError when `text` is not a string.
 */
export function parseProto(text: string, path = "input.proto"): ParseProtoResult {
  if (typeof text !== "string" || typeof path !== "string") throw new TypeError("parseProto: text and path are strings")
  return parseProtoSource(text, path, { tabWidth: 4 })
}

export interface ParseProtoSourceOptions {
  /** Tab stop of the syntax issue's columns (the builders' `tabWidth`). */
  tabWidth: number
}

/** `parseProto` without the argument checks and with the columns of the syntax issue counted with `options.tabWidth`: the text front end's entry point. */
export function parseProtoSource(text: string, path: string, options: ParseProtoSourceOptions): ParseProtoResult {
  const { ast, comments, error, partial } = parse(text)
  const result: ParseProtoResult = { ast, comments: comments as Comment[], issues: [] }
  if (error) {
    result.ast = { statements: partial ?? [] }
    result.error = error
    const lines = createLineIndex(text, { tabWidth: options.tabWidth })
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
