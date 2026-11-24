// Writing document elements: the field key order, the common keys of a declaration, type references, the blocks messages and enums share, and the end of an element's lowering (annotation issues, source map entries, pending issues).

import type { ProtoApiTypeRef } from "../types.ts"
import type { MEnum, MFile, MMessage, MTypeRef, OptionTree } from "../model.ts"
import type { AnnotationResult } from "../conventions/types.ts"
import { type ResolvedFeatures, featuresOf } from "../features.ts"
import { ptr } from "../paths.ts"
import { enumPointer, messagePointer } from "../common/names.ts"
import type { LowerContext } from "./context.ts"
import type { ElementEntries, MappedElement } from "./sourcemap.ts"

// ---- key order ---------------------------------------------------------------------------------------------------

const FIELD_KEY_ORDER = [
  "title",
  "file",
  "description",
  "deprecation",
  "extendee",
  "number",
  "type",
  "$ref",
  "items",
  "additionalProperties",
  "propertyNames",
  "presence",
  "oneof",
  "jsonName",
  "default",
  "delimited",
  "packed",
  "utf8Validation",
  "required",
  "format",
  "readOnly",
  "writeOnly",
  "immutable",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "enum",
  "const",
  "examples",
  "options",
  "x-default",
  "x-annotation-conflicts",
]
const FIELD_RANK = new Map(FIELD_KEY_ORDER.map((k, i) => [k, i]))

/** The keys of a field (or of a field's `items` / map schema) in the format's key order; other keys follow as set. */
export const orderKeys = <T extends object>(o: T): T => {
  const src = o as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of FIELD_KEY_ORDER) if (src[k] !== undefined) out[k] = src[k]
  for (const k in src) if (!FIELD_RANK.has(k) && src[k] !== undefined) out[k] = src[k]
  return out as T
}

// ---- common keys -------------------------------------------------------------------------------------------------

/** The title, description and deprecation the annotation layer gives an element, in that key order. */
export const docKeywords = (out: Record<string, unknown>, a: AnnotationResult) => {
  if (a.title !== undefined) out.title = a.title
  if (a.description) out.description = a.description
  if (a.deprecation) out.deprecation = a.deprecation
}

/** The common keys of a declaration: `title`, `file`, then `description` and `deprecation` (§7 key order). */
export const head = (cx: LowerContext, name: string, file: MFile, ann: AnnotationResult): Record<string, unknown> => {
  const out: Record<string, unknown> = { title: name }
  if (cx.useFiles) out.file = file.path
  docKeywords(out, ann)
  return out
}

// ---- type references ---------------------------------------------------------------------------------------------

export const refOf = (t: MTypeRef): string => {
  if (t.kind === "named") {
    if (t.resolved) return t.resolved.kind === "enum" ? enumPointer(t.resolved.fqn) : messagePointer(t.resolved.fqn)
    const key = t.unresolvedKey ?? t.name.replace(/^\./, "")
    return t.hint === "enum" ? enumPointer(key) : messagePointer(key)
  }
  return ""
}

export const typeRef = (t: MTypeRef): ProtoApiTypeRef => {
  if (t.kind === "scalar") return { type: t.scalar }
  return { $ref: refOf(t) }
}

// ---- blocks of messages and enums --------------------------------------------------------------------------------

