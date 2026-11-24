// Helpers over the parser's AST nodes (pbkit AST) shared by the text front end, the text checks and the option
// interpreter: the structural node views they read, option name segments, the text of a dotted name, token ranges
// and attached comments.

import type { CommentGroup, FieldOption, FieldOptions, Span, StatementBase } from "../../parser/index.ts"
import type { MComments } from "../../model/index.ts"
import { protocGroupText } from "../../comments.ts"

/** Minimal structural view of the parser nodes the interpreter reads (pbkit AST). */
export interface Spanned {
  type: string
  start: number
  end: number
}
export interface AggregateNode extends Spanned {
  statements: Spanned[]
}
export interface TextprotoFieldNode extends Spanned {
  fieldName: Spanned & { typeName?: Spanned; domain?: Spanned }
  value: Spanned & { statements?: Spanned[]; valueOrCommas?: Spanned[] }
}

/** Option name segments: plain dotted parts split, parenthesised parts kept whole. */
export const optionNameSegments = (
  name: { optionNameSegmentOrDots?: unknown[] },
  src: (n: Spanned) => string,
): { name: string; ext: boolean }[] => {
  const out: { name: string; ext: boolean }[] = []
  for (const s of (name.optionNameSegmentOrDots ?? []) as (Spanned & { bracketOpen?: unknown; name?: Spanned })[]) {
    if (s.type !== "option-name-segment" || !s.name) continue
    const text = tokensText(s.name, src)
    if (s.bracketOpen) out.push({ name: text, ext: true })
    else for (const part of text.split(".")) if (part) out.push({ name: part, ext: false })
  }
  return out
}

/** Whitespace and comments between the tokens of a name or a number. */
export const TRIVIA = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\s+/g

/** A dotted name node as written, without the whitespace and comments between its tokens. */
export const tokensText = (n: unknown, src: (n: Spanned) => string): string => {
  const parts = (n as { identOrDots?: { text: string }[] } | undefined)?.identOrDots
  if (Array.isArray(parts)) return parts.map((t) => t.text).join("")
  return src(n as Spanned).replace(TRIVIA, "")
}

const COMMENT_KEYS = new Set(["leadingComments", "trailingComments", "leadingDetachedComments"])

/** Token range of a node without its attached comments (protoc spans start at the first token). */
export const tokenRange = (n: Span | undefined): [number, number] | undefined => {
  if (!n || typeof n.start !== "number") return undefined
  if (!("leadingComments" in n) && !("trailingComments" in n)) return [n.start, n.end]
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  const children = n as unknown as Record<string, unknown>
  for (const k in children) {
    const v = children[k]
    // buf starts a message / enum span after the edition 2024 `export` / `local` keyword
    if (!v || typeof v !== "object" || COMMENT_KEYS.has(k) || k === "visibility") continue
    const items = Array.isArray(v) ? v : [v]
    for (const it of items as (Span & { type?: string })[]) {
      if (!it || typeof it.start !== "number" || it.type === "comment-group") continue
      const r = tokenRange(it)
      if (!r) continue
      if (r[0] < start) start = r[0]
      if (r[1] > end) end = r[1]
    }
  }
  return Number.isFinite(start) ? [start, end] : [n.start, n.end]
}

/** Comment groups in protoc's SourceCodeInfo text form, one paragraph per group. */
export const groupsText = (groups: CommentGroup[] | undefined): string | undefined => {
  if (!groups?.length) return undefined
  return groups.map((g) => protocGroupText((g.comments ?? []).map((c) => c.text))).join("\n")
}

/** The leading (the group nearest to the statement) and trailing comments of a statement. */
export const commentsOf = (n: StatementBase): MComments => {
  const leading = n.leadingComments?.length ? groupsText([n.leadingComments[n.leadingComments.length - 1]]) : undefined
  const trailing = groupsText(n.trailingComments)
  return { leading, trailing }
}

/** The options of a `[...]` list, without the commas. */
export const fieldOptionList = (n: FieldOptions | undefined): FieldOption[] =>
  (n?.fieldOptionOrCommas ?? []).filter((x): x is FieldOption => x.type === "field-option")
