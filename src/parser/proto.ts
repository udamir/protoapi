/**
 * Origin: pbkit 0.0.72, `core/parser/proto.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./LICENSE-MIT, ./LICENSE-APACHE).
 *
 * Modifications:
 * - strict TypeScript port of the compiled `.js` + `.d.ts`; function names and AST node shapes are kept.
 * - comments are recorded in `parser.comments` (no event emitter); trailing comments are recorded too (pbkit did
 *   not emit them) and each comment appears once even when the parser backtracks over it.
 * - comment attachment re-implemented after buf 1.75 (protocompile experimental/fdp `commentTracker`, the code that fills buf's SourceCodeInfo): `sweepComments` replaces `skipWsAndSweepComments` / `acceptCommentGroup`, and `acceptTrailingComments` now sweeps everything up to the next token, returns the previous declaration's trailing group and stores the next declaration's leading / detached groups. Block statements take their trailing comment after `{` (pbkit: after `}`). See KNOWN_DEVIATIONS below.
 * - sticky regular expressions compiled once; keywords require a word boundary (pbkit matched `message` in
 *   `messageType`, `optional` in `optionalFoo`, `map` in `mapping`, `stream` in `streamX`, `inf` in `information`,
 *   `true` in `trueish`); `inf` / `nan` are lowercase only (protoc), so `INF` / `NAN` are identifiers.
 * - string literals accept `\u` / `\U` escapes and 1-2 digit `\x` / `\X` escapes; other escape letters are
 *   case-sensitive (protoc). Patterns use explicit character classes instead of the `i` flag.
 * - grammar additions: `export` / `local` before `message` / `enum` (`visibility`); `import option`; identifiers in
 *   `reserved` (editions); options on oneof groups; `map` not followed by `<` and `(stream)` are parsed as type names
 *   (protoc accepts the former); a `FullIdent` never ends with a dot (`features.(pb.cpp).x` now yields segments
 *   `features`, `.`, `(pb.cpp)`, `.`, `x`).
 * - `parse` / `parseConstant` never throw: they return `error` (with the offset of the unexpected token) and an
 *   empty AST; `parse` requires the whole input to be consumed (pbkit silently ignored trailing garbage) and turns a
 *   `malformed-field` (pbkit's error recovery) into an error. Non-syntax failures (a stack overflow on nesting deeper
 *   than ~10,000 levels) are reported the same way at the current position.
 *
 * KNOWN_DEVIATIONS (comment attachment). The rules implemented are buf 1.75's (protocompile experimental/fdp `commentTracker`, read from the revision buf 1.75.0 is built with, v0.14.2-0.20261020145055-56248e843b50), with buf 1.75.0 as the executable oracle: every leading / trailing / detached group of the bundled files, of every test fixture with a buf image and of a differential fuzz (scripts/comment-fuzz.ts; 2,000 random files, about 124,000 declarations, no layout excluded) equals buf's SourceCodeInfo. protoc (tokenizer.cc `NextWithComments`, parser.cc `TryConsumeEndOfDeclaration`) attaches differently in rare layouts: a block comment after a declaration's `;` or a block's `}` followed by a newline, or between `{` and `}` on one line; a block comment followed by a `//` comment on the declaration's line; a block comment that ends on the line of the next token; a group after a same-line trailing comment followed by a blank line; comments after the last token of the file; and which groups are detached around such block comments.
 * 1. Empty statements (`;`) are statements here and own the comments in front of them and their trailing comment, which are attached to nothing, as in buf; protoc drops their leading comment and carries their detached comments forward to the next declaration.
 * 2. `#` comments inside aggregate option values (`{ ... }`) are accepted and recorded (textproto syntax); protoc's .proto tokenizer rejects them.
 * 3. Not a deviation from buf or protoc, but from pbkit: a comment after a block's closing `}` is never a trailing comment, and detached comments right before a closing `}` are dropped (both remain in `comments`).
 */
import type * as ast from "./ast/index.ts"
import {
  acceptPatternAndThen,
  acceptSpecialToken,
  choice,
  flipFlop,
  many,
  mergeSpans,
  multilineCommentPattern,
  singlelineCommentPattern,
  skipTrivia,
} from "./misc.ts"
import {
  type Pattern,
  type RecursiveDescentParser,
  type Span,
  type Token,
  createRecursiveDescentParser,
  eof,
  namePattern,
  ParserSyntaxError,
  TokenSyntaxError,
} from "./recursive-descent-parser.ts"
import { acceptStrLitToken, acceptTextprotoStatements, strLitPattern } from "./textproto.ts"

/** Any comment the proto parser records: `//`, `/* *\/`, and `#` (only inside aggregate option values). */
export type Comment = ast.Comment | ast.TextprotoComment

export interface ParseError {
  message: string
  /** String index of the unexpected input. */
  offset: number
  /** Descriptions of what was expected at `offset` (a quoted literal, or a name such as `identifier`). */
  expected?: string[]
  /** The unexpected token text; absent at the end of the input. */
  found?: string
}

export interface ParseResult<T = ast.Proto> {
  ast: T
  parser: ProtoParser
  comments: Comment[]
  error?: ParseError
  /** With `error`: the complete top-level statements that end before the error, in source order. */
  partial?: ast.TopLevelStatement[]
}

interface PendingComments {
  leading: ast.CommentGroup[]
  detached: ast.CommentGroup[]
}

export interface ProtoParser extends RecursiveDescentParser<Comment> {
  /** Leading / detached comment groups swept after the last end of declaration, for the next statement. */
  upcoming: PendingComments | undefined
  /** First error behind a `malformed-field` node. */
  malformed: ParserSyntaxError | undefined
}

type StatementFn<T> = (
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
) => T | undefined

function createProtoParser(text: string): ProtoParser {
  const parser = createRecursiveDescentParser<Comment>(text) as ProtoParser
  parser.upcoming = undefined
  parser.malformed = undefined
  return parser
}

