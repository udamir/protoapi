/**
 * Origin: pbkit 0.0.72, `core/parser/misc.{js,d.ts}` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./LICENSE-MIT, ./LICENSE-APACHE).
 *
 * Parser combinators shared by the `.proto` and text-format grammars.
 *
 * Modifications:
 * - strict TypeScript port; parser type is generic over the comment type.
 * - `many` / `flipFlop` stop when an accepted node did not advance the parser (replaces pbkit's global
 *   per-accept loop counter).
 * - `expectSpecialToken` (unused) is removed.
 * - renamed from `misc.ts`; the token helpers (`acceptSpecialToken`, the identifier and comment patterns, `skipTrivia`) moved to lexer.ts.
 * - `signed` (from textproto.ts, where it accepted `-` only) takes the sign characters, so proto.ts's signed literals use it too.
 */
import type { Pattern, RecursiveDescentParser, Span, Token } from "./scanner.ts"

/** Any parser: `addComment` is a method, so a parser of a narrower comment type is assignable to this. */
export type AnyParser = RecursiveDescentParser<Token>

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

export function acceptPatternAndThen<T>(pattern: Pattern, then: (token: Token) => T): AcceptFn<T> {
  return function accept(parser: AnyParser): T | undefined {
    const token = parser.accept(pattern)
    if (!token) return
    return then(token)
  }
}

/** A node of type `type`: an optional sign token (the first of `signs` that matches) followed by a `value` node. */
export function signed<TValue extends Token, TType extends string, P extends AnyParser = AnyParser>(
  acceptFn: AcceptFn<TValue, P>,
  type: TType,
  signs: readonly string[],
): AcceptFn<{ start: number; end: number; type: TType; sign?: Token; value: TValue }, P> {
  return function accept(parser) {
    const loc = parser.loc
    let sign: Token | undefined
    for (let i = 0; i < signs.length && !sign; i++) sign = parser.accept(signs[i])
    const value = acceptFn(parser)
    if (!value) {
      parser.loc = loc
      return
    }
    return { ...mergeSpans([sign, value]), type, sign, value }
  }
}
