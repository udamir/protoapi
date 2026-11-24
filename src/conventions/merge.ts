// The merge of keyword candidates: sources in precedence order (D13), first wins, 64-bit bounds normalised, conflicts recorded, and the kept keywords written into the annotation result.

import type { AnnotationSource } from "../types.ts"
import { INT64_KINDS } from "../values/scalars.ts"
import { DECIMAL } from "./rules.ts"
import { type AnnotationResult, type Candidate, type FieldShape, slotOf } from "./types.ts"

/** The sources in precedence order (D13): built-in options first, comment tags and prefixes last. */
const SOURCE_ORDER: AnnotationSource[] = [
  "option",
  "google.api",
  "buf.validate",
  "validate.rules",
  "openapiv2",
  "tag",
  "prefix",
]

const KEYWORDS_64 = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"])

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Keep one candidate per position and keyword (sorts `candidates`), recording conflicts and origins in `result`. */
export const mergeCandidates = (candidates: Candidate[], shape: FieldShape | undefined, result: AnnotationResult) => {
  candidates.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))
  const won = new Map<string, Candidate>()
  for (const c of candidates) {
    const slot = slotOf(shape, c.target)
    let value = c.value
    if (KEYWORDS_64.has(c.keyword) && slot?.scalar) {
      // 64-bit bounds are decimal strings (D7); other bounds are numbers, except the non-finite and `-0` strings of
      // float rules (A-2: never a JSON null)
      if (INT64_KINDS.has(slot.scalar)) value = typeof value === "number" ? String(value) : value
      else if (typeof value === "string" && DECIMAL.test(value)) value = Number(value)
    }
    const key = `${c.target}|${c.keyword}`
    const prev = won.get(key)
    if (!prev) {
      won.set(key, { ...c, value })
      continue
    }
    if (c.keyword === "examples") {
      prev.value = [...(prev.value as unknown[]), ...(value as unknown[])]
      continue
    }
    if (sameValue(prev.value, value) || (prev.source === c.source && c.source !== "tag")) continue
    if ((prev.source === "tag" || prev.source === "prefix") && (c.source === "tag" || c.source === "prefix")) continue
    result.conflicts.push({
      keyword: c.target ? `${c.target}.${c.keyword}` : c.keyword,
      kept: { source: prev.source, value: prev.value },
      dropped: { source: c.source, value },
    })
  }
  for (const c of won.values()) {
    if (c.value !== false)
      result.origins.push({
        target: c.target,
        keyword: c.keyword,
        source: c.source,
        ...(c.option ? { option: c.option } : {}),
        ...(c.comment ? { comment: c.comment } : {}),
      })
    // annotation-level requiredness is the field keyword (S1); `OPTIONAL` (false) only wins against the other sources
    if (c.keyword === "required" && c.value !== true) continue
    if (c.keyword === "title") {
      result.title = String(c.value)
      continue
    }
    if (c.keyword === "x-default") {
      result.xDefault = c.value
      continue
    }
    result.keywords[c.target][c.keyword] = c.value
  }
}
