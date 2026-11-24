// Comment tag conventions (`@Minimum 1`, `@Example {...}`): tag names and their renames, the value parser of each tag, and the inverse tables the printer writes tags with (tag per keyword, tag spelling).

import type { BuildOptions, PrintOptions, ProtoScalar, TagName } from "../types.ts"
import { INT64_KINDS } from "../values/scalars.ts"
import { isPlainObject } from "../common/objects.ts"
import { type VType, fromScalarText } from "../options/scalar.ts"
import { DECIMAL, DIGITS, NUMERIC_RULES } from "./rules.ts"
import {
  type Candidate,
  type CommentLine,
  type FieldShape,
  type Slot,
  shapeKind,
  slotOf,
  valueTarget,
} from "./types.ts"

const TAG_ALIASES: Record<TagName, string[]> = {
  default: ["Default"],
  example: ["Example"],
  required: ["Required"],
  minimum: ["Minimum", "Min"],
  maximum: ["Maximum", "Max"],
  exclusiveMinimum: ["ExclusiveMinimum"],
  exclusiveMaximum: ["ExclusiveMaximum"],
  multipleOf: ["MultipleOf"],
  pattern: ["Pattern"],
  minLength: ["MinLength"],
  maxLength: ["MaxLength"],
  minItems: ["MinItems"],
  maxItems: ["MaxItems"],
  format: ["Format"],
  enum: ["Enum"],
  readOnly: ["ReadOnly"],
  writeOnly: ["WriteOnly"],
  deprecated: ["Deprecated"],
  title: ["Title"],
}

const FIELD_ONLY_TAGS = new Set<TagName>([
  "default",
  "example",
  "required",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "format",
  "enum",
  "readOnly",
  "writeOnly",
])

/** value tags that move to `items` on repeated fields and to `additionalProperties` on maps */
const VALUE_TAGS = new Set<TagName>([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "enum",
  "minLength",
  "maxLength",
])

/** Value keywords: read back at `items` / `additionalProperties` for repeated and map fields (spec §3.2 Field). */
export const VALUE_KEYWORDS = new Set<string>([...VALUE_TAGS, "const"])

// ---- tag names --------------------------------------------------------------------------------------------------------

interface TagTable {
  /** lower-cased tag name -> tag */
  names: Map<string, TagName>
  /** renames that took another tag's name */
  collisions: string[]
}

const tagTables = new WeakMap<object, TagTable>()
let defaultTagTable: TagTable | undefined

export const tagTable = (tags: BuildOptions["tags"]): TagTable => {
  if (!tags) return (defaultTagTable ??= buildTagTable(undefined))
  let t = tagTables.get(tags)
  if (!t) tagTables.set(tags, (t = buildTagTable(tags)))
  return t
}

/** Tag names: the default aliases of the tags not renamed or disabled, then the renames, which win a collision. */
const buildTagTable = (tags: BuildOptions["tags"]): TagTable => {
  const names = new Map<string, TagName>()
  const collisions: string[] = []
  const entries = Object.entries(TAG_ALIASES) as [TagName, string[]][]
  for (const [name, aliases] of entries) {
    if (tags?.[name] !== undefined) continue
    for (const a of aliases) names.set(a.toLowerCase(), name)
  }
  for (const [name] of entries) {
    const rename = tags?.[name]
    if (typeof rename !== "string") continue
    const key = rename.replace(/^@/, "").toLowerCase()
    const other = names.get(key)
    if (other !== undefined && other !== name)
      collisions.push(
        `tags.${name} renames the tag to @${rename.replace(/^@/, "")}, which is also a name of the ${other} tag; @${rename.replace(/^@/, "")} now means ${name}`,
      )
    names.set(key, name)
  }
  return { names, collisions }
}

/** The `BuildOptions.tags` renames that collide with another tag's name (one `invalid-tag` issue each). */
export const tagCollisions = (tags: BuildOptions["tags"]): string[] => (tags ? tagTable(tags).collisions : [])

