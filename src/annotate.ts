// Annotation layer (design §3.8, D13, D14): comment tags, AIP prefixes and convention options lifted into
// JSON Schema keywords, with precedence built-in -> google.api -> buf.validate -> validate.rules -> openapiv2 ->
// comment tags / prefixes, and conflicts recorded.

import type { AnnotationConflict, AnnotationSource, BuildOptions, ProtoScalar, TagName } from "./types.ts"
import type { MEnum } from "./model.ts"
import { normalizeComment } from "./comments.ts"
import { INT64_KINDS } from "./values/scalars.ts"
import { isPlainObject } from "./common/objects.ts"
import { INVALID, type VType, fromScalarText, lastInvalidReason } from "./options.ts"

export type Target = "" | "items" | "propertyNames" | "additionalProperties"

/** What the annotation layer needs to know about a position (field, items, map key, map value). */
export interface Slot {
  scalar?: ProtoScalar
  enumDef?: MEnum
  message?: boolean
  /** the message type of a message slot, when resolved */
  messageFqn?: string
  /** the wrapper well-known type a `scalar` slot comes from (`google.protobuf.StringValue`): wrappers take the tags
   *  and rules of their scalar (A-11, decision 6) */
  wrapper?: string
}

export interface FieldShape {
  self: Slot
  repeated?: Slot
  map?: { key: Slot; value: Slot }
}

export interface AnnotationInput {
  kind: "field" | "message" | "enum" | "enumValue" | "service" | "method" | "oneof" | "file"
  leading?: string
  trailing?: string
  /** typed options of the element (mutated copy: lifted parts removed) */
  options: Record<string, unknown>
  shape?: FieldShape
  mode: NonNullable<BuildOptions["annotations"]>
  tags?: BuildOptions["tags"]
  /** keywords set on the element by an enclosing one (`openapiv2_schema.json_schema.required` of the message, A-13) */
  extra?: { keyword: string; value: unknown; source: AnnotationSource; option?: string }[]
  /** messages: the field a `json_schema.required` entry names (proto name or JSON name), if any */
  fieldOf?: (name: string) => string | undefined
}

export interface AnnotationResult {
  description?: string
  title?: string
  deprecation?: { reason?: string }
  /** keywords per target ("" = the element itself) */
  keywords: Record<Target, Record<string, unknown>>
  xDefault?: unknown
  conflicts: AnnotationConflict[]
  /** invalid comment tags, each as `@Tag value: reason` */
  invalidTags: string[]
  /** convention options not lifted because they do not fit the element (A-11): the option key and the reason */
  invalidOptions: { key: string; message: string }[]
  /** messages: the fields `openapiv2_schema.json_schema.required` names (A-13) */
  requiredFields?: string[]
  /** options left after lifting */
  options: Record<string, unknown>
  /** where each kept keyword came from (validation L-3: keyword-level source-map entries) */
  origins: KeywordOrigin[]
  /** where `deprecation` came from */
  deprecationOrigin?: { source: AnnotationSource; comment?: CommentLine }
}

/** A comment line of the element: the normalised line text and whether it is part of the trailing comment. */
export interface CommentLine {
  text: string
  trailing: boolean
}

export interface KeywordOrigin {
  target: Target
  keyword: string
  source: AnnotationSource
  /** the option key the keyword was lifted from (option sources) */
  option?: string
  /** the comment line of a tag or prefix */
  comment?: CommentLine
}

interface Candidate {
  target: Target
  keyword: string
  value: unknown
  source: AnnotationSource
  option?: string
  comment?: CommentLine
}

/** The grpc-gateway openapiv2 package and its option names (shared by the lowering and the printer). */
export const OA = "grpc.gateway.protoc_gen_openapiv2.options."
export const OA_FIELD = `${OA}openapiv2_field`

