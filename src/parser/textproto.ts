/**
 * Origin: pbkit 0.0.72, `core/parser/textproto.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0, used here under MIT (see ./LICENSE-MIT).
 *
 * Modifications:
 * - strict TypeScript port; comments are recorded with `parser.addComment` instead of a "comment" event.
 * - sticky patterns (see scanner.ts); comment patterns use `[\s\S]` / `[^\n]` so that a lone `\r`,
 *   U+2028 or U+2029 inside a comment no longer breaks the comment token.
 * - hexadecimal integers (`0x1F`, `-0x10`) are parsed as `textproto-signed-hex-lit` (pbkit had a TODO and parsed
 *   `0x10` as the decimal `0` followed by a field named `x10`); `inf` / `nan` stay identifiers as in text format.
 * - string literals accept `\u` / `\U` escapes and 1-2 digit `\x` / `\X` escapes (shared pattern with proto.ts); escape
 *   letters are case-sensitive as in protoc (pbkit's `i` flag also accepted e.g. `\N`). Patterns use explicit
 *   character classes instead of the `i` flag.
 * - `parseTextprotoMessage` never throws: it returns `error` and requires the whole input to be consumed.
 * - the identifier pattern and the string literal scanner (`strLitPattern`, `acceptStrLitToken`) moved to lexer.ts, `signed` to combinators.ts (shared with proto.ts).
 */
import type * as ast from "./ast/textproto.ts"
import type { MultilineComment, SinglelineComment } from "./ast/lexical-elements.ts"
import { acceptPatternAndThen, choice, many, mergeSpans, signed } from "./combinators.ts"
import { acceptStrLitToken, identPattern, skipTrivia, strLitPattern } from "./lexer.ts"
import {
  type RecursiveDescentParser,
  type Token,
  createRecursiveDescentParser,
  eof,
  namePattern,
  ParserSyntaxError,
} from "./scanner.ts"

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

const MINUS = ["-"]

const acceptTextprotoSignedIdent = signed(acceptTextprotoIdent, "textproto-signed-ident", MINUS)
const acceptTextprotoSignedFloatLit = signed(acceptTextprotoFloatLit, "textproto-signed-float-lit", MINUS)
const acceptTextprotoSignedHexLit = signed(acceptTextprotoHexLit, "textproto-signed-hex-lit", MINUS)
const acceptTextprotoSignedOctLit = signed(acceptTextprotoOctLit, "textproto-signed-oct-lit", MINUS)
const acceptTextprotoSignedDecLit = signed(acceptTextprotoDecLit, "textproto-signed-dec-lit", MINUS)

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
