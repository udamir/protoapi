// Validation rule conventions: protovalidate (`buf.validate.field`) and PGV (`validate.rules`) as two dialects of one lift, the rule fields of each family, and the inverse table the printer reads keywords back into rules with.

import type { AnnotationSource } from "../types.ts"
import type { MEnum } from "../model/index.ts"
import { isPlainObject } from "../common/objects.ts"
import { BUF_VALIDATE_FIELD, PGV_RULES, asNumber, putRest } from "./keys.ts"
import type { AnnotationResult, Candidate, FieldShape, Slot, Target } from "./types.ts"

type Obj = Record<string, unknown>

/** decimal number literal of a bound (no hexadecimal, no `Infinity`, A-1) */
export const DECIMAL = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
/** decimal integer digits of a 64-bit bound (A-6) */
export const DIGITS = /^-?\d+$/

/** `a > b` for canonical bound values (numbers, 64-bit decimal strings, `"Infinity"` strings). */
export const greater = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string" && typeof b === "string" && DIGITS.test(a) && DIGITS.test(b)) return BigInt(a) > BigInt(b)
  return Number(a) > Number(b)
}

/** A lower bound above the upper bound of a document position: the protovalidate / PGV lift keeps such bounds raw (A-9, D-D). */
export const outsideRange = (node: Obj): boolean => {
  const lower = node.exclusiveMinimum ?? node.minimum
  const upper = node.exclusiveMaximum ?? node.maximum
  return lower !== undefined && upper !== undefined && greater(lower, upper)
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/** string rule formats (`string.email: true`) and the `format` keyword value each lifts to */
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

/** STRING_FORMATS inverted: keyword value -> rule field. */
export const FORMAT_RULE: Record<string, string> = Object.fromEntries(
  Object.entries(STRING_FORMATS).map(([k, v]) => [v, k]),
)

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

// ---- dialects ---------------------------------------------------------------------------------------------------------

/** What tells protovalidate and PGV rules apart in the lift. */
export interface RuleDialect {
  /** the option key */
  key: string
  source: AnnotationSource
  /** PGV: a `message` family (`message.required`) that applies to every message field, wrappers included */
  messageFamily: boolean
  /** protovalidate: `<family>.example` values feed `examples` (A-13) */
  examples: boolean
}

export const PROTOVALIDATE: RuleDialect = {
  key: BUF_VALIDATE_FIELD,
  source: "buf.validate",
  messageFamily: false,
  examples: true,
}
export const PGV: RuleDialect = { key: PGV_RULES, source: "validate.rules", messageFamily: true, examples: false }

/** The dialects in precedence order (D13). */
export const RULE_DIALECTS: readonly RuleDialect[] = [PROTOVALIDATE, PGV]

// ---- rule fields ----------------------------------------------------------------------------------------------------

/** A rule field and the keyword it lifts to: `count` values become numbers, `flag` fields lift only when `true`. */
type RuleField = readonly [rule: string, keyword: string, value?: "count" | "flag"]

const CONST_FIELD: RuleField = ["const", "const"]
const IN_FIELD: RuleField = ["in", "enum"]
const PATTERN_FIELD: RuleField = ["pattern", "pattern"]
const EXAMPLE_FIELD: RuleField = ["example", "examples"]
/** numeric bounds; a lower bound above the upper one is an "outside" range and stays raw */
const BOUND_FIELDS: RuleField[] = [
  ["gt", "exclusiveMinimum"],
  ["gte", "minimum"],
  ["lt", "exclusiveMaximum"],
  ["lte", "maximum"],
]
const NUMERIC_FIELDS: RuleField[] = [...BOUND_FIELDS, CONST_FIELD, IN_FIELD]
const LENGTH_FIELDS: RuleField[] = [
  ["min_len", "minLength", "count"],
  ["max_len", "maxLength", "count"],
]
const REPEATED_FIELDS: RuleField[] = [
  ["min_items", "minItems", "count"],
  ["max_items", "maxItems", "count"],
  ["unique", "uniqueItems", "flag"],
]
const MAP_FIELDS: RuleField[] = [
  ["min_pairs", "minProperties", "count"],
  ["max_pairs", "maxProperties", "count"],
]

/** The families the printer writes rules into: numeric is every numeric scalar family, repeated and map the field level. */
export type RuleFamily = "numeric" | "string" | "bytes" | "bool" | "enum" | "repeated" | "map"

/** The rule fields of each family that map to one keyword (the lifts below also read `string.len`, the string pattern shorthands and formats, and the `items` / `keys` / `values` rules of repeated and map fields). */
const FAMILY_FIELDS: Record<RuleFamily, readonly RuleField[]> = {
  numeric: [...NUMERIC_FIELDS, EXAMPLE_FIELD],
  string: [...LENGTH_FIELDS, CONST_FIELD, IN_FIELD, PATTERN_FIELD, EXAMPLE_FIELD],
  bytes: [...LENGTH_FIELDS, CONST_FIELD, IN_FIELD, EXAMPLE_FIELD],
  bool: [CONST_FIELD, EXAMPLE_FIELD],
  enum: [CONST_FIELD, IN_FIELD, EXAMPLE_FIELD],
  repeated: REPEATED_FIELDS,
  map: MAP_FIELDS,
}

/** FAMILY_FIELDS inverted: keyword -> its rule field and the families that have it. */
export const RULE_OF_KEYWORD: Record<string, { rule: string; families: RuleFamily[] }> = (() => {
  const out: Record<string, { rule: string; families: RuleFamily[] }> = {}
  for (const [family, fields] of Object.entries(FAMILY_FIELDS) as [RuleFamily, readonly RuleField[]][])
    for (const [rule, keyword] of fields) (out[keyword] ??= { rule, families: [] }).families.push(family)
  return out
})()

/** The keywords of the numeric bounds (gt, gte, lt, lte). */
export const BOUND_KEYWORDS = new Set(BOUND_FIELDS.map(([, keyword]) => keyword))

/** The printer's family of a lift family name (a scalar, `enum` or a well-known-type family), if it writes into it. */
export const ruleFamilyOf = (family: string): RuleFamily | undefined =>
  NUMERIC_RULES.has(family)
    ? "numeric"
    : family === "string" || family === "bytes" || family === "bool" || family === "enum"
      ? family
      : undefined

/** The rule path of a position inside FieldRules. */
export const RULE_PATH: Record<Target, string[]> = {
  "": [],
  items: ["repeated", "items"],
  propertyNames: ["map", "keys"],
  additionalProperties: ["map", "values"],
}

// ---- lift -----------------------------------------------------------------------------------------------------------

type Push = (keyword: string, value: unknown, target?: Target) => void
type Mismatch = (family: string, expected: string[], target: Target) => void

/** What the lift of one position needs: where it lifts to, the dialect, and where candidates and mismatches go. */
interface RuleLift {
  target: Target
  slot: Slot
  shape: FieldShape | undefined
  dialect: RuleDialect
  out: Candidate[]
  mismatch: Mismatch
  push: Push
}

/** The rule families that fit a position, or undefined when its type is unknown (no check). PGV `message` rules
 *  apply to every message field (wrappers included); protovalidate has no message family. */
const expectedFamilies = (
  target: Target,
  slot: Slot,
  shape: FieldShape | undefined,
  dialect: RuleDialect,
): string[] | undefined => {
  if (target === "" && shape?.repeated) return ["repeated"]
  if (target === "" && shape?.map) return ["map"]
  const pgvMessage = dialect.messageFamily ? ["message"] : []
  if (slot.scalar) return [slot.scalar, ...(slot.wrapper ? pgvMessage : [])]
  if (slot.enumDef) return ["enum"]
  if (slot.message && slot.messageFqn) {
    const w = WKT_FAMILY[slot.messageFqn]
    return w ? [w, ...pgvMessage] : pgvMessage
  }
  return undefined
}

/** The `invalid-option` message of a rule family that does not match the type of its position. */
const mismatchMessage = (key: string, family: string, expected: string[], target: Target): string =>
  `(${key}).${[...RULE_PATH[target], family].join(".")} rules do not match the ${
    target === "" ? "field" : target
  } type (${expected.length ? `expected ${expected.join(" or ")}` : "no rule family applies"}); the rules are kept under options`

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

const enumNameOf = (def: MEnum | undefined, v: unknown): unknown => {
  if (typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v))) {
    const n = Number(v)
    return def?.values.find((x) => x.number === n)?.name ?? v
  }
  return v
}