/** The option key an option-sourced candidate was lifted from. */
const optionKeyOf = (c: Candidate, kind: AnnotationInput["kind"]): string | undefined => {
  switch (c.source) {
    case "google.api":
      return c.keyword === "format" ? "google.api.field_info" : "google.api.field_behavior"
    case "buf.validate":
      return "buf.validate.field"
    case "validate.rules":
      return "validate.rules"
    case "openapiv2":
      return kind === "message" ? OA_SCHEMA : OA_FIELD
    default:
      return undefined
  }
}
export const OA_SCHEMA = `${OA}openapiv2_schema`
export const OA_OPERATION = `${OA}openapiv2_operation`

// ---- comment tags -----------------------------------------------------------------------------------------------------

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

interface TagTable {
  /** lower-cased tag name -> tag */
  names: Map<string, TagName>
  /** renames that took another tag's name (A-14) */
  collisions: string[]
}

const tagTables = new WeakMap<object, TagTable>()
let defaultTagTable: TagTable | undefined

const tagTable = (tags: BuildOptions["tags"]): TagTable => {
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

/** The `BuildOptions.tags` renames that collide with another tag's name (one `invalid-tag` issue each, A-14). */
export const tagCollisions = (tags: BuildOptions["tags"]): string[] => (tags ? tagTable(tags).collisions : [])

/** A JSON value without `null` or non-finite numbers (a document never holds them, D7). */
const jsonSafe = (v: unknown): boolean => {
  if (v === null) return false
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0)
  if (Array.isArray(v)) return v.every(jsonSafe)
  if (isPlainObject(v)) return Object.values(v).every(jsonSafe)
  return true
}

/** JSON if the text parses to a value a document can hold, else the trimmed text. */
const jsonish = (v: string): unknown => {
  const t = v.trim()
  try {
    const x = JSON.parse(t)
    return jsonSafe(x) ? x : t
  } catch {
    return t
  }
}

/** `a, "b,c", 'd'` -> `["a", "b,c", "d"]`: commas inside quotes do not split, quotes are removed (A-14). */
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

const TAG_RE = /^@([A-Za-z][A-Za-z0-9_]*)\s*:?\s*(.*)$/
const PREFIX_RE = /^(Required|Optional|Output only|Input only|Immutable|Identifier)\.(\s+|$)/
const DEPRECATED_RE = /^Deprecated:\s*(.*)$/

/** decimal number literal of a bound tag (no hexadecimal, no `Infinity`, A-1) */
const DECIMAL = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
/** decimal integer digits of a 64-bit bound tag (A-6) */
const DIGITS = /^-?\d+$/
/** non-negative decimal integer of a length or count tag */
const COUNT = /^\d+$/

// ---- option lifting -------------------------------------------------------------------------------------------------

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

export const STRING_FORMATS: Record<string, string> = {
  email: "email",
  hostname: "hostname",
  ip: "ip",
  ipv4: "ipv4",
  ipv6: "ipv6",
  uri: "uri",
  uri_ref: "uri-reference",
  address: "address",
  uuid: "uuid",
  tuuid: "tuuid",
  ip_with_prefixlen: "ip_with_prefixlen",
  ipv4_with_prefixlen: "ipv4_with_prefixlen",
  ipv6_with_prefixlen: "ipv6_with_prefixlen",
  ip_prefix: "ip_prefix",
  ipv4_prefix: "ipv4_prefix",
  ipv6_prefix: "ipv6_prefix",
  host_and_port: "host_and_port",
}

export const NUMERIC_RULES = new Set<string>([
  "float",
  "double",
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
])

/** protovalidate / PGV rule families (the type-specific members of FieldRules / FieldRules in PGV) */
const RULE_FAMILIES = new Set([
  ...NUMERIC_RULES,
  "bool",
  "string",
  "bytes",
  "enum",
  "repeated",
  "map",
  "any",
  "duration",
  "timestamp",
  "field_mask",
  "message",
])

export const WKT_FAMILY: Record<string, string> = {
  "google.protobuf.Any": "any",
  "google.protobuf.Duration": "duration",
  "google.protobuf.Timestamp": "timestamp",
  "google.protobuf.FieldMask": "field_mask",
}

/** The rule families that fit a position, or undefined when its type is unknown (no check). PGV `message` rules
 *  apply to every message field (wrappers included); protovalidate has no message family. */
