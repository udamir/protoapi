/**
 * Origin: pbkit 0.0.72, `core/parser/misc.{js,d.ts}`, `core/parser/proto.{js,d.ts}` and `core/parser/textproto.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0, used here under MIT (see ./LICENSE-MIT).
 *
 * Tokens shared by the `.proto` and text-format grammars: character codes, identifiers, keywords, string literals, whitespace and comments.
 *
 * Modifications:
 * - collected from misc.ts (`acceptSpecialToken`, the comment patterns, `skipTrivia`), proto.ts (`keywordPattern`, `acceptKeyword`) and textproto.ts (`strLitPattern`, `acceptStrLitToken`); the identifier pattern, defined in each of those three files before, is defined once here, and raw character codes are named constants.
 * - sticky regular expressions compiled once (see scanner.ts); comment patterns use `[\s\S]` / `[^\n]` so that a lone `\r`, U+2028 or U+2029 inside a comment no longer breaks the comment token.
 * - keywords require a word boundary (pbkit matched `message` in `messageType`) and are pre-checked by their first letter.
 * - string literals accept `\u` / `\U` escapes and 1-2 digit `\x` / `\X` escapes; other escape letters are case-sensitive (protoc). A `\u` / `\U` escape must be a Unicode scalar value: a surrogate (even a high + low pair, which protoc combines) or a code point above U+10FFFF is an invalid escape (buf). They are scanned without a regular expression, and a malformed literal throws a `TokenSyntaxError`.
 * - `skipTrivia` is one loop over whitespace and comments for both grammars (`#` comments only with `hash`, for text format) and reports whether it skipped a newline.
 */
import type { Keyword } from "./ast/index.ts"
import type { AnyParser } from "./combinators.ts"
import { type Pattern, type RecursiveDescentParser, type Token, namePattern, TokenSyntaxError } from "./scanner.ts"

// ---- character codes (`charCodeAt`) ---------------------------------------------------------------------------------

export const TAB = 9
export const NEWLINE = 10
export const VERTICAL_TAB = 11
export const FORM_FEED = 12
export const CARRIAGE_RETURN = 13
export const SPACE = 32
export const DOUBLE_QUOTE = 34
export const HASH = 35
export const SINGLE_QUOTE = 39
export const CLOSE_PAREN = 41
export const SLASH = 47
export const EQUALS = 61
export const OPEN_BRACKET = 91
export const BACKSLASH = 92
export const CLOSE_BRACKET = 93
export const LOWER_A = 97
export const OPEN_BRACE = 123
export const CLOSE_BRACE = 125

// ---- identifiers and keywords ---------------------------------------------------------------------------------------

export const identPattern = namePattern(/[A-Za-z_][A-Za-z0-9_]*/y, "identifier")

export function acceptSpecialToken<TType extends string>(
  parser: AnyParser,
  type: TType,
  pattern: Pattern = identPattern,
): (Token & { type: TType }) | undefined {
  const token = parser.accept(pattern)
  if (!token) return
  return { type, ...token }
}

/** Bit mask of the first letters (`a`..`z`) of a keyword pattern's alternatives, checked before running it. */
const keywordFirstLetters = new WeakMap<RegExp, number>()

/** `keyword\b` (or `(?:a|b)\b`) as a sticky pattern. */
export function keywordPattern(...keywords: string[]): RegExp {
  const source = keywords.length === 1 ? keywords[0] : `(?:${keywords.join("|")})`
  const pattern = namePattern(new RegExp(`${source}\\b`, "y"), keywords.map((k) => JSON.stringify(k)).join(" or "))
  let mask = 0
  for (const keyword of keywords) mask |= 1 << (keyword.charCodeAt(0) - LOWER_A)
  keywordFirstLetters.set(pattern, mask)
  return pattern
}

export function acceptKeyword(parser: AnyParser, pattern: Pattern = identPattern): Keyword | undefined {
  const firstLetters = typeof pattern === "object" ? keywordFirstLetters.get(pattern) : undefined
  if (firstLetters !== undefined) {
    const letter = parser.input.charCodeAt(parser.loc) - LOWER_A
    if (!(letter >= 0 && letter < 26 && firstLetters & (1 << letter))) return
  }
  return acceptSpecialToken(parser, "keyword", pattern)
}

// ---- string literals ------------------------------------------------------------------------------------------------

/**
 * Protobuf string literal token (shared with proto.ts). Escapes: `\a \b \f \n \r \t \v \\ \? \' \"`, octal `\N`..`\NNN`, hex `\xH` / `\xHH` (also `\X`), `\uXXXX`, `\UXXXXXXXX`. Raw NUL and newline are not allowed inside the quotes. The pattern only names the token in errors: `acceptStrLitToken` scans it, and also rejects surrogate and out-of-range `\u` / `\U` escapes.
 */