const topLevelStatementFns: StatementFn<ast.TopLevelStatement>[] = [
  acceptSyntax,
  acceptEdition,
  acceptImport,
  acceptPackage,
  acceptOption,
  acceptMessage,
  acceptEnum,
  acceptExtend,
  acceptService,
  acceptEmpty,
]

export function parse(text: string): ParseResult {
  const parser = createProtoParser(text)
  const statements: ast.TopLevelStatement[] = []
  try {
    const initial = sweepComments(parser, true)
    parser.upcoming = { leading: initial.leading, detached: [...initial.trailing, ...initial.detached] }
    acceptStatements(parser, topLevelStatementFns, statements)
    if (parser.malformed) throw parser.malformed
    parser.expect(eof, topLevelKeywords)
    return { ast: { statements }, parser, comments: parser.comments }
  } catch (err) {
    const error = toParseError(parser, err)
    // the complete top-level statements that end before the error (validation text#14)
    const partial = statements.filter((st) => st.end <= error.offset)
    return { ast: { statements: [] }, parser, comments: parser.comments, error, partial }
  }
}

export function parseConstant(text: string): ParseResult<ast.Constant | undefined> {
  const parser = createProtoParser(text)
  try {
    skipWsAndComments(parser)
    const constant = expectConstant(parser)
    skipWsAndComments(parser)
    parser.expect(eof)
    return { ast: constant, parser, comments: parser.comments }
  } catch (err) {
    return { ast: undefined, parser, comments: parser.comments, error: toParseError(parser, err) }
  }
}

function toParseError(parser: ProtoParser, err: unknown): ParseError {
  let syntaxError = err instanceof ParserSyntaxError ? err : undefined
  if (parser.malformed && (!syntaxError || parser.malformed.offset <= syntaxError.offset)) {
    syntaxError = parser.malformed
  }
  if (syntaxError) {
    const error: ParseError = {
      message: syntaxError.message,
      offset: syntaxError.offset,
      expected: syntaxError.expected,
    }
    if (syntaxError.got !== eof) error.found = syntaxError.got
    return error
  }
  // not a syntax error (e.g. stack overflow on absurdly deep nesting): report at the current position
  return { message: err instanceof Error ? err.message : String(err), offset: parser.loc }
}

type ComplexSequence<T> = { [K in keyof T]-?: [K, (parser: ProtoParser) => T[K]] }[keyof T][]

function acceptComplexSequence<T extends object>(
  parser: ProtoParser,
  expectFnSeq: ComplexSequence<T>,
  escapePattern?: Pattern,
): { partial: boolean; result: Partial<T>; error?: ParserSyntaxError } {
  const result: Partial<T> = {}
  let partial = false
  let hasNewline = false
  let error: ParserSyntaxError | undefined
  let recoveryPoint: { loc: number; result: Partial<T> } | undefined
  for (const [key, expectFn] of expectFnSeq) {
    const loc = parser.loc
    hasNewline = skipTrivia(parser)
    if (hasNewline && !recoveryPoint) {
      recoveryPoint = { loc: parser.loc, result: { ...result } }
    }
    try {
      result[key] = expectFn(parser)
    } catch (err) {
      if (!(err instanceof ParserSyntaxError) || err instanceof TokenSyntaxError) throw err
      error ??= err
      parser.loc = loc
      partial = true
      if (escapePattern && parser.try(escapePattern)) break
    }
  }
  if (partial && recoveryPoint) {
    parser.loc = recoveryPoint.loc
    return { partial, result: recoveryPoint.result, error }
  }
  return { partial, result, error }
}

function acceptStatements<T>(parser: ProtoParser, acceptStatementFns: StatementFn<T>[], statements: T[] = []): T[] {
  nextStatement: while (true) {
    const { leading: leadingComments, detached: leadingDetachedComments } = takeUpcomingComments(parser)
    const loc = parser.loc
    for (const acceptStatementFn of acceptStatementFns) {
      const statement = acceptStatementFn(parser, leadingComments, leadingDetachedComments)
      if (statement) {
        statements.push(statement)
        if (parser.loc === loc) break nextStatement
        continue nextStatement
      }
    }
    break
  }
  return statements
}

