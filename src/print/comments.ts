// Comment lines of printed elements: the `Deprecated:` line, the description, comment tags (`@Title`, …) in the spelling of the `tags` print option. Without a tag spelling (`tags: false`) no comment annotation is printed.

import type { ProtoApiElement, ProtoApiField, TagName } from "../types.ts"
import type { TagSpelling } from "../conventions/tags.ts"
import type { FieldPlan } from "./annotations.ts"

/** The comment line of tag `t` (with `value`), or undefined when the tag is disabled. */
export const tagLine = (tag: TagSpelling | undefined, t: TagName, value?: string): string | undefined => {
  const name = tag?.(t)
  if (!name) return undefined
  return value === undefined ? `@${name}` : `@${name} ${value}`
}

/**
 * Comment lines of an element: the `Deprecated:` line (first: it is read from the first line only, spec §3.8), the description, `@Title`, then `extra`. `bareDeprecated`: deprecation without a reason prints as a bare `Deprecated:` line (oneofs have no `deprecated` option).
 */
export const elementComment = (
  tag: TagSpelling | undefined,
  e: ProtoApiElement,
  defaultTitle: string | undefined,
  extra: string[] = [],
  bareDeprecated = false,
): string[] => {
  const out: string[] = []
  if (tag && e.deprecation?.reason) out.push(`Deprecated: ${e.deprecation.reason}`)
  else if (tag && e.deprecation && bareDeprecated) out.push("Deprecated:")
  if (typeof e.description === "string" && e.description) out.push(e.description)
  if (typeof e.title === "string" && e.title !== defaultTitle) {
    const t = tagLine(tag, "title", e.title)
    if (t) out.push(t)
  }
  out.push(...extra)
  return out
}

/** Comment lines of a field: AIP prefixes and the `Deprecated:` line on the first line (they are read from the first line only, spec §3.8), the description, then the tags of the plan. */
export const fieldComment = (tag: TagSpelling | undefined, f: ProtoApiField, plan: FieldPlan): string[] => {
  const first: string[] = [...plan.prefixes]
  if (tag && f.deprecation?.reason) first.push(`Deprecated: ${f.deprecation.reason}`)
  const lines: string[] = []
  if (first.length) lines.push(first.join(" "))
  if (typeof f.description === "string" && f.description) lines.push(f.description)
  lines.push(...plan.tags)
  return lines
}