/** Lift the rule fields of `fields` that `r` has, in table order. */
const liftFields = (r: Obj, fields: readonly RuleField[], push: Push) => {
  for (const [rule, keyword, value] of fields) {
    if (value === "flag") {
      if (r[rule] === true) {
        push(keyword, true)
        delete r[rule]
      }
      continue
    }
    if (!(rule in r)) continue
    push(keyword, value === "count" ? asNumber(r[rule]) : r[rule])
    delete r[rule]
  }
}

/** A-13: protovalidate `<family>.example` values feed `examples`. */
const liftExamples = (r: Obj, at: RuleLift, map: (v: unknown) => unknown = (v) => v) => {
  if (!at.dialect.examples || !Array.isArray(r.example) || !r.example.length) return
  at.push("examples", r.example.map(map))
  delete r.example
}

const liftNumeric = (r: Obj, at: RuleLift) => {
  // A-9 / D-D: a lower bound above the upper bound is protovalidate's / PGV's exclusive ("outside") range; the
  // bounds stay raw under options and no bound keyword is written
  const lower = "gt" in r ? r.gt : r.gte
  const upper = "lt" in r ? r.lt : r.lte
  const outside = lower !== undefined && upper !== undefined && greater(lower, upper)
  liftFields(r, outside ? [CONST_FIELD, IN_FIELD] : NUMERIC_FIELDS, at.push)
  liftExamples(r, at)
}