/** Tag name -> spelling the builder recognises with the same `tags` option, or undefined when it is disabled. */
export type TagSpelling = (t: TagName) => string | undefined

/** The printer's tag spelling for the `tags` print option: a rename, else the default name (the first alias). */
export const tagSpelling = (tags: PrintOptions["tags"]): TagSpelling | undefined => {
  if (tags === false) return undefined
  const map = isPlainObject(tags) ? (tags as Partial<Record<TagName, string | false>>) : {}
  const renamed = new Set<string>()
  for (const v of Object.values(map)) if (typeof v === "string") renamed.add(v.replace(/^@/, "").toLowerCase())
  return (t) => {
    const r = map[t]
    if (r === false) return undefined
    if (typeof r === "string") return r.replace(/^@/, "")
    // a default name another tag was renamed to now means that tag
    const name = TAG_ALIASES[t][0]
    return renamed.has(name.toLowerCase()) ? undefined : name
  }
}

// ---- tag values -----------------------------------------------------------------------------------------------------

/** A JSON value without `null` or non-finite numbers (a document never holds them, spec §3.6). */
const jsonSafe = (v: unknown): boolean => {
  if (v === null) return false
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0)
  if (Array.isArray(v)) return v.every(jsonSafe)
  if (isPlainObject(v)) return Object.values(v).every(jsonSafe)
  return true
}

/** JSON if the text parses to a value a document can hold, else the trimmed text. */
export const jsonish = (v: string): unknown => {
  const t = v.trim()
  try {
    const x = JSON.parse(t)
    return jsonSafe(x) ? x : t
  } catch {
    return t
  }
}

/** `a, "b,c", 'd'` -> `["a", "b,c", "d"]`: commas inside quotes do not split, quotes are removed. */
const splitList = (v: string): string[] => {
  const parts: string[] = []
  let cur = ""
  let quote = ""
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]
    if (quote) {
      cur += ch
      if (ch === "\\" && i + 1 < v.length) cur += v[++i]
      else if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    if (ch === ",") {
      parts.push(cur)
      cur = ""
    } else cur += ch
  }
  parts.push(cur)
  return parts
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
        try {
          const x = JSON.parse(s)
          if (typeof x === "string") return x
        } catch {
          // fall through: strip the quotes
        }
        return s.slice(1, -1)
      }
      if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1)
      return s
    })
}

/**
 * `@Enum` items in the canonical form of the field type (spec §3.6): strings as written; numbers and enum values as protobuf constants, canonical like option values (64-bit integers as decimal strings, `float` narrowed, an enum number named by its value when the enum has one). Returns the reason when an item does not fit.
 */
const enumTagValues = (items: string[], slot: Slot): unknown[] | string => {
  if (slot.scalar === "string") return items
  const t: VType = slot.enumDef
    ? { kind: "enum", def: slot.enumDef }
    : { kind: "scalar", scalar: slot.scalar as ProtoScalar }
  const out: unknown[] = []
  for (const it of items) {
    const v = fromScalarText(it, false, t)
    if (!v.ok) return v.reason
    out.push(v.value)
  }
  return out
}

const TAG_RE = /^@([A-Za-z][A-Za-z0-9_]*)\s*:?\s*(.*)$/
/** non-negative decimal integer of a length or count tag */
const COUNT = /^\d+$/

/** The kind of value a tag takes, which decides how it is parsed and printed. */
type TagKind =
  | "json" // one JSON value (`@Default`)
  | "example" // one JSON value per tag, collected into `examples`
  | "flag" // no value, `true` or `false`
  | "bound" // a decimal number; on 64-bit fields decimal integer digits
  | "count" // a non-negative integer
  | "itemCount" // a non-negative integer on repeated fields; on maps it counts entries
  | "text" // one line of text
  | "format" // one line of text, on string fields only
  | "enumList" // a comma-separated list of the field's values
  | "deprecation" // `@Deprecated [reason]`

