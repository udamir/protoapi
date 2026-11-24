/**
 * Origin: pbkit 0.0.72, `core/parser/recursive-descent-parser.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./LICENSE-MIT, ./LICENSE-APACHE).
 *
 * Modifications:
 * - strict TypeScript port of the compiled `.js` + `.d.ts`.
 * - renamed from `recursive-descent-parser.ts` (the scanner every grammar file builds on); its contents are unchanged by the rename.
 * - the event-emitter dependency is removed: comments are collected in `parser.comments` (deduplicated by position,
 *   so re-scanning after backtracking does not record a comment twice).
 * - the `debug` / `onComment` config, `ColRow` and the `mistakePatterns` of `expect` are removed.
 * - regular expressions must be sticky (`y`) and are matched in place (`lastIndex = loc`) instead of
 *   `pattern.exec(input.substr(loc))`.
 * - string patterns are matched with `startsWith(pattern, loc)` (no slice allocation).
 * - the per-`accept` "infinite loop" counter (`cnt > input.length * 5`, which also rejected valid tiny inputs such as
 *   `parseConstant("1")`) is removed; `many` / `flipFlop` / statement loops stop when an iteration does not advance.
 * - `offsetToColRow`, `colRowToOffset` and `getAroundText` (linear per call) are removed; see `position.ts`.
 * - `SyntaxError` is renamed `ParserSyntaxError` (no shadowing of the global) and captures the error `offset`,
 *   the unexpected text (`got`) and human-readable `expected` descriptions at construction time.
 */

export interface RecursiveDescentParser<TComment extends Token = Token> {
  readonly input: string
  loc: number
  /** Comments recorded so far, in source order, each at most once. */
  readonly comments: TComment[]
  /** Records a comment unless a comment at or after this position was already recorded. */
  addComment(comment: TComment): void
  try(pattern: Pattern): Token | undefined
  accept(pattern: Pattern): Token | undefined
  expect(acceptPattern: Pattern, expectedPatterns?: Pattern[]): Token
}

export interface Span {
  start: number
  end: number
}

export interface Token extends Span {
  text: string
}

export type Pattern = string | RegExp | typeof eof

export const eof: unique symbol = Symbol("<EOF>")

const patternNames = new WeakMap<RegExp, string>()

/** Registers a human-readable name for a pattern, used in `ParserSyntaxError.expected`. Returns the pattern. */
export function namePattern<T extends RegExp>(pattern: T, name: string): T {
  patternNames.set(pattern, name)
  return pattern
}

export function createRecursiveDescentParser<TComment extends Token = Token>(
  input: string,
): RecursiveDescentParser<TComment> {
  const comments: TComment[] = []
  let commentsEnd = 0
  const parser: RecursiveDescentParser<TComment> = {
    input,
    loc: 0,
    comments,
    addComment(comment) {
      if (comment.start < commentsEnd) return
      commentsEnd = comment.end
      comments.push(comment)
    },
    try(pattern) {
      const loc = parser.loc
      try {
        return parser.accept(pattern)
      } finally {
        parser.loc = loc
      }
    },
    accept(pattern) {
      if (typeof pattern === "string") return acceptString(pattern)
      if (pattern === eof) return acceptEof()
      return acceptRegex(pattern)
    },
    expect(acceptPattern, expectedPatterns) {
      const result = parser.accept(acceptPattern)
      if (result == null) {
        throw new ParserSyntaxError(parser, expectedPatterns ? [acceptPattern, ...expectedPatterns] : [acceptPattern])
      }
      return result
    },
  }
  function acceptEof(): Token | undefined {
    if (parser.loc < input.length) return
    return { start: parser.loc, end: parser.loc, text: "" }
  }
  function acceptString(pattern: string): Token | undefined {
    const start = parser.loc
    if (!input.startsWith(pattern, start)) return
    const end = start + pattern.length
    parser.loc = end
    return { start, end, text: pattern }
  }
  /** `pattern` must be sticky: it is matched at `parser.loc` only. */
  function acceptRegex(pattern: RegExp): Token | undefined {
    const start = parser.loc
    pattern.lastIndex = start
    const execArray = pattern.exec(input)
    if (execArray == null) return
    const text = execArray[0]
    const end = start + text.length
    parser.loc = end
    return { start, end, text }
  }
  return parser
}

/** A syntax error at `offset` (the position of the unexpected input). */
export class ParserSyntaxError extends Error {
  readonly offset: number
  /** Unexpected text at `offset` (a token or a single character), or `eof` at the end of the input. */
  readonly got: string | typeof eof
  /** Human-readable descriptions of the expected patterns. */
  readonly expected: string[]
  constructor(parser: RecursiveDescentParser<Token>, expectedPatterns: Pattern[]) {
    super()
    this.name = "ParserSyntaxError"
    this.offset = parser.loc
    this.got = getGot(parser)
    this.expected = expectedPatterns.map(patternToString)
    this.message = `expected ${this.expected.join(" or ")}, got ${patternToString(this.got)}`
  }
}

/**
 * A malformed token (an invalid escape or an unterminated string literal): never recovered from, so the error is
 * reported where the token is malformed rather than where a later rule gives up (validation text#14).
 */
export class TokenSyntaxError extends ParserSyntaxError {
  constructor(parser: RecursiveDescentParser<Token>, expectedPatterns: Pattern[], message: string) {
    super(parser, expectedPatterns)
    this.name = "TokenSyntaxError"
    this.message = message
  }
}

const gotTokenPattern = /[A-Za-z_][A-Za-z0-9_]*|[0-9][A-Za-z0-9_.]*|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y

function getGot(parser: RecursiveDescentParser<Token>): string | typeof eof {
  const { input, loc } = parser
  if (loc >= input.length) return eof
  gotTokenPattern.lastIndex = loc
  const m = gotTokenPattern.exec(input)
  if (m && m[0].length > 0) return m[0]
  return String.fromCodePoint(input.codePointAt(loc) ?? 0)
}

export function patternToString(pattern: Pattern): string {
  if (pattern === eof) return "<EOF>"
  if (typeof pattern === "string") return JSON.stringify(pattern)
  return patternNames.get(pattern) ?? pattern.toString()
}