const liftString = (kind: "string" | "bytes", r: Obj, at: RuleLift) => {
  const push = at.push
  liftFields(r, LENGTH_FIELDS, push)
  if ("len" in r) {
    push("minLength", asNumber(r.len))
    push("maxLength", asNumber(r.len))
    delete r.len
  }
  liftFields(r, [CONST_FIELD, IN_FIELD], push)
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
  liftExamples(r, at)
}

const liftBool = (r: Obj, at: RuleLift) => {
  liftFields(r, [CONST_FIELD], at.push)
  liftExamples(r, at)
}

const liftEnum = (r: Obj, at: RuleLift) => {
  const def = at.slot.enumDef
  if ("const" in r) {
    at.push("const", enumNameOf(def, r.const))
    delete r.const
  }
  if ("in" in r && Array.isArray(r.in)) {
    at.push(
      "enum",
      r.in.map((v) => enumNameOf(def, v)),
    )
    delete r.in
  }
  liftExamples(r, at, (v) => enumNameOf(def, v))
}

/** The rules of a nested position (`repeated.items`, `map.keys`, `map.values`): lifted, with the remainder kept. */
const liftNested = (r: Obj, field: string, target: Target, slot: Slot, at: RuleLift) => {
  const remainder = liftRules(r[field] as Obj, target, slot, at)
  if (Object.keys(remainder).length) r[field] = remainder
  else delete r[field]
}

const liftRepeated = (r: Obj, at: RuleLift) => {
  liftFields(r, REPEATED_FIELDS, at.push)
  if (isPlainObject(r.items) && at.shape?.repeated) liftNested(r, "items", "items", at.shape.repeated, at)
}

const liftMap = (r: Obj, at: RuleLift) => {
  liftFields(r, MAP_FIELDS, at.push)
  if (isPlainObject(r.keys) && at.shape?.map) liftNested(r, "keys", "propertyNames", at.shape.map.key, at)
  if (isPlainObject(r.values) && at.shape?.map) liftNested(r, "values", "additionalProperties", at.shape.map.value, at)
}

/** Lift validation rules (protovalidate or PGV) for one position; returns the remainder. */
const liftRules = (
  rules: Obj,
  target: Target,
  slot: Slot,
  ctx: Pick<RuleLift, "shape" | "dialect" | "out" | "mismatch">,
): Obj => {
  const { shape, dialect, out, mismatch } = ctx
  const rest: Obj = {}
  const push: Push = (keyword, value, t = target) => out.push({ target: t, keyword, value, source: dialect.source })
  const at: RuleLift = { target, slot, shape, dialect, out, mismatch, push }
  for (const [kind, raw] of Object.entries(rules)) {
    if (kind === "required" && target === "") {
      if (raw === true) push("required", true)
      else rest[kind] = raw
      continue
    }
    if (RULE_FAMILIES.has(kind) && isPlainObject(raw)) {
      // A-11: a rule family that does not match the field type stays raw (protovalidate: "mismatched rule type")
      const expected = expectedFamilies(target, slot, shape, dialect)
      if (expected && !expected.includes(kind)) {
        mismatch(kind, expected, target)
        rest[kind] = raw
        continue
      }
    }
    if (kind === "message" && dialect.messageFamily && isPlainObject(raw)) {
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
    const r: Obj = { ...raw }
    if (NUMERIC_RULES.has(kind)) liftNumeric(r, at)
    else if (kind === "string" || kind === "bytes") liftString(kind, r, at)
    else if (kind === "bool") liftBool(r, at)
    else if (kind === "enum") liftEnum(r, at)
    else if (kind === "repeated" && target === "") liftRepeated(r, at)
    else if (kind === "map" && target === "") liftMap(r, at)
    if (Object.keys(r).length) rest[kind] = r
  }
  return rest
}

/** Lift the protovalidate and PGV rules of a field into `out`; the rest stays under options, rule families that do not match the field type are reported in `invalid`. */
export const liftValidation = (
  options: Obj,
  shape: FieldShape | undefined,
  out: Candidate[],
  invalid: AnnotationResult["invalidOptions"],
) => {
  for (const dialect of RULE_DIALECTS) {
    const { key } = dialect
    const rules = options[key]
    if (!isPlainObject(rules)) continue
    const mismatch: Mismatch = (family, expected, target) =>
      invalid.push({ key, message: mismatchMessage(key, family, expected, target) })
    const rest = liftRules(rules, "", shape?.self ?? {}, { shape, dialect, out, mismatch })
    putRest(options, key, prune(rest) as Obj | undefined)
  }
}
