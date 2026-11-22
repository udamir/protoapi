/**
 * Origin: pbkit 0.0.72, `core/parser/textproto.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./LICENSE-MIT, ./LICENSE-APACHE).
 *
 * Modifications:
 * - strict TypeScript port; comments are recorded with `parser.addComment` instead of a "comment" event.
 * - sticky patterns (see recursive-descent-parser.ts); comment patterns use `[\s\S]` / `[^\n]` so that a lone `\r`,
 *   U+2028 or U+2029 inside a comment no longer breaks the comment token.
 * - hexadecimal integers (`0x1F`, `-0x10`) are parsed as `textproto-signed-hex-lit` (pbkit had a TODO and parsed
 *   `0x10` as the decimal `0` followed by a field named `x10`); `inf` / `nan` stay identifiers as in text format.
 * - string literals accept `\u` / `\U` escapes and 1-2 digit `\x` / `\X` escapes (shared pattern with proto.ts); escape
 *   letters are case-sensitive as in protoc (pbkit's `i` flag also accepted e.g. `\N`). Patterns use explicit
 *   character classes instead of the `i` flag.
 * - `parseTextprotoMessage` never throws: it returns `error` and requires the whole input to be consumed.
 */
import type * as ast from "./ast/textproto"
import type { MultilineComment, SinglelineComment } from "./ast/lexical-elements"
import { acceptPatternAndThen, choice, many, mergeSpans, skipTrivia } from "./misc"
import type { AcceptFn } from "./misc"
import {
  type RecursiveDescentParser,
  type Token,
  createRecursiveDescentParser,
  eof,
  namePattern,
  ParserSyntaxError,
  TokenSyntaxError,
} from "./recursive-descent-parser"

type Comment = ast.TextprotoComment | SinglelineComment | MultilineComment

export type TextprotoParser = RecursiveDescentParser<Comment>

export interface TextprotoParseResult {
  ast: ast.Textproto
  comments: Comment[]
  error?: ParserSyntaxError
}

export function parseTextprotoMessage(text: string): TextprotoParseResult {
  const parser: TextprotoParser = createRecursiveDescentParser<Comment>(text)
  try {
    const statements = acceptTextprotoStatements(parser)
    skipWsAndTextprotoComments(parser)
    parser.expect(eof)
    return { ast: { statements }, comments: parser.comments }
  } catch (err) {
    if (err instanceof ParserSyntaxError) return { ast: { statements: [] }, comments: parser.comments, error: err }
    throw err
  }
}

export function acceptTextprotoStatements(parser: TextprotoParser): ast.Textproto["statements"] {
  return many(
    parser,
    choice<ast.TextprotoMessageStatement, TextprotoParser>([
      skipWsAndTextprotoComments,
      acceptTextprotoField,
      acceptTextprotoSemi,
      acceptTextprotoComma,
    ]),
  )
}

export function skipWsAndTextprotoComments(parser: TextprotoParser): undefined {
  skipTrivia(parser, true)
}

function acceptTextprotoField(parser: TextprotoParser): ast.TextprotoField | undefined {
  const fieldName = acceptTextprotoFieldName(parser)
  if (!fieldName) return
  skipWsAndTextprotoComments(parser)
  const colon = parser.accept(":")
  skipWsAndTextprotoComments(parser)
  const value = expectTextprotoFieldValue(parser)
  const semiOrComma = acceptTextprotoSemiOrComma(parser)
  return {
    ...mergeSpans([fieldName, value, semiOrComma]),
    type: "textproto-field",
    fieldName,
    colon,
    value,
    semiOrComma,
  }
}

function expectTextprotoFieldValue(parser: TextprotoParser): ast.TextprotoField["value"] {
  const value = acceptTextprotoFieldValue(parser)
  if (!value) {
    throw new ParserSyntaxError(parser, [
      "[",
      "{",
      "<",
      identPattern,
      strLitPattern,
      "-",
      hexLitPattern,
      octLitPattern,
      decLitPattern,
      floatLitPattern,
    ])
  }
  return value
}

function acceptTextprotoListValue(parser: TextprotoParser): ast.TextprotoListValue | undefined {
  const bracketOpen = parser.accept("[")
  if (!bracketOpen) return
  const valueOrCommas = many(
    parser,
    choice<ast.TextprotoListValue["valueOrCommas"][number], TextprotoParser>([
      skipWsAndTextprotoComments,
      acceptTextprotoMessageValue,
      acceptTextprotoScalarValue,
      acceptTextprotoComma,
    ]),
  )
  const bracketClose = parser.expect("]")
  return {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "textproto-list-value",
    bracketOpen,
    valueOrCommas,
    bracketClose,
  }
}

