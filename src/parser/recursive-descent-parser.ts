/**
 * Origin: pbkit 0.0.72, `core/parser/recursive-descent-parser.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./LICENSE-MIT, ./LICENSE-APACHE).
 *
 * Modifications:
 * - strict TypeScript port of the compiled `.js` + `.d.ts`.
 * - the event-emitter dependency is removed: comments are collected in `parser.comments` (deduplicated by position,
 *   so re-scanning after backtracking does not record a comment twice) and an optional `onComment` callback.
 * - regular expressions are matched in place with sticky (`y`) patterns (`lastIndex = loc`) instead of
 *   `pattern.exec(input.substr(loc))`; non-sticky patterns still work through the original substring path.
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
  expect(acceptPattern: Pattern, expectedPatterns?: Pattern[], mistakePatterns?: Pattern[]): Token
}

export interface RecursiveDescentParserConfig<TComment extends Token = Token> {
  debug: boolean
  onComment: (comment: TComment) => void
}

export interface Span {
  start: number
  end: number
}

export interface ColRow {
  col: number
  row: number
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
  config?: Partial<RecursiveDescentParserConfig<TComment>>,
): RecursiveDescentParser<TComment> {
  const debug = !!config?.debug
  const onComment = config?.onComment
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
      onComment?.(comment)
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
    expect(acceptPattern, expectedPatterns, mistakePatterns) {
      const result = parser.accept(acceptPattern)
      if (result == null) {
        const _expectedPatterns: Pattern[] = expectedPatterns ? [acceptPattern, ...expectedPatterns] : [acceptPattern]
        throw new ParserSyntaxError(parser, _expectedPatterns, mistakePatterns)
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
    debug && console.log(pattern)
    return { start, end, text: pattern }
  }
  function acceptRegex(pattern: RegExp): Token | undefined {
    let text: string
    let start: number
    if (pattern.sticky) {
      pattern.lastIndex = parser.loc
      const execArray = pattern.exec(input)
      if (execArray == null) return
      text = execArray[0]
      start = parser.loc
    } else {
      // pbkit's original path, kept for externally supplied `^`-anchored patterns
      pattern.lastIndex = 0
      const execArray = pattern.exec(input.substring(parser.loc))
      if (execArray == null) return
      text = execArray[0]
      start = parser.loc + execArray.index
    }
    const end = start + text.length
    parser.loc = end
    debug && console.log(text)
    return { start, end, text }
  }
  return parser
}

/** A syntax error at `offset` (the position of the unexpected input). */
export class ParserSyntaxError extends Error {
  readonly offset: number
  /** Unexpected text at `offset` (a token or a single character), or `eof` at the end of the input. */
  readonly got: string | typeof eof
  /** Human-readable descriptions of `expectedPatterns`. */
  readonly expected: string[]
  constructor(
    parser: RecursiveDescentParser<Token>,
    public readonly expectedPatterns: Pattern[],
    public readonly mistakePatterns: Pattern[] = [],
  ) {
    super()
    this.name = "ParserSyntaxError"
    this.offset = parser.loc
    this.got = getGot(parser, mistakePatterns)
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

function getGot(parser: RecursiveDescentParser<Token>, mistakePatterns: Pattern[]): string | typeof eof {
  for (const mistakePattern of mistakePatterns) {
    const token = parser.try(mistakePattern)
    if (token) return token.text
  }
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