const expectedFamilies = (
  target: Target,
  slot: Slot,
  shape: FieldShape | undefined,
  source: AnnotationSource,
): string[] | undefined => {
  if (target === "" && shape?.repeated) return ["repeated"]
  if (target === "" && shape?.map) return ["map"]
  const pgvMessage = source === "validate.rules" ? ["message"] : []
  if (slot.scalar) return [slot.scalar, ...(slot.wrapper ? pgvMessage : [])]
  if (slot.enumDef) return ["enum"]
  if (slot.message && slot.messageFqn) {
    const w = WKT_FAMILY[slot.messageFqn]
    return w ? [w, ...pgvMessage] : pgvMessage
  }
  return undefined
}

const FIELD_INFO_FORMATS: Record<string, string> = { UUID4: "uuid", IPV4: "ipv4", IPV6: "ipv6", IPV4_OR_IPV6: "ip" }

const prune = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.length ? v : undefined
  if (!isPlainObject(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    const p = prune(x)
    if (p !== undefined) out[k] = p
  }
  return Object.keys(out).length ? out : undefined
}

const asNumber = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number))

/** `a > b` for canonical bound values (numbers, 64-bit decimal strings, `"Infinity"` strings). */
const greater = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string" && typeof b === "string" && DIGITS.test(a) && DIGITS.test(b)) return BigInt(a) > BigInt(b)
  return Number(a) > Number(b)
}

type Mismatch = (kind: string, expected: string[], target: Target) => void