const TAG_KINDS: Record<TagName, TagKind> = {
  default: "json",
  example: "example",
  required: "flag",
  minimum: "bound",
  maximum: "bound",
  exclusiveMinimum: "bound",
  exclusiveMaximum: "bound",
  multipleOf: "bound",
  pattern: "text",
  minLength: "count",
  maxLength: "count",
  minItems: "itemCount",
  maxItems: "itemCount",
  format: "format",
  enum: "enumList",
  readOnly: "flag",
  writeOnly: "flag",
  deprecated: "deprecation",
  title: "text",
}

/** The keyword of a tag when it is not the tag name. */
const TAG_KEYWORD: Partial<Record<TagName, string>> = { default: "x-default", example: "examples" }
/** The keyword of a count tag on a map. */
const ENTRY_COUNT: Partial<Record<TagName, string>> = { minItems: "minProperties", maxItems: "maxProperties" }
/** What a text tag without a value reports. */
const TEXT_EXPECTED: Partial<Record<TagName, string>> = {
  pattern: "a regular expression is expected",
  title: "a title is expected",
}

/** One tag occurrence as its parser sees it. */
interface TagValue {
  tag: TagName
  /** the keyword the tag sets */
  keyword: string
  /** the text after the tag name, trimmed */
  value: string
  /** the position the tag describes (value tags: the value position of the field) */
  slot: Slot | undefined
  shape: FieldShape | undefined
  /** propose `keyword` at the tag's position */
  push: (keyword: string, value: unknown) => void
  /** report the tag as invalid */
  bad: (why: string) => void
  /** `@Deprecated`, with the tag value as the reason */
  deprecate: () => void
}

/** boolean tags: no value, `true` or `false` */
const flag = (t: TagValue): boolean | undefined => {
  if (t.value === "" || t.value === "true") return true
  if (t.value === "false") return false
  t.bad("true or false is expected")
  return undefined
}

const isCount = (value: string) => COUNT.test(value) && Number.isSafeInteger(Number(value))

const TAG_PARSERS: Record<TagKind, (t: TagValue) => void> = {
  json: (t) => {
    if (t.value === "") t.bad("a value is expected")
    else t.push(t.keyword, jsonish(t.value))
  },
  example: (t) => {
    if (t.value === "") t.bad("a value is expected")
    else t.push(t.keyword, [jsonish(t.value)])
  },
  flag: (t) => {
    if (flag(t)) t.push(t.keyword, true)
  },
  bound: (t) => {
    // decimal numbers only; on 64-bit fields decimal integer digits, kept exact as a string
    if (t.slot?.scalar && INT64_KINDS.has(t.slot.scalar)) {
      if (!DIGITS.test(t.value)) t.bad("decimal integer digits are expected on a 64-bit field")
      else t.push(t.keyword, BigInt(t.value).toString())
      return
    }
    const n = Number(t.value)
    if (!DECIMAL.test(t.value) || !Number.isFinite(n)) t.bad("a finite decimal number is expected")
    else t.push(t.keyword, n === 0 ? 0 : n)
  },
  count: (t) => {
    if (!isCount(t.value)) t.bad("a non-negative integer is expected")
    else t.push(t.keyword, Number(t.value))
  },
  itemCount: (t) => {
    // on a map they count entries; on a singular field they do not apply
    if (!isCount(t.value)) t.bad("a non-negative integer is expected")
    else if (t.shape?.map) t.push(ENTRY_COUNT[t.tag] as string, Number(t.value))
    else if (t.shape?.repeated) t.push(t.keyword, Number(t.value))
    else t.bad("applies to repeated and map fields only")
  },
  // `@Title` is a candidate like the option sources, so openapiv2 titles win (spec §3.8 precedence); not empty
  text: (t) => {
    if (t.value === "") t.bad(TEXT_EXPECTED[t.tag] as string)
    else t.push(t.keyword, t.value)
  },
  format: (t) => {
    if (t.slot?.scalar !== "string") t.bad("applies to string fields only")
    else if (t.value === "") t.bad("a value is expected")
    else t.push(t.keyword, t.value)
  },
  enumList: (t) => {
    // string, numeric and enum fields (protovalidate `in` printed without its import)
    const items = t.value === "" ? [] : splitList(t.value)
    const slot = t.slot
    if (!slot?.enumDef && !(slot?.scalar && (slot.scalar === "string" || NUMERIC_RULES.has(slot.scalar))))
      t.bad("applies to string, numeric and enum fields only")
    else if (!items.length) t.bad("a value is expected")
    else {
      const values = enumTagValues(items, slot)
      if (typeof values === "string") t.bad(values)
      else t.push(t.keyword, values)
    }
  },
  deprecation: (t) => t.deprecate(),
}