export const strLitPattern = namePattern(
  /'(?:\\[xX][0-9a-fA-F]{1,2}|\\[0-7]{1,3}|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\[abfnrtv\\?'"]|[^'\0\n\\])*'|"(?:\\[xX][0-9a-fA-F]{1,2}|\\[0-7]{1,3}|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\[abfnrtv\\?'"]|[^"\0\n\\])*"/y,
  "string literal",
)

const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
const isOctal = (c: number) => c >= 48 && c <= 55
/** `\a \b \f \n \r \t \v \\ \? \' \"` */
const SIMPLE_ESCAPES = new Set([97, 98, 102, 110, 114, 116, 118, 92, 63, 39, 34])

/** A malformed string literal: the error is located at `offset` (the bad escape, or the opening quote). */
function stringLiteralError(parser: RecursiveDescentParser<Token>, offset: number, message: string): TokenSyntaxError {
  const loc = parser.loc
  parser.loc = offset
  const error = new TokenSyntaxError(parser, [strLitPattern], message)
  parser.loc = loc
  return error
}

/**
 * Scans one string literal token at the current position (the grammar of `strLitPattern`) without a regular expression: a per-character alternation hits the regex engine's backtracking limit on literals of about a million characters. Returns `undefined` when the input does not start with a quote. A literal that starts but is malformed throws: an invalid escape at its backslash ("invalid escape sequence", as buf; this includes a surrogate or out-of-range `\u` / `\U` escape), a raw newline / NUL or the end of the input at the opening quote ("unterminated string literal").
 */
export function acceptStrLitToken(parser: RecursiveDescentParser<Token>): Token | undefined {
  const input = parser.input
  const start = parser.loc
  const quote = input.charCodeAt(start)
  if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) return
  let i = start + 1
  while (true) {
    if (i >= input.length) throw stringLiteralError(parser, start, "unterminated string literal")
    const c = input.charCodeAt(i)
    if (c === quote) break
    if (c === NEWLINE || c === 0) throw stringLiteralError(parser, start, "unterminated string literal")
    if (c !== BACKSLASH) {
      i++
      continue
    }
    const n = input.charCodeAt(i + 1)
    if (SIMPLE_ESCAPES.has(n)) i += 2
    else if (n === 120 || n === 88) {
      // \xH or \xHH
      if (!isHex(input.charCodeAt(i + 2))) throw stringLiteralError(parser, i, "invalid escape sequence")
      i += isHex(input.charCodeAt(i + 3)) ? 4 : 3
    } else if (isOctal(n)) {
      i += 2
      if (isOctal(input.charCodeAt(i))) i++
      if (isOctal(input.charCodeAt(i))) i++
    } else if (n === 117 || n === 85) {
      // \uXXXX, \UXXXXXXXX: a Unicode scalar value (buf rejects every surrogate, even a high + low pair that protoc combines)
      const digits = n === 117 ? 4 : 8
      let cp = 0
      for (let k = 0; k < digits; k++) {
        const h = input.charCodeAt(i + 2 + k)
        if (!isHex(h)) throw stringLiteralError(parser, i, "invalid escape sequence")
        cp = cp * 16 + (h <= 57 ? h - 48 : (h | 32) - 87)
      }
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
        throw stringLiteralError(parser, i, "invalid escape sequence")
      i += 2 + digits
    } else throw stringLiteralError(parser, i, "invalid escape sequence")
  }
  const end = i + 1
  parser.loc = end
  return { start, end, text: input.slice(start, end) }
}

// ---- whitespace and comments ----------------------------------------------------------------------------------------

export const multilineCommentPattern = /\/\*[\s\S]*?\*\//y
export const singlelineCommentPattern = /\/\/[^\n]*(?:\n|$)/y
const whitespacePattern = /\s+/y
const textprotoCommentPattern = /#[^\n]*(?:\n|$)/y

/** Skips whitespace and comments, recording the comments; `#` comments too with `hash` (text format). Returns whether a newline or a `//` comment was skipped. */
export function skipTrivia(parser: AnyParser, hash?: boolean): boolean {
  const input = parser.input
  let newline = false
  while (true) {
    const c = input.charCodeAt(parser.loc)
    // fast path: neither whitespace nor a comment start
    if (c !== SLASH && !(hash && c === HASH) && !(c <= SPACE || c >= 0x80)) break
    const whitespace = parser.accept(whitespacePattern)
    if (whitespace) {
      newline ||= whitespace.text.includes("\n")
      continue
    }
    const comment =
      acceptSpecialToken(parser, "multiline-comment", multilineCommentPattern) ??
      acceptSpecialToken(parser, "singleline-comment", singlelineCommentPattern) ??
      (hash ? acceptSpecialToken(parser, "textproto-comment", textprotoCommentPattern) : undefined)
    if (!comment) break
    parser.addComment(comment)
    newline ||= comment.type === "singleline-comment"
  }
  return newline
}