/** Lift validation rules (protovalidate or PGV) for one position; returns the remainder. */
const liftRules = (
  rules: Record<string, unknown>,
  target: Target,
  slot: Slot,
  shape: FieldShape | undefined,
  source: AnnotationSource,
  out: Candidate[],
  mismatch: Mismatch,
): Record<string, unknown> => {
  const rest: Record<string, unknown> = {}
  const push = (keyword: string, value: unknown, t: Target = target) => out.push({ target: t, keyword, value, source })
  for (const [kind, raw] of Object.entries(rules)) {
    if (kind === "required" && target === "") {
      if (raw === true) push("required", true)
      else rest[kind] = raw
      continue
    }
    if (RULE_FAMILIES.has(kind) && isPlainObject(raw)) {
      // A-11: a rule family that does not match the field type stays raw (protovalidate: "mismatched rule type")
      const expected = expectedFamilies(target, slot, shape, source)
      if (expected && !expected.includes(kind)) {
        mismatch(kind, expected, target)
        rest[kind] = raw
        continue
      }
    }
    if (kind === "message" && source === "validate.rules" && isPlainObject(raw)) {
      const r = { ...raw }
      if (r.required === true && target === "") {
        push("required", true)
        delete r.required
      }
      if (Object.keys(r).length) rest[kind] = r
      continue
    }
    if (!isPlainObject(raw)) {
      rest[kind] = raw
      continue
    }
    const r: Record<string, unknown> = { ...raw }
    // A-13: protovalidate `<family>.example` values feed `examples`
    const examples = (map: (v: unknown) => unknown = (v) => v) => {
      if (!Array.isArray(r.example) || !r.example.length) return
      push("examples", r.example.map(map))
      delete r.example
    }
    if (NUMERIC_RULES.has(kind)) {
      const map: Record<string, string> = {
        gt: "exclusiveMinimum",
        gte: "minimum",
        lt: "exclusiveMaximum",
        lte: "maximum",
        const: "const",
        in: "enum",
      }
      // A-9 / D-D: a lower bound above the upper bound is protovalidate's / PGV's exclusive ("outside") range; the
      // bounds stay raw under options and no bound keyword is written
      const lower = "gt" in r ? r.gt : r.gte
      const upper = "lt" in r ? r.lt : r.lte
      const outside = lower !== undefined && upper !== undefined && greater(lower, upper)
      for (const [k, kw] of Object.entries(map))
        if (k in r && !(outside && k !== "const" && k !== "in")) {
          push(kw, r[k])
          delete r[k]
        }
      if (source === "buf.validate") examples()
    } else if (kind === "string" || kind === "bytes") {
      if ("min_len" in r) {
        push("minLength", asNumber(r.min_len))
        delete r.min_len
      }
      if ("max_len" in r) {
        push("maxLength", asNumber(r.max_len))
        delete r.max_len
      }
      if ("len" in r) {
        push("minLength", asNumber(r.len))
        push("maxLength", asNumber(r.len))
        delete r.len
      }
      if ("const" in r) {
        push("const", r.const)
        delete r.const
      }
      if ("in" in r) {
        push("enum", r.in)
        delete r.in
      }
      if (kind === "string") {
        if ("pattern" in r) {
          push("pattern", r.pattern)
          delete r.pattern
        } else {
          for (const k of ["prefix", "suffix", "contains"]) {
            if (!(k in r)) continue
            const s = escapeRegex(String(r[k]))
            push("pattern", k === "prefix" ? `^${s}` : k === "suffix" ? `${s}$` : s)
            delete r[k]
            break
          }
        }
        for (const [k, fmt] of Object.entries(STRING_FORMATS)) {
          if (r[k] === true) {
            push("format", fmt)
            delete r[k]
          }
        }
      }
      if (source === "buf.validate") examples()
    } else if (kind === "bool") {
      if ("const" in r) {
        push("const", r.const)
        delete r.const
      }
      if (source === "buf.validate") examples()
    } else if (kind === "enum") {
      if ("const" in r) {
        push("const", enumNameOf(slot.enumDef, r.const))
        delete r.const
      }
      if ("in" in r && Array.isArray(r.in)) {
        push(
          "enum",
          r.in.map((v) => enumNameOf(slot.enumDef, v)),
        )
        delete r.in
      }
      if (source === "buf.validate") examples((v) => enumNameOf(slot.enumDef, v))
    } else if (kind === "repeated" && target === "") {
      if ("min_items" in r) {
        push("minItems", asNumber(r.min_items))
        delete r.min_items
      }
      if ("max_items" in r) {
        push("maxItems", asNumber(r.max_items))
        delete r.max_items
      }
      if (r.unique === true) {
        push("uniqueItems", true)
        delete r.unique
      }
      if (isPlainObject(r.items) && shape?.repeated) {
        const remainder = liftRules(r.items, "items", shape.repeated, shape, source, out, mismatch)
        if (Object.keys(remainder).length) r.items = remainder
        else delete r.items
      }
    } else if (kind === "map" && target === "") {
      if ("min_pairs" in r) {
        push("minProperties", asNumber(r.min_pairs))
        delete r.min_pairs
      }
      if ("max_pairs" in r) {
        push("maxProperties", asNumber(r.max_pairs))
        delete r.max_pairs
      }
      if (isPlainObject(r.keys) && shape?.map) {
        const remainder = liftRules(r.keys, "propertyNames", shape.map.key, shape, source, out, mismatch)
        if (Object.keys(remainder).length) r.keys = remainder
        else delete r.keys
      }
      if (isPlainObject(r.values) && shape?.map) {
        const remainder = liftRules(r.values, "additionalProperties", shape.map.value, shape, source, out, mismatch)
        if (Object.keys(remainder).length) r.values = remainder
        else delete r.values
      }
    }
    if (Object.keys(r).length) rest[kind] = r
  }
  return rest
}

/**
 * `@Enum` items in the canonical form of the field type (decision 11): strings as written; numbers and enum values as
 * protobuf constants, canonical like option values (64-bit integers as decimal strings, `float` narrowed, an enum
 * number named by its value when the enum has one). Returns the reason when an item does not fit.
 */
const enumTagValues = (items: string[], slot: Slot): unknown[] | string => {
  if (slot.scalar === "string") return items
  const t: VType = slot.enumDef
    ? { kind: "enum", def: slot.enumDef }
    : { kind: "scalar", scalar: slot.scalar as ProtoScalar }
  const out: unknown[] = []
  for (const it of items) {
    const v = fromScalarText(it, false, t)
    if (v === INVALID) return lastInvalidReason()
    out.push(v)
  }
  return out
}

