// AIP comment prefixes (`Required.`, `Output only.`, …) and the `Deprecated:` line on the first line of a description, lifted into keywords, and the prefix per keyword the printer writes back.

import { FIELD_BEHAVIOR } from "./keys.ts"
import type { Candidate, CommentLine } from "./types.ts"

const PREFIX_RE = /^(Required|Optional|Output only|Input only|Immutable|Identifier)\.(\s+|$)/
const DEPRECATED_RE = /^Deprecated:\s*(.*)$/

/** AIP prefixes that lift, with the keyword each sets to `true` (`Optional.` is dropped, `Identifier.` adds IDENTIFIER to field_behavior). */
const PREFIX_KEYWORDS: Record<string, string> = {
  Required: "required",
  "Output only": "readOnly",
  "Input only": "writeOnly",
  Immutable: "immutable",
}

/** PREFIX_KEYWORDS inverted: keyword -> the prefix as printed. */
export const PREFIX_OF_KEYWORD: Record<string, string> = Object.fromEntries(
  Object.entries(PREFIX_KEYWORDS).map(([prefix, keyword]) => [keyword, `${prefix}.`]),
)

/** The prefix that stands for field_behavior IDENTIFIER. */
export const IDENTIFIER_PREFIX = "Identifier."

/** What lifting the prefixes of an element needs. */
export interface PrefixLift {
  isField: boolean
  /** the element's options (`Identifier.` adds to field_behavior) */
  options: Record<string, unknown>
  out: Candidate[]
  /** a `Deprecated:` line on comment line `comment`, with its reason ("" when none) */
  deprecate: (comment: CommentLine, reason: string) => void
}

/** Item 10: AIP prefixes and the `Deprecated:` line apply to the description as a whole (leading comment, or the trailing comment when there is no leading text), so a printed description reads the same. `lines` are the comment lines left after the tags, the first `leading` of them from the leading comment; the lifted parts are removed. */
export const liftPrefixes = (lines: string[], leading: number, lift: PrefixLift) => {
  const first = lines.findIndex((l) => l.trim() !== "")
  if (first < 0) return
  const comment: CommentLine = { text: lines[first], trailing: first >= leading }
  const before = lift.out.length
  if (lift.isField) {
    // prefixes stack ("Input only. Immutable. …"), as googleapis writes them
    for (let p = PREFIX_RE.exec(lines[first]); p; p = PREFIX_RE.exec(lines[first])) {
      const prefix = p[1]
      lines[first] = lines[first].slice(p[0].length)
      const keyword = PREFIX_KEYWORDS[prefix]
      if (keyword) lift.out.push({ target: "", keyword, value: true, source: "prefix" })
      else if (prefix === "Identifier") {
        const options = lift.options
        const fb = Array.isArray(options[FIELD_BEHAVIOR]) ? (options[FIELD_BEHAVIOR] as unknown[]) : []
        if (!fb.includes("IDENTIFIER")) options[FIELD_BEHAVIOR] = [...fb, "IDENTIFIER"]
      }
    }
  }
  for (let i = before; i < lift.out.length; i++) lift.out[i].comment = comment
  const d = DEPRECATED_RE.exec(lines[first])
  if (d) {
    lift.deprecate(comment, d[1].trim())
    lines[first] = ""
  }
}