/** Sort and merge inclusive intervals (D8); adjacent intervals merge. */
export const mergeRanges = (ranges: [number, number][]): [number, number][] => {
  const sorted = ranges.map((r): [number, number] => [r[0], r[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push(r)
  }
  return out
}

export interface Reserved {
  /** merged intervals */
  numbers: [number, number][]
  /** distinct names, sorted */
  names: string[]
}

/** The reserved numbers and names of a message or enum as the document writes them. */
export const reservedOf = (el: MMessage | MEnum): Reserved => ({
  numbers: mergeRanges(el.reservedRanges),
  names: [...new Set(el.reservedNames)].sort(),
})

/** `reserved` of a message or enum, when it reserves anything, with its source map entries. */
export const writeReserved = (
  cx: LowerContext,
  out: Record<string, unknown>,
  pointer: string,
  el: MMessage | MEnum,
  { numbers, names }: Reserved,
) => {
  if (!numbers.length && !names.length) return
  const r: Record<string, unknown> = {}
  if (numbers.length) r.numbers = numbers
  if (names.length) r.names = names
  out.reserved = r
  cx.sourceMap.map(`${pointer}/reserved`, el.locs.reserved ?? el.locs.reservedNames)
  cx.sourceMap.mapReserved(pointer, el, numbers, names)
}

/** `jsonFormat` of a message or enum (a resolved feature, F-3), pointing at its own `features` option when it sets it. */
export const writeJsonFormat = (
  cx: LowerContext,
  out: Record<string, unknown>,
  pointer: string,
  features: ResolvedFeatures,
  options: OptionTree,
  el: MMessage | MEnum,
) => {
  if (!features.json_format || features.json_format === "ALLOW") return
  out.jsonFormat = features.json_format
  if (featuresOf(options)?.json_format !== undefined) cx.sourceMap.map(`${pointer}/jsonFormat`, el.optionLocs.features)
}

/** `options` of a message or enum: the annotation layer's rest, then `more`, then the `export` / `local` visibility. */
export const declarationOptions = (
  out: Record<string, unknown>,
  ann: AnnotationResult,
  visibility: MMessage["visibility"],
  more?: OptionTree,
) => {
  const options: Record<string, unknown> = { ...ann.options, ...more }
  if (visibility) options.visibility = visibility
  if (Object.keys(options).length) out.options = options
}

// ---- the end of an element -----------------------------------------------------------------------------------------

/** The `deprecation` keyword is written from the `deprecated` option (OneofOptions has none). */
export const DEPRECATED: Record<string, string> = { deprecation: "deprecated" }

/** The issues of an annotation result: invalid tags, convention options that do not fit, conflicts (A-15). */
const annotationIssues = (
  cx: LowerContext,
  ann: AnnotationResult,
  what: string,
  file: MFile,
  pointer: string,
  holder: MappedElement,
) => {
  for (const t of ann.invalidTags)
    cx.issue("invalid-tag", `invalid comment tag ${t} (${what})`, file, pointer, holder.locs[""])
  for (const o of ann.invalidOptions)
    cx.issue(
      "invalid-option",
      `${o.message} (${what})`,
      file,
      `${pointer}/options/${ptr(o.key)}`,
      holder.optionLocs[o.key] ?? holder.locs[""],
    )
  ann.conflicts.forEach((c, i) =>
    cx.issue(
      "annotation-conflict",
      `${what}: ${c.keyword} from ${c.kept.source} (${JSON.stringify(c.kept.value)}) is kept, ${c.dropped.source} (${JSON.stringify(c.dropped.value)}) is dropped`,
      file,
      `${pointer}/x-annotation-conflicts/${i}`,
      holder.locs[""],
    ),
  )
}

/** The annotation conflicts of an element (`x-annotation-conflicts`, its last key) and the annotation issues. */
export const reportAnnotations = (
  cx: LowerContext,
  out: Record<string, unknown>,
  ann: AnnotationResult,
  what: string,
  file: MFile,
  pointer: string,
  el: MappedElement,
) => {
  if (ann.conflicts.length) out["x-annotation-conflicts"] = ann.conflicts
  annotationIssues(cx, ann, what, file, pointer, el)
}

/** The source map entries of a complete element (`SourceMapWriter.mapElement`), then its pending issues. */
export const emitElement = (
  cx: LowerContext,
  out: Record<string, unknown>,
  ann: AnnotationResult,
  file: MFile,
  pointer: string,
  el: MappedElement,
  entries: ElementEntries,
) => {
  cx.sourceMap.mapElement(pointer, el, ann, out, entries)
  cx.flush(el, pointer, file, el.locs[""])
}

/** The end of an element's lowering: conflicts, annotation issues, its source map entries, its pending issues. */
export const finish = (
  cx: LowerContext,
  out: Record<string, unknown>,
  ann: AnnotationResult,
  what: string,
  file: MFile,
  pointer: string,
  el: MappedElement,
  entries: ElementEntries,
) => {
  reportAnnotations(cx, out, ann, what, file, pointer, el)
  emitElement(cx, out, ann, file, pointer, el, entries)
}