// pbkit's set plus `\r` (protoc treats `\r` as whitespace; `\r\n` was matched by the newline pattern before)
const whitespaceWithoutNewlinePattern =
  /[ \f\t\v\r\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+/uy
// (explicit character classes instead of the `i` flag: case-insensitive sticky matching is measurably slower)
const intLitPattern = namePattern(/0(?:[xX][0-9a-fA-F]+|[0-7]*)|[1-9][0-9]*/y, "integer literal")
const floatLitPattern = namePattern(
  /[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?|[0-9]+[eE][-+]?[0-9]+|\.[0-9]+(?:[eE][-+]?[0-9]+)?|inf\b|nan\b/y,
  "float literal",
)
const boolLitPattern = namePattern(/(?:true|false)\b/y, "boolean literal")
const identPattern = namePattern(/[A-Za-z_][A-Za-z0-9_]*/y, "identifier")
/** The next token (a word or one character) and the trivia after it, up to the token after the next one. */
const tokenAfterNext = /(?:\w+|[\s\S])(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*/y
const messageBodyStatementKeywordPattern = /(?:enum|message|extend|extensions|group|option|oneof|map|reserved)\b/y

/** Bit mask of the first letters (`a`..`z`) of a keyword pattern's alternatives, checked before running it. */
const keywordFirstLetters = new WeakMap<RegExp, number>()

/** `keyword\b` (or `(?:a|b)\b`) as a sticky pattern. */
function keywordPattern(...keywords: string[]): RegExp {
  const source = keywords.length === 1 ? keywords[0] : `(?:${keywords.join("|")})`
  const pattern = namePattern(new RegExp(`${source}\\b`, "y"), keywords.map((k) => JSON.stringify(k)).join(" or "))
  let mask = 0
  for (const keyword of keywords) mask |= 1 << (keyword.charCodeAt(0) - 97)
  keywordFirstLetters.set(pattern, mask)
  return pattern
}
const syntaxPattern = keywordPattern("syntax")
const editionPattern = keywordPattern("edition")
const importPattern = keywordPattern("import")
const importModifierPattern = keywordPattern("weak", "public", "option")
const packagePattern = keywordPattern("package")
const optionPattern = keywordPattern("option")
const enumPattern = keywordPattern("enum")
const messagePattern = keywordPattern("message")
const visibilityPattern = keywordPattern("export", "local")
const fieldLabelPattern = keywordPattern("required", "optional", "repeated")
const mapPattern = keywordPattern("map")
const oneofPattern = keywordPattern("oneof")
const toPattern = keywordPattern("to")
const maxPattern = keywordPattern("max")
const extensionsPattern = keywordPattern("extensions")
const reservedPattern = keywordPattern("reserved")
const extendPattern = keywordPattern("extend")
const groupPattern = keywordPattern("group")
const streamPattern = keywordPattern("stream")
const rpcPattern = keywordPattern("rpc")
const returnsPattern = keywordPattern("returns")
const servicePattern = keywordPattern("service")
const quotePattern = namePattern(/['"]/y, "quote")
const syntaxValuePattern = namePattern(/[^'"]+/y, "syntax value")

const topLevelKeywords: Pattern[] = [
  syntaxPattern,
  editionPattern,
  importPattern,
  packagePattern,
  optionPattern,
  messagePattern,
  enumPattern,
  extendPattern,
  servicePattern,
  ";",
]

const acceptDot = acceptPatternAndThen<ast.Dot>(".", (dot) => ({ type: "dot", ...dot }))
const acceptComma = acceptPatternAndThen<ast.Comma>(",", (comma) => ({ type: "comma", ...comma }))
const acceptSemi = acceptPatternAndThen<ast.Semi>(";", (semi) => ({ type: "semi", ...semi }))

function expectSemi(parser: ProtoParser): ast.Semi {
  const semi = acceptSemi(parser)
  if (semi) return semi
  throw new ParserSyntaxError(parser, [";"])
}

const acceptIdent = acceptPatternAndThen<ast.Ident>(identPattern, (ident) => ({ type: "ident", ...ident }))

function acceptKeyword(parser: ProtoParser, pattern: Pattern = identPattern): ast.Keyword | undefined {
  const firstLetters = typeof pattern === "object" ? keywordFirstLetters.get(pattern) : undefined
  if (firstLetters !== undefined) {
    const letter = parser.input.charCodeAt(parser.loc) - 97
    if (!(letter >= 0 && letter < 26 && firstLetters & (1 << letter))) return
  }
  return acceptSpecialToken(parser, "keyword", pattern)
}

function expectKeyword(parser: ProtoParser, pattern: Pattern = identPattern): ast.Keyword {
  const keyword = acceptKeyword(parser, pattern)
  if (keyword) return keyword
  throw new ParserSyntaxError(parser, [pattern])
}

/** A statement node: its span runs from the comments before it to its trailing comment; comment groups first. */
function statement<const T extends object>(
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
  trailingComments: ast.CommentGroup[],
  spans: (Span | undefined | (Span | undefined)[])[],
  node: T,
) {
  return {
    ...mergeSpans([leadingDetachedComments, leadingComments, ...spans, trailingComments]),
    leadingComments,
    trailingComments,
    leadingDetachedComments,
    ...node,
  }
}

function commentGroup(comments: ast.Comment[]): ast.CommentGroup {
  return { ...mergeSpans(comments), type: "comment-group", comments }
}

function countNewlines(text: string): number {
  let count = 0
  let i = text.indexOf("\n")
  while (i !== -1) {
    count++
    i = text.indexOf("\n", i + 1)
  }
  return count
}

interface SweptComments {
  /** Trailing comment group of the previous declaration (at most one). */
  trailing: ast.CommentGroup[]
  /** Detached comment groups of the next declaration. */
  detached: ast.CommentGroup[]
  /** Leading comment group of the next declaration (at most one). */
  leading: ast.CommentGroup[]
}

/**
 * Consumes whitespace and comments up to the next token and attributes them as buf 1.75 does (protocompile experimental/fdp `commentTracker`). `atStart`: there is no previous token (start of the input, or after error recovery).
 *
 * - A paragraph is a run of `//` lines without a blank line; a block comment, and a `//` comment on the line of the previous token, are paragraphs of their own.
 * - The first paragraph trails the previous token when a `//` comment on that token's line is among the paragraphs, or when it starts within one line of that token and is followed by another paragraph, a closing `}` / `]` / `)` or a blank line.
 * - The last remaining paragraph leads the next token when exactly one newline separates them.
 * - The others are detached from the first one that has a blank line between it and the previous token in its scope (none after `{` or at the start) and between it and the token after the next one (none at the end of a scope); otherwise none is.
 * - Comments at the end of the input are attributed to nothing.
 */
function sweepComments(parser: ProtoParser, atStart: boolean): SweptComments {
  const input = parser.input
  const start = parser.loc
  const groups: ast.CommentGroup[] = []
  let open: ast.Comment[] | undefined
  let sameLine = false
  const close = () => {
    if (open) groups.push(commentGroup(open))
    open = undefined
  }
  while (true) {
    const c = input.charCodeAt(parser.loc)
    if (c === 10) {
      // a newline after a `//` line (which ends with its own newline) is a blank line
      parser.loc++
      close()
    } else if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11 || c >= 0x80) {
      if (!parser.accept(whitespaceWithoutNewlinePattern)) break
    } else if (c !== 47) break
    else if (input.charCodeAt(parser.loc + 1) === 47) {
      const comment = acceptSpecialToken(parser, "singleline-comment", singlelineCommentPattern) as ast.Comment
      parser.addComment(comment)
      if (open) open.push(comment)
      else if (!atStart && !input.slice(start, comment.start).includes("\n")) {
        groups.push(commentGroup([comment]))
        sameLine = true
      } else open = [comment]
    } else {
      const comment = acceptSpecialToken(parser, "multiline-comment", multilineCommentPattern)
      if (!comment) break
      parser.addComment(comment)
      close()
      groups.push(commentGroup([comment]))
    }
  }
  close()
  const trailing: ast.CommentGroup[] = []
  const detached: ast.CommentGroup[] = []
  const leading: ast.CommentGroup[] = []
  const loc = parser.loc
  if (loc >= input.length) return { trailing, detached, leading }
  // newlines from the last character of the earlier token to the later one (protocompile `NewLinesBetween`)
  const nl = (end: number, to: number) => countNewlines(input.slice(end - 1, to))
  const closer = (x: number) => x === 125 /* } */ || x === 93 /* ] */ || x === 41 /* ) */
  const c = input.charCodeAt(loc)
  let first = 0
  let last = groups.length
  if (
    last &&
    !atStart &&
    (sameLine || (nl(start, groups[0].start) < 2 && (last > 1 || closer(c) || nl(groups[0].end, loc) > 1)))
  )
    trailing.push(groups[first++])
  if (first < last && nl(groups[last - 1].end, loc) === 1) leading.push(groups[--last])
  const hasPrev = !atStart && input.charCodeAt(start - 1) !== 123 /* { */
  for (let i = first; i < last; i++) {
    if (hasPrev && nl(start, groups[i].start) < 2) continue
    tokenAfterNext.lastIndex = loc
    tokenAfterNext.test(input)
    const next = tokenAfterNext.lastIndex
    if (!closer(c) && next < input.length && !closer(input.charCodeAt(next)) && nl(groups[i].end, next) > 1) {
      detached.push(...groups.slice(i, last))
      break
    }
  }
  return { trailing, detached, leading }
}

/** Leading / detached comments for the statement at the current position. */
function takeUpcomingComments(parser: ProtoParser): PendingComments {
  let upcoming = parser.upcoming
  if (!upcoming) {
    // the previous statement did not end with an end-of-declaration sweep (only after error recovery)
    const swept = sweepComments(parser, true)
    upcoming = { leading: swept.leading, detached: [...swept.trailing, ...swept.detached] }
  }
  parser.upcoming = undefined
  return upcoming
}

/**
 * Called right after a declaration's end token (`;`, `{` or `}`), like protoc's `TryConsumeEndOfDeclaration`:
 * sweeps the comments up to the next token, returns the trailing comment group of the declaration that just ended
 * and keeps the leading / detached groups for the next statement.
 */
function acceptTrailingComments(parser: ProtoParser): ast.CommentGroup[] {
  const { trailing, detached, leading } = sweepComments(parser, false)
  parser.upcoming = { leading, detached }
  return trailing
}

function skipWsAndComments(parser: ProtoParser): undefined {
  skipTrivia(parser)
}

function acceptFullIdent(parser: ProtoParser): ast.FullIdent | undefined {
  const identOrDots = flipFlop<ast.Dot, ast.Ident, ProtoParser>(parser, acceptDot, acceptIdent, skipWsAndComments)
  const last = identOrDots[identOrDots.length - 1]
  if (last?.type === "dot") {
    // a full identifier does not end with a dot: give it back (e.g. the `.` before `(` in `features.(pb.cpp).x`)
    identOrDots.pop()
    parser.loc = last.start
  }
  if (identOrDots.length < 1) return
  return {
    ...mergeSpans(identOrDots),
    type: "full-ident",
    identOrDots,
  }
}

function expectFullIdent(parser: ProtoParser): ast.FullIdent {
  const fullIdent = acceptFullIdent(parser)
  if (fullIdent) return fullIdent
  throw new ParserSyntaxError(parser, [".", identPattern])
}

function acceptType(parser: ProtoParser): ast.Type | undefined {
  const identOrDots = flipFlop<ast.Dot, ast.Ident, ProtoParser>(parser, acceptDot, acceptIdent, skipWsAndComments)
  if (identOrDots.length < 1) return
  return {
    ...mergeSpans(identOrDots),
    type: "type",
    identOrDots,
  }
}

function expectType(parser: ProtoParser): ast.Type {
  const type = acceptType(parser)
  if (type) return type
  throw new ParserSyntaxError(parser, [".", identPattern])
}

function acceptIntLit(parser: ProtoParser): ast.IntLit | undefined {
  const intLit = parser.accept(intLitPattern)
  if (!intLit) return
  return { type: "int-lit", ...intLit }
}

function expectIntLit(parser: ProtoParser): ast.IntLit {
  const intLit = acceptIntLit(parser)
  if (intLit) return intLit
  throw new ParserSyntaxError(parser, [intLitPattern])
}

function acceptSignedIntLit(parser: ProtoParser): ast.SignedIntLit | undefined {
  const loc = parser.loc
  const sign = parser.accept("-") ?? parser.accept("+")
  const intLit = acceptIntLit(parser)
  if (!intLit) {
    parser.loc = loc
    return
  }
  return {
    ...mergeSpans([sign, intLit]),
    type: "signed-int-lit",
    sign,
    value: intLit,
  }
}

function expectSignedIntLit(parser: ProtoParser): ast.SignedIntLit {
  const signedIntLit = acceptSignedIntLit(parser)
  if (signedIntLit) return signedIntLit
  throw new ParserSyntaxError(parser, ["-", intLitPattern])
}

function acceptFloatLit(parser: ProtoParser): ast.FloatLit | undefined {
  const floatLit = parser.accept(floatLitPattern)
  if (!floatLit) return
  return { type: "float-lit", ...floatLit }
}

function acceptSignedFloatLit(parser: ProtoParser): ast.SignedFloatLit | undefined {
  const loc = parser.loc
  const sign = parser.accept("-") ?? parser.accept("+")
  const floatLit = acceptFloatLit(parser)
  if (!floatLit) {
    parser.loc = loc
    return
  }
  return {
    ...mergeSpans([sign, floatLit]),
    type: "signed-float-lit",
    sign,
    value: floatLit,
  }
}

function acceptBoolLit(parser: ProtoParser): ast.BoolLit | undefined {
  const boolLit = parser.accept(boolLitPattern)
  if (!boolLit) return
  return { type: "bool-lit", ...boolLit }
}

function acceptStrLit(parser: ProtoParser): ast.StrLit | undefined {
  const strLit = acceptStrLitToken(parser)
  if (!strLit) return
  const tokens: Token[] = [strLit]
  while (true) {
    skipWsAndComments(parser)
    const strLit = acceptStrLitToken(parser)
    if (!strLit) break
    tokens.push(strLit)
  }
  return { ...mergeSpans(tokens), type: "str-lit", tokens }
}

function expectStrLit(parser: ProtoParser): ast.StrLit {
  const strLit = acceptStrLit(parser)
  if (strLit) return strLit
  throw new ParserSyntaxError(parser, [strLitPattern])
}

function acceptAggregate(parser: ProtoParser): ast.Aggregate | undefined {
  const bracketOpen = parser.accept("{")
  if (!bracketOpen) return
  const statements = acceptTextprotoStatements(parser)
  const bracketClose = parser.expect("}")
  return {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "aggregate",
    bracketOpen,
    statements,
    bracketClose,
  }
}

function acceptConstant(parser: ProtoParser): ast.Constant | undefined {
  return (
    acceptSignedFloatLit(parser) ??
    acceptSignedIntLit(parser) ??
    acceptStrLit(parser) ??
    acceptBoolLit(parser) ??
    acceptFullIdent(parser) ??
    acceptAggregate(parser)
  )
}

function expectConstant(parser: ProtoParser): ast.Constant {
  const constant = acceptConstant(parser)
  if (constant) return constant
  throw new ParserSyntaxError(parser, [identPattern, "-", "+", intLitPattern, strLitPattern, boolLitPattern, "{"])
}

function acceptOptionNameSegment(parser: ProtoParser): ast.OptionNameSegment | undefined {
  const bracketOpen = parser.accept("(")
  const name = acceptFullIdent(parser)
  if (!name) {
    if (bracketOpen) throw new ParserSyntaxError(parser, [identPattern])
    return
  }
  const bracketClose = bracketOpen ? parser.expect(")") : parser.accept(")")
  return {
    ...mergeSpans([bracketOpen, name, bracketClose]),
    type: "option-name-segment",
    bracketOpen,
    name,
    bracketClose,
  }
}

function acceptOptionName(parser: ProtoParser): ast.OptionName | undefined {
  const optionNameSegmentOrDots = many(
    parser,
    choice<ast.Dot | ast.OptionNameSegment, ProtoParser>([acceptDot, acceptOptionNameSegment]),
  )
  if (optionNameSegmentOrDots.length < 1) return
  return {
    ...mergeSpans(optionNameSegmentOrDots),
    type: "option-name",
    optionNameSegmentOrDots,
  }
}

function expectOptionName(parser: ProtoParser): ast.OptionName {
  const optionName = acceptOptionName(parser)
  if (optionName) return optionName
  throw new ParserSyntaxError(parser, ["(", identPattern])
}

function acceptSyntax(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Syntax | undefined {
  const keyword = acceptKeyword(parser, syntaxPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const quoteOpen = parser.expect(quotePattern)
  const syntax = parser.expect(syntaxValuePattern)
  const quoteClose = parser.expect(quotePattern)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "syntax",
    keyword,
    eq,
    quoteOpen,
    syntax,
    quoteClose,
    semi,
  })
}

function acceptEdition(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Edition | undefined {
  const keyword = acceptKeyword(parser, editionPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const quoteOpen = parser.expect(quotePattern)
  const edition = parser.expect(syntaxValuePattern)
  const quoteClose = parser.expect(quotePattern)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "edition",
    keyword,
    eq,
    quoteOpen,
    edition,
    quoteClose,
    semi,
  })
}

function acceptImport(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Import | undefined {
  const keyword = acceptKeyword(parser, importPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const weakOrPublic = parser.accept(importModifierPattern)
  skipWsAndComments(parser)
  const strLit = expectStrLit(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "import",
    keyword,
    weakOrPublic,
    strLit,
    semi,
  })
}

function acceptPackage(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Package | undefined {
  const keyword = acceptKeyword(parser, packagePattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const fullIdent = expectFullIdent(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "package",
    keyword,
    fullIdent,
    semi,
  })
}

function acceptOption(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Option | undefined {
  const keyword = acceptKeyword(parser, optionPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const optionName = expectOptionName(parser)
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const constant = expectConstant(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "option",
    keyword,
    optionName,
    eq,
    constant,
    semi,
  })
}

function acceptEmpty(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Empty | undefined {
  const semi = acceptSemi(parser)
  if (!semi) return
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [semi], {
    type: "empty",
    semi,
  })
}

function acceptFieldOption(parser: ProtoParser): ast.FieldOption | undefined {
  const optionName = acceptOptionName(parser)
  if (!optionName) return
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const constant = expectConstant(parser)
  return {
    ...mergeSpans([optionName, constant]),
    type: "field-option",
    optionName,
    eq,
    constant,
  }
}

function acceptFieldOptions(parser: ProtoParser): ast.FieldOptions | undefined {
  const bracketOpen = parser.accept("[")
  if (!bracketOpen) return
  const fieldOptionOrCommas = many(
    parser,
    choice<ast.FieldOption | ast.Comma, ProtoParser>([skipWsAndComments, acceptComma, acceptFieldOption]),
  )
  const bracketClose = parser.expect("]")
  return {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "field-options",
    bracketOpen,
    fieldOptionOrCommas,
    bracketClose,
  }
}

function acceptEnumField(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.EnumField | undefined {
  const fieldName = parser.accept(identPattern)
  if (!fieldName) return
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const fieldNumber = expectSignedIntLit(parser)
  skipWsAndComments(parser)
  const fieldOptions = acceptFieldOptions(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [fieldName, semi], {
    type: "enum-field",
    fieldName,
    eq,
    fieldNumber,
    fieldOptions,
    semi,
  })
}

const enumBodyStatementFns: StatementFn<ast.EnumBodyStatement>[] = [
  acceptOption,
  acceptReserved,
  acceptEnumField,
  acceptEmpty,
]

/** Returns the body and the trailing comments after its `{`. */
function expectEnumBody(parser: ProtoParser): [ast.EnumBody, ast.CommentGroup[]] {
  const bracketOpen = parser.expect("{")
  const trailingComments = acceptTrailingComments(parser)
  const statements = acceptStatements(parser, enumBodyStatementFns)
  const bracketClose = parser.expect("}")
  acceptTrailingComments(parser) // comments after `}` are not attached (protoc)
  const enumBody: ast.EnumBody = {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "enum-body",
    bracketOpen,
    statements,
    bracketClose,
  }
  return [enumBody, trailingComments]
}

/**
 * Edition 2024 `export` / `local` before `message` / `enum`. Accepted only when followed by that keyword and an
 * identifier (so `local foo = 1;` or `export message = 2;` stay fields); otherwise the position is left unchanged.
 */
function acceptVisibility(parser: ProtoParser, keywordPattern: RegExp): ast.Keyword | undefined {
  const loc = parser.loc
  const visibility = acceptKeyword(parser, visibilityPattern)
  if (!visibility) return
  skipWsAndComments(parser)
  const keywordLoc = parser.loc
  if (parser.accept(keywordPattern)) {
    skipWsAndComments(parser)
    if (parser.try(identPattern)) {
      parser.loc = keywordLoc
      return visibility
    }
  }
  parser.loc = loc
  return
}

function acceptEnum(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Enum | undefined {
  const visibility = acceptVisibility(parser, enumPattern)
  const keyword = acceptKeyword(parser, enumPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const enumName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const [enumBody, trailingComments] = expectEnumBody(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [visibility, keyword, enumBody], {
    type: "enum",
    ...(visibility ? { visibility } : {}),
    keyword,
    enumName,
    enumBody,
  })
}

interface FieldRest {
  fieldName: Token
  eq: Token
  fieldNumber: ast.IntLit
  fieldOptions: ast.FieldOptions | undefined
  semi: ast.Semi
}

function acceptField(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Field | ast.MalformedField | undefined {
  const loc = parser.loc
  let fieldLabel = acceptKeyword(parser, fieldLabelPattern)
  skipWsAndComments(parser)
  let fieldType = acceptType(parser)
  if (fieldLabel && fieldType && parser.input.charCodeAt(parser.loc) === 61 /* = */) {
    // `optional o = 9;`: the "label" is the type name and the "type" the field name (buf accepts this in proto3 and
    // editions, validation text#13)
    parser.loc = loc
    fieldLabel = undefined
    fieldType = acceptType(parser)
  }
  if (!fieldType) {
    parser.loc = loc
    return
  }
  const rest = acceptComplexSequence<FieldRest>(
    parser,
    [
      ["fieldName", (parser) => parser.expect(identPattern)],
      ["eq", (parser) => parser.expect("=")],
      ["fieldNumber", expectIntLit],
      ["fieldOptions", acceptFieldOptions],
      ["semi", expectSemi],
    ],
    messageBodyStatementKeywordPattern,
  )
  const trailingComments = rest.result.semi ? acceptTrailingComments(parser) : []
  if (rest.partial && !parser.malformed) parser.malformed = rest.error
  const node = statement(
    leadingComments,
    leadingDetachedComments,
    trailingComments,
    [fieldLabel, fieldType, Object.values(rest.result) as (Span | undefined)[]],
    { type: rest.partial ? "malformed-field" : "field", fieldLabel, fieldType, ...rest.result },
  )
  return node as ast.Field | ast.MalformedField
}

function acceptOneofField(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.OneofField | undefined {
  const fieldType = acceptType(parser)
  if (!fieldType) return
  skipWsAndComments(parser)
  const fieldName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const fieldNumber = expectIntLit(parser)
  skipWsAndComments(parser)
  const fieldOptions = acceptFieldOptions(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [fieldType, semi], {
    type: "oneof-field",
    fieldType,
    fieldName,
    eq,
    fieldNumber,
    fieldOptions,
    semi,
  })
}

function acceptMapField(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.MapField | undefined {
  const loc = parser.loc
  const keyword = acceptKeyword(parser, mapPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  if (!parser.try("<")) {
    // `map` used as a type name (protoc accepts it)
    parser.loc = loc
    return
  }
  const typeBracketOpen = parser.expect("<")
  skipWsAndComments(parser)
  const keyType = expectType(parser)
  skipWsAndComments(parser)
  const typeSep = parser.expect(",")
  skipWsAndComments(parser)
  const valueType = expectType(parser)
  skipWsAndComments(parser)
  const typeBracketClose = parser.expect(">")
  skipWsAndComments(parser)
  const mapName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const fieldNumber = expectIntLit(parser)
  skipWsAndComments(parser)
  const fieldOptions = acceptFieldOptions(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "map-field",
    keyword,
    typeBracketOpen,
    keyType,
    typeSep,
    valueType,
    typeBracketClose,
    mapName,
    eq,
    fieldNumber,
    fieldOptions,
    semi,
  })
}

const oneofBodyStatementFns: StatementFn<ast.OneofBodyStatement>[] = [
  acceptOneofGroup,
  acceptOption,
  acceptOneofField,
  acceptEmpty,
]

function expectOneofBody(parser: ProtoParser): [ast.OneofBody, ast.CommentGroup[]] {
  const bracketOpen = parser.expect("{")
  const trailingComments = acceptTrailingComments(parser)
  const statements = acceptStatements(parser, oneofBodyStatementFns)
  const bracketClose = parser.expect("}")
  acceptTrailingComments(parser) // comments after `}` are not attached (protoc)
  const oneofBody: ast.OneofBody = {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "oneof-body",
    bracketOpen,
    statements,
    bracketClose,
  }
  return [oneofBody, trailingComments]
}

function acceptOneof(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Oneof | undefined {
  const keyword = acceptKeyword(parser, oneofPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const oneofName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const [oneofBody, trailingComments] = expectOneofBody(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, oneofBody], {
    type: "oneof",
    keyword,
    oneofName,
    oneofBody,
  })
}

const acceptMax = acceptPatternAndThen<ast.Max>(maxPattern, (max) => ({ type: "max", ...max }))

function acceptRange(parser: ProtoParser): ast.Range | undefined {
  const rangeStart = acceptSignedIntLit(parser)
  if (!rangeStart) return
  skipWsAndComments(parser)
  const to = acceptKeyword(parser, toPattern)
  if (!to) {
    return {
      start: rangeStart.start,
      end: rangeStart.end,
      type: "range",
      rangeStart,
    }
  }
  skipWsAndComments(parser)
  const rangeEnd = acceptSignedIntLit(parser) ?? acceptMax(parser)
  if (!rangeEnd) throw new ParserSyntaxError(parser, ["-", intLitPattern, maxPattern])
  return {
    ...mergeSpans([rangeStart, rangeEnd]),
    type: "range",
    rangeStart,
    to,
    rangeEnd,
  }
}

function expectRanges(parser: ProtoParser): ast.Ranges {
  const rangeOrCommas = many(
    parser,
    choice<ast.Range | ast.Comma, ProtoParser>([skipWsAndComments, acceptComma, acceptRange]),
  )
  return {
    ...mergeSpans(rangeOrCommas),
    type: "ranges",
    rangeOrCommas,
  }
}

function acceptExtensions(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Extensions | undefined {
  const keyword = acceptKeyword(parser, extensionsPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const ranges = expectRanges(parser)
  skipWsAndComments(parser)
  const fieldOptions = acceptFieldOptions(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "extensions",
    keyword,
    ranges,
    fieldOptions,
    semi,
  })
}

function expectFieldNames(parser: ProtoParser): ast.FieldNames {
  const strLitOrCommas = many(
    parser,
    choice<ast.StrLit | ast.Ident | ast.Comma, ProtoParser>([
      skipWsAndComments,
      acceptComma,
      acceptStrLit,
      acceptIdent,
    ]),
  )
  return {
    ...mergeSpans(strLitOrCommas),
    type: "field-names",
    strLitOrCommas,
  }
}

function acceptReserved(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Reserved | undefined {
  const keyword = acceptKeyword(parser, reservedPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const reserved = (parser.try("-") ?? parser.try(intLitPattern)) ? expectRanges(parser) : expectFieldNames(parser)
  skipWsAndComments(parser)
  const semi = expectSemi(parser)
  const trailingComments = acceptTrailingComments(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semi], {
    type: "reserved",
    keyword,
    reserved,
    semi,
  })
}

const extendBodyStatementFns: StatementFn<ast.ExtendBodyStatement>[] = [acceptGroup, acceptField, acceptEmpty]

function expectExtendBody(parser: ProtoParser): [ast.ExtendBody, ast.CommentGroup[]] {
  const bracketOpen = parser.expect("{")
  const trailingComments = acceptTrailingComments(parser)
  const statements = acceptStatements(parser, extendBodyStatementFns)
  const bracketClose = parser.expect("}")
  acceptTrailingComments(parser) // comments after `}` are not attached (protoc)
  const extendBody: ast.ExtendBody = {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "extend-body",
    bracketOpen,
    statements,
    bracketClose,
  }
  return [extendBody, trailingComments]
}

function acceptExtend(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Extend | undefined {
  const keyword = acceptKeyword(parser, extendPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const messageType = expectType(parser)
  skipWsAndComments(parser)
  const [extendBody, trailingComments] = expectExtendBody(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, extendBody], {
    type: "extend",
    keyword,
    messageType,
    extendBody,
  })
}

/**
 * `group Name = N [options] {` without a label: groups are not allowed in proto3 or editions, but buf parses them
 * (and rejects them later), so the rest of the file still builds. Lookahead only; the position is unchanged.
 */
function isLabellessGroupAhead(parser: ProtoParser): boolean {
  const loc = parser.loc
  try {
    if (!acceptKeyword(parser, groupPattern)) return false
    skipWsAndComments(parser)
    if (!parser.accept(identPattern)) return false
    skipWsAndComments(parser)
    if (!parser.accept("=")) return false
    skipWsAndComments(parser)
    if (!acceptIntLit(parser)) return false
    skipWsAndComments(parser)
    if (parser.input.charCodeAt(parser.loc) === 91 /* [ */) return true
    return parser.input.charCodeAt(parser.loc) === 123 /* { */
  } finally {
    parser.loc = loc
  }
}

function acceptGroup(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Group | undefined {
  const loc = parser.loc
  const groupLabel = acceptKeyword(parser, fieldLabelPattern)
  if (!groupLabel && !isLabellessGroupAhead(parser)) return
  skipWsAndComments(parser)
  const keyword = acceptKeyword(parser, groupPattern)
  if (!keyword) {
    parser.loc = loc
    return
  }
  skipWsAndComments(parser)
  const groupName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const fieldNumber = expectIntLit(parser)
  skipWsAndComments(parser)
  const fieldOptions = acceptFieldOptions(parser)
  skipWsAndComments(parser)
  if (parser.input.charCodeAt(parser.loc) !== 123 /* { */) {
    // `optional group g = 1;`: a field whose type is named `group` (validation text#13)
    parser.loc = loc
    return
  }
  const [messageBody, trailingComments] = expectMessageBody(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [groupLabel, keyword, messageBody], {
    type: "group",
    groupLabel,
    keyword,
    groupName,
    eq,
    fieldNumber,
    fieldOptions,
    messageBody,
  })
}

function acceptOneofGroup(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.OneofGroup | undefined {
  const loc = parser.loc
  const keyword = acceptKeyword(parser, groupPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const groupName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const eq = parser.expect("=")
  skipWsAndComments(parser)
  const fieldNumber = expectIntLit(parser)
  skipWsAndComments(parser)
  const fieldOptions = acceptFieldOptions(parser)
  skipWsAndComments(parser)
  if (parser.input.charCodeAt(parser.loc) !== 123 /* { */) {
    // `group g = 1;`: a field whose type is named `group` (validation text#13)
    parser.loc = loc
    return
  }
  const [messageBody, trailingComments] = expectMessageBody(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, messageBody], {
    type: "oneof-group",
    keyword,
    groupName,
    eq,
    fieldNumber,
    fieldOptions,
    messageBody,
  })
}

const typeKeywordPattern = keywordPattern("message", "enum", "extend", "extensions", "oneof", "reserved")

/**
 * A label-less field whose type name is a statement keyword (`message message = 5;`, `enum e = 7;`,
 * `reserved r = 2;`, `message.Inner x = 1;`): buf accepts these in proto3 and editions files (validation text#13).
 * Recognised by looking ahead for `Type Name =` before the keyword's own statement is tried.
 */
function acceptKeywordTypeField(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Field | ast.MalformedField | undefined {
  const loc = parser.loc
  if (!acceptKeyword(parser, typeKeywordPattern)) return
  parser.loc = loc
  let isField = false
  if (acceptType(parser) && parser.accept(identPattern)) {
    skipWsAndComments(parser)
    isField = !!parser.try("=")
  }
  parser.loc = loc
  return isField ? acceptField(parser, leadingComments, leadingDetachedComments) : undefined
}

const messageBodyStatementFns: StatementFn<ast.MessageBodyStatement>[] = [
  acceptKeywordTypeField,
  acceptGroup,
  acceptEnum,
  acceptMessage,
  acceptExtend,
  acceptExtensions,
  acceptOption,
  acceptOneof,
  acceptMapField,
  acceptReserved,
  acceptField,
  acceptEmpty,
]

function expectMessageBody(parser: ProtoParser): [ast.MessageBody, ast.CommentGroup[]] {
  const bracketOpen = parser.expect("{")
  const trailingComments = acceptTrailingComments(parser)
  const statements = acceptStatements(parser, messageBodyStatementFns)
  const bracketClose = parser.expect("}")
  acceptTrailingComments(parser) // comments after `}` are not attached (protoc)
  const messageBody: ast.MessageBody = {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "message-body",
    bracketOpen,
    statements,
    bracketClose,
  }
  return [messageBody, trailingComments]
}

function acceptMessage(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Message | undefined {
  const visibility = acceptVisibility(parser, messagePattern)
  const keyword = acceptKeyword(parser, messagePattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const messageName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const [messageBody, trailingComments] = expectMessageBody(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [visibility, keyword, messageBody], {
    type: "message",
    ...(visibility ? { visibility } : {}),
    keyword,
    messageName,
    messageBody,
  })
}

function expectRpcType(parser: ProtoParser): ast.RpcType {
  const bracketOpen = parser.expect("(")
  skipWsAndComments(parser)
  const streamLoc = parser.loc
  let stream = acceptKeyword(parser, streamPattern)
  skipWsAndComments(parser)
  if (stream && parser.input.charCodeAt(parser.loc) === 41 /* ) */) {
    // `(stream)`: a message type named `stream`
    parser.loc = streamLoc
    stream = undefined
  }
  const messageType = expectType(parser)
  skipWsAndComments(parser)
  const bracketClose = parser.expect(")")
  return {
    ...mergeSpans([bracketOpen, bracketClose]),
    bracketOpen,
    stream,
    messageType,
    bracketClose,
  }
}

function acceptRpc(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Rpc | undefined {
  const keyword = acceptKeyword(parser, rpcPattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const rpcName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const reqType = expectRpcType(parser)
  skipWsAndComments(parser)
  const returns = expectKeyword(parser, returnsPattern)
  skipWsAndComments(parser)
  const resType = expectRpcType(parser)
  skipWsAndComments(parser)
  let semiOrRpcBody: ast.Semi | ast.RpcBody
  let trailingComments: ast.CommentGroup[]
  const semi = acceptSemi(parser)
  if (semi) {
    semiOrRpcBody = semi
    trailingComments = acceptTrailingComments(parser)
  } else {
    ;[semiOrRpcBody, trailingComments] = expectRpcBody(parser)
  }
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, semiOrRpcBody], {
    type: "rpc",
    keyword,
    rpcName,
    reqType,
    returns,
    resType,
    semiOrRpcBody,
  })
}

const rpcBodyStatementFns: StatementFn<ast.RpcBodyStatement>[] = [acceptOption, acceptEmpty]

function expectRpcBody(parser: ProtoParser): [ast.RpcBody, ast.CommentGroup[]] {
  const bracketOpen = parser.expect("{", [";"])
  const trailingComments = acceptTrailingComments(parser)
  const statements = acceptStatements(parser, rpcBodyStatementFns)
  const bracketClose = parser.expect("}")
  acceptTrailingComments(parser) // comments after `}` are not attached (protoc)
  const rpcBody: ast.RpcBody = {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "rpc-body",
    bracketOpen,
    statements,
    bracketClose,
  }
  return [rpcBody, trailingComments]
}

const serviceBodyStatementFns: StatementFn<ast.ServiceBodyStatement>[] = [acceptOption, acceptRpc, acceptEmpty]

function expectServiceBody(parser: ProtoParser): [ast.ServiceBody, ast.CommentGroup[]] {
  const bracketOpen = parser.expect("{")
  const trailingComments = acceptTrailingComments(parser)
  const statements = acceptStatements(parser, serviceBodyStatementFns)
  const bracketClose = parser.expect("}")
  acceptTrailingComments(parser) // comments after `}` are not attached (protoc)
  const serviceBody: ast.ServiceBody = {
    ...mergeSpans([bracketOpen, bracketClose]),
    type: "service-body",
    bracketOpen,
    statements,
    bracketClose,
  }
  return [serviceBody, trailingComments]
}

function acceptService(
  parser: ProtoParser,
  leadingComments: ast.CommentGroup[],
  leadingDetachedComments: ast.CommentGroup[],
): ast.Service | undefined {
  const keyword = acceptKeyword(parser, servicePattern)
  if (!keyword) return
  skipWsAndComments(parser)
  const serviceName = parser.expect(identPattern)
  skipWsAndComments(parser)
  const [serviceBody, trailingComments] = expectServiceBody(parser)
  return statement(leadingComments, leadingDetachedComments, trailingComments, [keyword, serviceBody], {
    type: "service",
    keyword,
    serviceName,
    serviceBody,
  })
}
