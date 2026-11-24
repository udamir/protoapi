/**
 * Origin: pbkit 0.0.72, `core/parser/proto.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0, used here under MIT (see ./LICENSE-MIT).
 *
 * Comment attachment of the `.proto` grammar: which comment groups lead, trail or are detached from a declaration.
 *
 * Modifications:
 * - moved out of proto.ts unchanged (only raw character codes are named constants); the attachment rules and their KNOWN_DEVIATIONS from protoc are described in proto.ts's header.
 * - comment attachment re-implemented after buf 1.75 (protocompile experimental/fdp `commentTracker`): `sweepComments` replaces `skipWsAndSweepComments` / `acceptCommentGroup`, and `acceptTrailingComments` sweeps everything up to the next token, returns the previous declaration's trailing group and stores the next declaration's leading / detached groups.
 */
import type * as ast from "./ast/index.ts"
import {
  acceptSpecialToken,
  CARRIAGE_RETURN,
  CLOSE_BRACE,
  CLOSE_BRACKET,
  CLOSE_PAREN,
  FORM_FEED,
  multilineCommentPattern,
  NEWLINE,
  OPEN_BRACE,
  singlelineCommentPattern,
  skipTrivia,
  SLASH,
  SPACE,
  TAB,
  VERTICAL_TAB,
} from "./lexer.ts"
import { mergeSpans } from "./combinators.ts"
import type { ProtoParser } from "./proto.ts"

export interface PendingComments {
  leading: ast.CommentGroup[]
  detached: ast.CommentGroup[]
}

// pbkit's set plus `\r` (protoc treats `\r` as whitespace; `\r\n` was matched by the newline pattern before)
const whitespaceWithoutNewlinePattern =
  /[ \f\t\v\r\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+/uy
/** The next token (a word or one character) and the trivia after it, up to the token after the next one. */
const tokenAfterNext = /(?:\w+|[\s\S])(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*/y

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
export function sweepComments(parser: ProtoParser, atStart: boolean): SweptComments {
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
    if (c === NEWLINE) {
      // a newline after a `//` line (which ends with its own newline) is a blank line
      parser.loc++
      close()
    } else if (
      c === SPACE ||
      c === TAB ||
      c === CARRIAGE_RETURN ||
      c === FORM_FEED ||
      c === VERTICAL_TAB ||
      c >= 0x80
    ) {
      if (!parser.accept(whitespaceWithoutNewlinePattern)) break
    } else if (c !== SLASH) break
    else if (input.charCodeAt(parser.loc + 1) === SLASH) {
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
  const closer = (x: number) => x === CLOSE_BRACE || x === CLOSE_BRACKET || x === CLOSE_PAREN
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
  const hasPrev = !atStart && input.charCodeAt(start - 1) !== OPEN_BRACE
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
export function takeUpcomingComments(parser: ProtoParser): PendingComments {
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
export function acceptTrailingComments(parser: ProtoParser): ast.CommentGroup[] {
  const { trailing, detached, leading } = sweepComments(parser, false)
  parser.upcoming = { leading, detached }
  return trailing
}

export function skipWsAndComments(parser: ProtoParser): undefined {
  skipTrivia(parser)
}