const messageOpenPattern = /[{<]/y

function acceptTextprotoMessageValue(parser: TextprotoParser): ast.TextprotoMessageValue | undefined {
  const bracketOpen = parser.accept(messageOpenPattern)
  if (!bracketOpen) return
  const statements = acceptTextprotoStatements(parser)
  const bracketClose = bracketOpen.text === "{" ? parser.expect("}") : parser.expect(">")
  return {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "textproto-message-value",
    bracketOpen,
    statements,
    bracketClose,
  }
}

function acceptTextprotoFieldName(parser: TextprotoParser): ast.TextprotoFieldName | undefined {
  const ident = acceptTextprotoIdent(parser)
  if (ident) return ident
  const bracketOpen = parser.accept("[")
  if (!bracketOpen) return
  skipWsAndTextprotoComments(parser)
  const fullIdent1 = expectTextprotoFullIdent(parser)
  skipWsAndTextprotoComments(parser)
  if (parser.try("/")) {
    const slash = parser.expect("/")
    skipWsAndTextprotoComments(parser)
    const fullIdent2 = expectTextprotoFullIdent(parser)
    skipWsAndTextprotoComments(parser)
    const bracketClose = parser.expect("]")
    return {
      ...mergeSpans([bracketOpen, bracketClose]),
      type: "textproto-any-name",
      bracketOpen,
      domain: fullIdent1,
      slash,
      typeName: fullIdent2,
      bracketClose,
    }
  }
  const bracketClose = parser.expect("]")
  return {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "textproto-extension-name",
    bracketOpen,
    typeName: fullIdent1,
    bracketClose,
  }
}

function acceptTextprotoFullIdent(parser: TextprotoParser): ast.TextprotoFullIdent | undefined {
  const identOrDots = many(
    parser,
    choice<ast.TextprotoIdent | ast.TextprotoDot, TextprotoParser>([acceptTextprotoDot, acceptTextprotoIdent]),
  )
  if (identOrDots.length < 1) return
  return {
    ...mergeSpans(identOrDots),
    type: "textproto-full-ident",
    identOrDots,
  }
}

function expectTextprotoFullIdent(parser: TextprotoParser): ast.TextprotoFullIdent {
  const fullIdent = acceptTextprotoFullIdent(parser)
  if (fullIdent) return fullIdent
  throw new ParserSyntaxError(parser, [".", identPattern])
}

const identPattern = namePattern(/[A-Za-z_][A-Za-z0-9_]*/y, "identifier")
const acceptTextprotoIdent = acceptPatternAndThen<ast.TextprotoIdent>(identPattern, (ident) => ({
  type: "textproto-ident",
  ...ident,
}))
const floatLitPattern = namePattern(
  /[0-9]+[fF]|(?:[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?|[0-9]+[eE][-+]?[0-9]+|\.[0-9]+(?:[eE][-+]?[0-9]+)?)[fF]?/y,
  "float literal",
)
const acceptTextprotoFloatLit = acceptPatternAndThen<ast.TextprotoFloatLit>(floatLitPattern, (float) => ({
  type: "textproto-float-lit",
  ...float,
}))
const hexLitPattern = namePattern(/0[xX][0-9a-fA-F]+/y, "hexadecimal literal")
const acceptTextprotoHexLit = acceptPatternAndThen<ast.TextprotoHexLit>(hexLitPattern, (hex) => ({
  type: "textproto-hex-lit",
  ...hex,
}))
const octLitPattern = namePattern(/0[0-7]+/y, "octal literal")
const acceptTextprotoOctLit = acceptPatternAndThen<ast.TextprotoOctLit>(octLitPattern, (oct) => ({
  type: "textproto-oct-lit",
  ...oct,
}))
const decLitPattern = namePattern(/0(?=$|[^0-9])|[1-9][0-9]*/y, "decimal literal")
const acceptTextprotoDecLit = acceptPatternAndThen<ast.TextprotoDecLit>(decLitPattern, (dec) => ({
  type: "textproto-dec-lit",
  ...dec,
}))

/**
 * Protobuf string literal token (shared with proto.ts). Escapes: `\a \b \f \n \r \t \v \\ \? \' \"`, octal `\N`..`\NNN`,
 * hex `\xH` / `\xHH` (also `\X`), `\uXXXX`, `\UXXXXXXXX`. Raw NUL and newline are not allowed inside the quotes.
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
function stringLiteralError(parser: RecursiveDescentParser<Token>, offset: number, message: string): ParserSyntaxError {
  const loc = parser.loc
  parser.loc = offset
  const error = new TokenSyntaxError(parser, [strLitPattern], message)
  parser.loc = loc
  return error
}

/**
 * Scans one string literal token at the current position (the grammar of `strLitPattern`) without a regular
 * expression: a per-character alternation hits the regex engine's backtracking limit on literals of about a million
 * characters (validation text#15). Returns `undefined` when the input does not start with a quote. A literal that
 * starts but is malformed throws: an invalid escape at its backslash ("invalid escape sequence", as buf), a raw
 * newline / NUL or the end of the input at the opening quote ("unterminated string literal").
 */
export function acceptStrLitToken(parser: RecursiveDescentParser<Token>): Token | undefined {
  const input = parser.input
  const start = parser.loc
  const quote = input.charCodeAt(start)
  if (quote !== 34 && quote !== 39) return
  let i = start + 1
  while (true) {
    if (i >= input.length) throw stringLiteralError(parser, start, "unterminated string literal")
    const c = input.charCodeAt(i)
    if (c === quote) break
    if (c === 10 || c === 0) throw stringLiteralError(parser, start, "unterminated string literal")
    if (c !== 92) {
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
      // \uXXXX, \UXXXXXXXX
      const digits = n === 117 ? 4 : 8
      for (let k = 0; k < digits; k++)
        if (!isHex(input.charCodeAt(i + 2 + k))) throw stringLiteralError(parser, i, "invalid escape sequence")
      i += 2 + digits
    } else throw stringLiteralError(parser, i, "invalid escape sequence")
  }
  const end = i + 1
  parser.loc = end
  return { start, end, text: input.slice(start, end) }
}

function acceptTextprotoStrLit(parser: TextprotoParser): ast.TextprotoStrLit | undefined {
  const strLit = acceptStrLitToken(parser)
  if (!strLit) return
  const tokens: Token[] = [strLit]
  while (true) {
    skipWsAndTextprotoComments(parser)
    const strLit = acceptStrLitToken(parser)
    if (!strLit) break
    tokens.push(strLit)
  }
  return { ...mergeSpans(tokens), type: "textproto-str-lit", tokens }
}

const acceptTextprotoSemi = acceptPatternAndThen<ast.TextprotoSemi>(";", (semi) => ({
  type: "textproto-semi",
  ...semi,
}))
const acceptTextprotoComma = acceptPatternAndThen<ast.TextprotoComma>(",", (comma) => ({
  type: "textproto-comma",
  ...comma,
}))
const acceptTextprotoDot = acceptPatternAndThen<ast.TextprotoDot>(".", (dot) => ({
  type: "textproto-dot",
  ...dot,
}))
const acceptTextprotoSemiOrComma = choice<ast.TextprotoSemi | ast.TextprotoComma, TextprotoParser>([
  acceptTextprotoSemi,
  acceptTextprotoComma,
])

function signed<TValue extends Token, TType extends string>(
  acceptFn: AcceptFn<TValue>,
  type: TType,
): AcceptFn<{ start: number; end: number; type: TType; sign?: Token; value: TValue }> {
  return function accept(parser) {
    const loc = parser.loc
    const sign = parser.accept("-")
    const value = acceptFn(parser)
    if (!value) {
      parser.loc = loc
      return
    }
    return { ...mergeSpans([sign, value]), type, sign, value }
  }
}

const acceptTextprotoSignedIdent = signed(acceptTextprotoIdent, "textproto-signed-ident")
const acceptTextprotoSignedFloatLit = signed(acceptTextprotoFloatLit, "textproto-signed-float-lit")
const acceptTextprotoSignedHexLit = signed(acceptTextprotoHexLit, "textproto-signed-hex-lit")
const acceptTextprotoSignedOctLit = signed(acceptTextprotoOctLit, "textproto-signed-oct-lit")
const acceptTextprotoSignedDecLit = signed(acceptTextprotoDecLit, "textproto-signed-dec-lit")

const acceptTextprotoScalarValue = choice<ast.TextprotoScalarValue, TextprotoParser>([
  acceptTextprotoStrLit,
  acceptTextprotoSignedIdent,
  acceptTextprotoSignedFloatLit,
  acceptTextprotoSignedHexLit,
  acceptTextprotoSignedOctLit,
  acceptTextprotoSignedDecLit,
])

const acceptTextprotoFieldValue = choice<ast.TextprotoField["value"], TextprotoParser>([
  skipWsAndTextprotoComments,
  acceptTextprotoListValue,
  acceptTextprotoMessageValue,
  acceptTextprotoScalarValue,
])
