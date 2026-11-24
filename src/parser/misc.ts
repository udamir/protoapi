/**
 * Origin: pbkit 0.0.72, `core/parser/misc.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./LICENSE-MIT, ./LICENSE-APACHE).
 *
 * Modifications:
 * - strict TypeScript port; parser type is generic over the comment type.
 * - `many` / `flipFlop` stop when an accepted node did not advance the parser (replaces pbkit's global
 *   per-accept loop counter).
 * - the default identifier pattern is sticky (see recursive-descent-parser.ts).
 * - `expectSpecialToken` (unused) is removed.
 */
import type { Pattern, RecursiveDescentParser, Span, Token } from "./recursive-descent-parser.ts"

/** Any parser: `addComment` is a method, so a parser of a narrower comment type is assignable to this. */
type AnyParser = RecursiveDescentParser<Token>

export type AcceptFn<T, P extends AnyParser = AnyParser> = (parser: P) => T | undefined

export function many<T, P extends AnyParser>(parser: P, acceptFn: AcceptFn<T, P>): T[] {
  const nodes: T[] = []
  let loc = parser.loc
  let node: T | undefined
  while ((node = acceptFn(parser))) {
    nodes.push(node)
    if (parser.loc === loc) break
    loc = parser.loc
  }
  return nodes
}

export function flipFlop<T, U, P extends AnyParser>(
  parser: P,
  flipFn: AcceptFn<T, P>,
  flopFn: AcceptFn<U, P>,
  skipWsFn?: AcceptFn<void, P>,
): (T | U)[] {
  let flip = true
  const fn = (parser: P): T | U | undefined => {
    const result = flip ? flipFn(parser) : flopFn(parser)
    flip = !flip
    skipWsFn?.(parser)
    return result
  }
  const nodes: (T | U)[] = []
  let node: T | U | undefined
  if ((node = fn(parser))) nodes.push(node)
  let loc = parser.loc
  while ((node = fn(parser))) {
    nodes.push(node)
    if (parser.loc === loc) break
    loc = parser.loc
  }
  return nodes
}

export function choice<T, P extends AnyParser>(acceptFns: AcceptFn<T, P>[]): AcceptFn<T, P> {
  return function accept(parser: P): T | undefined {
    for (const acceptFn of acceptFns) {
      const node = acceptFn(parser)
      if (node) return node
    }
    return undefined
  }
}

export function mergeSpans(spans: (undefined | Span | (undefined | Span)[])[]): Span {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (let i = 0; i < spans.length; ++i) {
    const item = spans[i]
    if (item == null) continue
    const span = Array.isArray(item) ? mergeSpans(item) : item
    start = Math.min(start, span.start)
    end = Math.max(end, span.end)
  }
  return { start, end }
}

const identPattern = /[A-Za-z_][A-Za-z0-9_]*/y

export function acceptSpecialToken<TType extends string>(
  parser: AnyParser,
  type: TType,
  pattern: Pattern = identPattern,
): (Token & { type: TType }) | undefined {
  const token = parser.accept(pattern)
  if (!token) return
  return { type, ...token }
}

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
    if (c !== 47 /* / */ && !(hash && c === 35) /* # */ && !(c <= 32 || c >= 0x80)) break
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

export function acceptPatternAndThen<T>(pattern: Pattern, then: (token: Token) => T): AcceptFn<T> {
  return function accept(parser: AnyParser): T | undefined {
    const token = parser.accept(pattern)
    if (!token) return
    return then(token)
  }
}