const enumNameOf = (def: MEnum | undefined, v: unknown): unknown => {
  if (typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v))) {
    const n = Number(v)
    return def?.values.find((x) => x.number === n)?.name ?? v
  }
  return v
}

/**
 * openapiv2_field. On a repeated field `min_items`, `max_items` and `unique_items` describe the array and the value
 * keywords go to `items`; on a map the value keywords go to `additionalProperties` and `min_items` / `max_items` become
 * `minProperties` / `maxProperties` (A-10, decisions 4 and 5). `title`, `read_only`, `example` and `default` stay on
 * the field, as the tags do.
 */
const liftOpenapi = (
  o: Record<string, unknown>,
  out: Candidate[],
  shape: FieldShape | undefined,
): Record<string, unknown> => {
  const r = { ...o }
  const valueTarget: Target = shape?.repeated ? "items" : shape?.map ? "additionalProperties" : ""
  const push = (keyword: string, value: unknown, t: Target = "") =>
    out.push({ target: t, keyword, value, source: "openapiv2" })
  const values: Record<string, string> = {
    pattern: "pattern",
    format: "format",
    min_length: "minLength",
    max_length: "maxLength",
    multiple_of: "multipleOf",
    enum: "enum",
  }
  if ("title" in r) {
    push("title", r.title)
    delete r.title
  }
  for (const [k, kw] of Object.entries(values)) {
    if (!(k in r)) continue
    const v = r[k]
    push(kw, kw === "minLength" || kw === "maxLength" ? asNumber(v) : v, valueTarget)
    delete r[k]
  }
  for (const [k, kw, mapKw] of [
    ["min_items", "minItems", "minProperties"],
    ["max_items", "maxItems", "maxProperties"],
  ] as const) {
    if (!(k in r)) continue
    push(shape?.map ? mapKw : kw, asNumber(r[k]))
    delete r[k]
  }
  if (!shape?.map) {
    if (r.unique_items === true) push("uniqueItems", true)
    delete r.unique_items
  }
  if (r.read_only === true) push("readOnly", true)
  delete r.read_only
  if ("example" in r) {
    push("examples", [jsonish(String(r.example))])
    delete r.example
  }
  if ("default" in r) {
    push("x-default", jsonish(String(r.default)))
    delete r.default
  }
  for (const [bound, exclusive, kw, xkw] of [
    ["minimum", "exclusive_minimum", "minimum", "exclusiveMinimum"],
    ["maximum", "exclusive_maximum", "maximum", "exclusiveMaximum"],
  ] as const) {
    if (bound in r) push(r[exclusive] === true ? xkw : kw, r[bound], valueTarget)
    delete r[bound]
    delete r[exclusive]
  }
  delete r.description
  return r
}

/** openapiv2_schema on a message: `json_schema.title` -> `title`, `json_schema.required` -> the named fields (A-13, S1). */
const liftOpenapiSchema = (
  options: Record<string, unknown>,
  out: Candidate[],
  fieldOf: ((name: string) => string | undefined) | undefined,
  result: AnnotationResult,
) => {
  const schema = options[OA_SCHEMA]
  if (!isPlainObject(schema) || !isPlainObject(schema.json_schema)) return
  const js: Record<string, unknown> = { ...schema.json_schema }
  if (typeof js.title === "string" && js.title) {
    out.push({ target: "", keyword: "title", value: js.title, source: "openapiv2" })
    delete js.title
  }
  if (Array.isArray(js.required) && fieldOf) {
    // names that are not fields of the message stay under options
    const kept: unknown[] = []
    for (const n of js.required) {
      const f = typeof n === "string" ? fieldOf(n) : undefined
      if (f) (result.requiredFields ??= []).push(f)
      else kept.push(n)
    }
    if (kept.length) js.required = kept
    else delete js.required
  }
  const rest: Record<string, unknown> = { ...schema }
  if (Object.keys(js).length) rest.json_schema = js
  else delete rest.json_schema
  if (Object.keys(rest).length) options[OA_SCHEMA] = rest
  else delete options[OA_SCHEMA]
}

