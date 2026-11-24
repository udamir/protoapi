// Helpers over the parser's AST nodes (pbkit AST) shared by the text front end, the text checks and the option
// interpreter: the structural node views they read, option name segments and the text of a dotted name.

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

/** A dotted name node as written, without the whitespace and comments between its tokens (C-15). */
export const tokensText = (n: unknown, src: (n: Spanned) => string): string => {
  const parts = (n as { identOrDots?: { text: string }[] } | undefined)?.identOrDots
  if (Array.isArray(parts)) return parts.map((t) => t.text).join("")
  return src(n as Spanned).replace(TRIVIA, "")
}