/** The kind of value a keyword's tag takes when printed (`entryCount`: `@MinItems` / `@MaxItems` of a map). */
export type TagPrintKind = Exclude<TagKind, "deprecation"> | "entryCount"

/** TAG_KINDS inverted: keyword -> the tag that prints it and its kind. `@Required` prints through the requiredness chain of the printer and `@Deprecated` as the `Deprecated:` line, so neither is listed. */
export const TAG_OF_KEYWORD: Record<string, [TagName, TagPrintKind]> = (() => {
  const out: Record<string, [TagName, TagPrintKind]> = {}
  for (const [tag, kind] of Object.entries(TAG_KINDS) as [TagName, TagKind][]) {
    if (tag === "required" || kind === "deprecation") continue
    out[TAG_KEYWORD[tag] ?? tag] = [tag, kind]
    const entries = ENTRY_COUNT[tag]
    if (entries) out[entries] = [tag, "entryCount"]
  }
  return out
})()

// ---- lift -----------------------------------------------------------------------------------------------------------

/** What lifting the tags of an element needs. */
export interface TagLift {
  /** lower-cased tag name -> tag (`tagTable(tags).names`) */
  names: Map<string, TagName>
  isField: boolean
  shape: FieldShape | undefined
  out: Candidate[]
  /** invalid tags, as `@Tag value: reason` */
  invalid: string[]
  /** `@Deprecated` on comment line `comment`, with the tag value ("" when none) */
  deprecate: (comment: CommentLine, reason: string) => void
}

/** Lift the tags of comment lines into candidates (each with its comment line); returns the lines that are not tags. */
export const liftTags = (lines: string[], trailing: boolean, lift: TagLift): string[] => {
  const kept: string[] = []
  for (const line of lines) {
    const comment: CommentLine = { text: line, trailing }
    const before = lift.out.length
    liftTag(line, comment, kept, lift)
    for (let i = before; i < lift.out.length; i++) lift.out[i].comment = comment
  }
  return kept
}

const liftTag = (line: string, comment: CommentLine, kept: string[], lift: TagLift) => {
  const m = TAG_RE.exec(line.trim())
  const tag = m ? lift.names.get(m[1].toLowerCase()) : undefined
  if (!m || !tag || (!lift.isField && FIELD_ONLY_TAGS.has(tag))) {
    kept.push(line)
    return
  }
  const value = m[2].trim()
  const target = VALUE_TAGS.has(tag) ? valueTarget(shapeKind(lift.shape)) : ""
  TAG_PARSERS[TAG_KINDS[tag]]({
    tag,
    keyword: TAG_KEYWORD[tag] ?? tag,
    value,
    slot: slotOf(lift.shape, target),
    shape: lift.shape,
    push: (keyword, v) => lift.out.push({ target, keyword, value: v, source: "tag" }),
    bad: (why) => lift.invalid.push(`@${m[1]}${value ? ` ${value}` : ""}: ${why}`),
    deprecate: () => lift.deprecate(comment, value),
  })
}