// ---- main ----------------------------------------------------------------------------------------------------------

const KEYWORDS_64 = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"])

const slotOf = (shape: FieldShape | undefined, target: Target): Slot | undefined => {
  if (!shape) return undefined
  if (target === "") return shape.self
  if (target === "items") return shape.repeated
  if (target === "propertyNames") return shape.map?.key
  return shape.map?.value
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const annotate = (input: AnnotationInput): AnnotationResult => {
  const { kind, mode, shape } = input
  const options = { ...input.options }
  const result: AnnotationResult = {
    keywords: { "": {}, items: {}, propertyNames: {}, additionalProperties: {} },
    conflicts: [],
    invalidTags: [],
    invalidOptions: [],
    options,
    origins: [],
  }
  const candidates: Candidate[] = []
  const useOptions = mode !== "none"
  const useComments = mode === "all"
  const isField = kind === "field"

  // built-in deprecation
  let deprecated = false
  if (options.deprecated === true) {
    deprecated = true
    result.deprecationOrigin = { source: "option" }
    delete options.deprecated
  }

  // --- options (fields only)
  if (useOptions && isField) {
    const fb = options["google.api.field_behavior"]
    if (Array.isArray(fb)) {
      const rest: unknown[] = []
      for (const b of fb) {
        if (b === "REQUIRED") candidates.push({ target: "", keyword: "required", value: true, source: "google.api" })
        else if (b === "OUTPUT_ONLY")
          candidates.push({ target: "", keyword: "readOnly", value: true, source: "google.api" })
        else if (b === "INPUT_ONLY")
          candidates.push({ target: "", keyword: "writeOnly", value: true, source: "google.api" })
        else if (b === "IMMUTABLE")
          candidates.push({ target: "", keyword: "immutable", value: true, source: "google.api" })
        else {
          if (b === "OPTIONAL") candidates.push({ target: "", keyword: "required", value: false, source: "google.api" })
          rest.push(b)
        }
      }
      if (rest.length) options["google.api.field_behavior"] = rest
      else delete options["google.api.field_behavior"]
    }
    // A-7: field_info.format describes string values only; on other types it stays under options
    const fi = options["google.api.field_info"]
    const fiTarget: Target = shape?.repeated ? "items" : ""
    if (
      isPlainObject(fi) &&
      typeof fi.format === "string" &&
      fi.format in FIELD_INFO_FORMATS &&
      !shape?.map &&
      slotOf(shape, fiTarget)?.scalar === "string"
    ) {
      candidates.push({
        target: fiTarget,
        keyword: "format",
        value: FIELD_INFO_FORMATS[fi.format],
        source: "google.api",
      })
      const r = { ...fi }
      delete r.format
      if (Object.keys(r).length) options["google.api.field_info"] = r
      else delete options["google.api.field_info"]
    }
    for (const [key, source] of [
      ["buf.validate.field", "buf.validate"],
      ["validate.rules", "validate.rules"],
    ] as const) {
      const rules = options[key]
      if (!isPlainObject(rules)) continue
      const mismatch: Mismatch = (family, expected, target) =>
        result.invalidOptions.push({
          key,
          message: `(${key}).${target === "" ? "" : `${target === "items" ? "repeated.items" : target === "propertyNames" ? "map.keys" : "map.values"}.`}${family} rules do not match the ${
            target === "" ? "field" : target
          } type (${expected.length ? `expected ${expected.join(" or ")}` : "no rule family applies"}); the rules are kept under options`,
        })
      const rest = liftRules(rules, "", shape?.self ?? {}, shape, source, candidates, mismatch)
      const pruned = prune(rest)
      if (pruned === undefined) delete options[key]
      else options[key] = pruned
    }
    const oa = options[OA_FIELD]
    if (isPlainObject(oa)) {
      const rest = liftOpenapi(oa, candidates, shape)
      if (Object.keys(rest).length) options[OA_FIELD] = rest
      else delete options[OA_FIELD]
    }
  }
  if (useOptions && kind === "message") liftOpenapiSchema(options, candidates, input.fieldOf, result)
  // A-13: openapiv2_operation.deprecated -> deprecation
  if (useOptions && kind === "method") {
    const op = options[OA_OPERATION]
    if (isPlainObject(op) && op.deprecated === true) {
      deprecated = true
      result.deprecationOrigin ??= { source: "openapiv2" }
      const rest: Record<string, unknown> = { ...op }
      delete rest.deprecated
      if (Object.keys(rest).length) options[OA_OPERATION] = rest
      else delete options[OA_OPERATION]
    }
  }
  for (const c of candidates) c.option ??= optionKeyOf(c, kind)
  for (const e of input.extra ?? []) candidates.push({ target: "", ...e })

  // --- comments
  const leadLines = (normalizeComment(input.leading) ?? "")
    .split("\n")
    .filter((_, _i, a) => a.length > 1 || a[0] !== "")
  const trailLines = (normalizeComment(input.trailing) ?? "")
    .split("\n")
    .filter((_, _i, a) => a.length > 1 || a[0] !== "")
  let reason: string | undefined
  if (useComments) {
    const table = tagTable(input.tags).names
    const takeTags = (lines: string[], trailing: boolean): string[] => {
      const kept: string[] = []
      for (const line of lines) {
        const comment: CommentLine = { text: line, trailing }
        const before = candidates.length
        takeTag(line, comment, kept)
        for (let i = before; i < candidates.length; i++) candidates[i].comment = comment
      }
      return kept
    }
    const takeTag = (line: string, comment: CommentLine, kept: string[]) => {
      {
        const m = TAG_RE.exec(line.trim())
        const tag = m ? table.get(m[1].toLowerCase()) : undefined
        if (!m || !tag || (!isField && FIELD_ONLY_TAGS.has(tag))) {
          kept.push(line)
          return
        }
        const value = m[2].trim()
        const bad = (why: string) => result.invalidTags.push(`@${m[1]}${value ? ` ${value}` : ""}: ${why}`)
        const valueTarget: Target = VALUE_TAGS.has(tag)
          ? shape?.repeated
            ? "items"
            : shape?.map
              ? "additionalProperties"
              : ""
          : ""
        const slot = slotOf(shape, valueTarget)
        const push = (keyword: string, v: unknown, t: Target = valueTarget) =>
          candidates.push({ target: t, keyword, value: v, source: "tag" })
        // boolean tags: no value, `true` or `false` (A-14)
        const flag = (): boolean | undefined => {
          if (value === "" || value === "true") return true
          if (value === "false") return false
          bad("true or false is expected")
          return undefined
        }
        switch (tag) {
          case "default":
            if (value === "") bad("a value is expected")
            else candidates.push({ target: "", keyword: "x-default", value: jsonish(value), source: "tag" })
            break
          case "example":
            if (value === "") bad("a value is expected")
            else candidates.push({ target: "", keyword: "examples", value: [jsonish(value)], source: "tag" })
            break
          case "required":
            if (flag()) push("required", true, "")
            break
          case "minimum":
          case "maximum":
          case "exclusiveMinimum":
          case "exclusiveMaximum":
          case "multipleOf": {
            // A-1 / A-6: decimal numbers only; on 64-bit fields decimal integer digits, kept exact as a string
            if (slot?.scalar && INT64_KINDS.has(slot.scalar)) {
              if (!DIGITS.test(value)) bad("decimal integer digits are expected on a 64-bit field")
              else push(tag, BigInt(value).toString())
              break
            }
            const n = Number(value)
            if (!DECIMAL.test(value) || !Number.isFinite(n)) bad("a finite decimal number is expected")
            else push(tag, n === 0 ? 0 : n)
            break
          }
          case "pattern":
            if (value === "") bad("a regular expression is expected")
            else push("pattern", value)
            break
          case "minLength":
          case "maxLength":
            if (!COUNT.test(value) || !Number.isSafeInteger(Number(value))) bad("a non-negative integer is expected")
            else push(tag, Number(value))
            break
          case "minItems":
          case "maxItems":
            // A-8: on a map they count entries (decision 4); on a singular field they do not apply
            if (!COUNT.test(value) || !Number.isSafeInteger(Number(value))) bad("a non-negative integer is expected")
            else if (shape?.map) push(tag === "minItems" ? "minProperties" : "maxProperties", Number(value), "")
            else if (shape?.repeated) push(tag, Number(value), "")
            else bad("applies to repeated and map fields only")
            break
          case "format":
            if (slot?.scalar !== "string") bad("applies to string fields only")
            else if (value === "") bad("a value is expected")
            else push(tag, value)
            break
          case "enum": {
            // decision 11: string, numeric and enum fields (protovalidate `in` printed without its import)
            const items = value === "" ? [] : splitList(value)
            if (!slot?.enumDef && !(slot?.scalar && (slot.scalar === "string" || NUMERIC_RULES.has(slot.scalar))))
              bad("applies to string, numeric and enum fields only")
            else if (!items.length) bad("a value is expected")
            else {
              const values = enumTagValues(items, slot)
              if (typeof values === "string") bad(values)
              else push(tag, values)
            }
            break
          }
          case "readOnly":
          case "writeOnly":
            if (flag()) push(tag, true, "")
            break
          case "deprecated":
            deprecated = true
            result.deprecationOrigin ??= { source: "tag", comment }
            if (value) reason ??= value
            break
          case "title":
            // A-3: a candidate like the option sources, so openapiv2 titles win (D13); A-14: not empty
            if (value === "") bad("a title is expected")
            else candidates.push({ target: "", keyword: "title", value, source: "tag" })
            break
        }
      }
    }
    // item 10: AIP prefixes and the `Deprecated:` line apply to the description as a whole (leading comment, or the
    // trailing comment when there is no leading text), so a printed description reads the same
    const lead = takeTags(leadLines, false)
    const lines = [...lead, ...takeTags(trailLines, true)]
    const first = lines.findIndex((l) => l.trim() !== "")
    if (first >= 0) {
      const comment: CommentLine = { text: lines[first], trailing: first >= lead.length }
      const before = candidates.length
      if (isField) {
        // prefixes stack ("Input only. Immutable. …"), as googleapis writes them
        for (let p = PREFIX_RE.exec(lines[first]); p; p = PREFIX_RE.exec(lines[first])) {
          const prefix = p[1]
          lines[first] = lines[first].slice(p[0].length)
          if (prefix === "Required") candidates.push({ target: "", keyword: "required", value: true, source: "prefix" })
          else if (prefix === "Output only")
            candidates.push({ target: "", keyword: "readOnly", value: true, source: "prefix" })
          else if (prefix === "Input only")
            candidates.push({ target: "", keyword: "writeOnly", value: true, source: "prefix" })
          else if (prefix === "Immutable")
            candidates.push({ target: "", keyword: "immutable", value: true, source: "prefix" })
          else if (prefix === "Identifier") {
            const fb = Array.isArray(options["google.api.field_behavior"])
              ? (options["google.api.field_behavior"] as unknown[])
              : []
            if (!fb.includes("IDENTIFIER")) options["google.api.field_behavior"] = [...fb, "IDENTIFIER"]
          }
        }
      }
      for (let i = before; i < candidates.length; i++) candidates[i].comment = comment
      const d = DEPRECATED_RE.exec(lines[first])
      if (d) {
        deprecated = true
        result.deprecationOrigin ??= { source: "prefix", comment }
        if (d[1].trim()) reason = d[1].trim()
        lines[first] = ""
      }
    }
    result.description = normalizeComment(lines.join("\n"))
  } else {
    result.description = normalizeComment([...leadLines, ...trailLines].join("\n"))
  }
  if (deprecated) result.deprecation = reason ? { reason } : {}

  // --- precedence: sources in D13 order, first wins
  const order: AnnotationSource[] = [
    "option",
    "google.api",
    "buf.validate",
    "validate.rules",
    "openapiv2",
    "tag",
    "prefix",
  ]
  candidates.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))
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
  return result
}
