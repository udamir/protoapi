// Annotation keywords of a field printed back (spec §6): as the convention option they can come from when the file can use it (in the precedence order of spec §3.8), else as a comment tag or an AIP prefix. The convention tables are in conventions/; this module plans one field against the file's imports and the option definitions.

import type { ProtoApiField, ProtoScalar } from "../types.ts"
import { INT64_KINDS, WRAPPERS } from "../values/scalars.ts"
import { type ShapeKind, type Target, ANNOTATION_KEYWORDS, valueTarget } from "../conventions/types.ts"
import {
  BUF_VALIDATE_FIELD,
  FIELD_BEHAVIOR,
  FIELD_INFO,
  OPENAPIV2_FIELD,
  OPTION_TYPES,
  PGV_RULES,
} from "../conventions/keys.ts"
import { BEHAVIOR_OF_KEYWORD, FIELD_INFO_FORMAT_OF } from "../conventions/google-api.ts"
import {
  BOUND_KEYWORDS,
  DECIMAL,
  FORMAT_RULE,
  NUMERIC_RULES,
  PGV,
  PROTOVALIDATE,
  RULE_OF_KEYWORD,
  RULE_PATH,
  type RuleDialect,
  WKT_FAMILY,
  outsideRange,
  ruleFamilyOf,
} from "../conventions/rules.ts"
import { OPENAPI_FIELD_OF_KEYWORD } from "../conventions/openapiv2.ts"
import { TAG_OF_KEYWORD, type TagPrintKind, type TagSpelling, VALUE_KEYWORDS } from "../conventions/tags.ts"
import { IDENTIFIER_PREFIX, PREFIX_OF_KEYWORD } from "../conventions/prefixes.ts"
import { getKey, hasKey, isPlainObject } from "../common/objects.ts"
import { type Oracle, refFqn, scalarOf } from "./oracle.ts"
import type { ImportTracker } from "./imports.ts"
import { coerce, fitsScalar } from "./literals.ts"
import { tagLine } from "./comments.ts"

type Obj = Record<string, unknown>

/** What planning a field's annotations reads: the option definitions, the file's imports and the tag spelling. */
export interface AnnotationContext {
  oracle: Oracle
  imports: ImportTracker
  /** the tag spelling of the `tags` print option; undefined: no comment annotations are printed */
  tag: TagSpelling | undefined
}

/** A typed position of a field: the field itself, its items, map key or map value. */
interface Pos {
  target: Target
  node: Obj
  /** scalar kind (wrappers: their scalar) */
  scalar?: ProtoScalar
  enumFqn?: string
  messageFqn?: string
}

/** What a field prints besides its declaration: option trees, comment lines before / after the description. */
export interface FieldPlan {
  options: Obj
  prefixes: string[]
  tags: string[]
}

/** The position a keyword is read back at: value keywords and value tags at the value position (spec §3.2 Field). */
const targetOf = (kw: string, shape: ShapeKind): Target => (VALUE_KEYWORDS.has(kw) ? valueTarget(shape) : "")

/** The positions of a field: itself, items, map key, map value. */
const positionsOf = (f: ProtoApiField): Pos[] => {
  const posOf = (target: Target, node: unknown): Pos => {
    const n = (isPlainObject(node) ? node : {}) as Obj
    const p: Pos = { target, node: n }
    const scalar = scalarOf(n)
    if (scalar) p.scalar = scalar
    else if (typeof n.$ref === "string") {
      const fqn = refFqn(n.$ref)
      if (n.$ref.includes("/enums/")) p.enumFqn = fqn
      else {
        p.messageFqn = fqn
        if (hasKey(WRAPPERS, fqn)) p.scalar = WRAPPERS[fqn]
      }
    }
    return p
  }
  const self = f as unknown as Obj
  if (f.type === "array") return [{ target: "", node: self }, posOf("items", f.items)]
  if (f.type === "object" && f.additionalProperties)
    return [
      { target: "", node: self },
      posOf("propertyNames", f.propertyNames),
      posOf("additionalProperties", f.additionalProperties),
    ]
  return [posOf("", self)]
}

/** `@Enum` text for string, numeric and enum positions, or undefined. */
const enumTag = (v: unknown, slot: Pos): string | undefined => {
  if (!Array.isArray(v) || !v.length) return undefined
  const s = slot.scalar
  if (s === "string")
    return v.every((x) => typeof x === "string") ? v.map((x) => JSON.stringify(x)).join(", ") : undefined
  const ok = slot.enumFqn
    ? v.every((x) => (typeof x === "string" && /^[A-Za-z_]\w*$/.test(x)) || Number.isInteger(x))
    : !!s &&
      NUMERIC_RULES.has(s) &&
      v.every((x) => fitsScalar(x, s) && (typeof x !== "number" || DECIMAL.test(String(x))))
  return ok ? v.join(", ") : undefined
}

/**
 * Set `path` in the option tree `root[key]` when the option is available to the file, the definitions have every
 * segment, no oneof sibling is set, the leaf is free and `value` fits the leaf's type (64-bit numbers become decimal
 * strings, exact digit strings of a double leaf numbers); returns false and changes nothing otherwise.
 */
export const trySet = (ac: AnnotationContext, root: Obj, key: string, path: string[], value: unknown): boolean => {
  if (!ac.imports.available(key)) return false
  const oracle = ac.oracle
  let fqn = OPTION_TYPES[key]
  let node: Obj | undefined = isPlainObject(root[key]) ? (root[key] as Obj) : undefined
  let leaf: unknown
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]
    const def = oracle.fieldDef(fqn, seg)
    const t = oracle.field(fqn, seg)
    if (!def || !t) return false
    const n = node
    if (
      def.oneof &&
      n &&
      oracle.symbols
        .message(fqn)
        ?.fields.some((x) => x.oneof === def.oneof && n[x.name] !== undefined && x.name !== seg)
    )
      return false
    if (i === path.length - 1) {
      if (n?.[seg] !== undefined) return false
      leaf = coerce(value, t)
      if (leaf === undefined) return false
      break
    }
    if (t.kind !== "message" || t.repeated || ("map" in t && t.map)) return false
    const next: unknown = n?.[seg]
    if (next !== undefined && !isPlainObject(next)) return false
    node = next as Obj | undefined
    fqn = t.fqn
  }
  let tree = root[key] as Obj
  if (!isPlainObject(tree)) root[key] = tree = {}
  for (const seg of path.slice(0, -1)) tree = (tree[seg] ??= {}) as Obj
  tree[path[path.length - 1]] = leaf
  return true
}

/** Values of the enum family (`const`, `in`, `example`) are numbers in protovalidate / PGV. */
const enumNumbers = (oracle: Oracle, p: Pos, v: unknown): unknown => {
  const one = (x: unknown) =>
    typeof x === "number" ? x : typeof x === "string" ? oracle.enumNumber(p.enumFqn, x) : undefined
  const out = (Array.isArray(v) ? v : [v]).map(one)
  return out.includes(undefined) ? undefined : Array.isArray(v) ? out : out[0]
}

/** protovalidate / PGV (`dialect`) for keyword `kw` of position `p` (rule families as the annotation layer lifts them). `raw`: the field's options as the document holds them (the raw remainder of lifted conventions). */
const tryRules = (
  ac: AnnotationContext,
  raw: Obj,
  o: Obj,
  dialect: RuleDialect,
  p: Pos,
  shape: ShapeKind,
  kw: string,
  v: unknown,
): boolean => {
  // PGV has no `example` rules
  if (kw === "examples" && !dialect.examples) return false
  const key = dialect.key
  const r = RULE_OF_KEYWORD[kw]
  if (p.target === "" && shape !== "singular")
    return !!r && r.families.includes(shape) && trySet(ac, o, key, [shape, r.rule], v)
  const fam = p.scalar ?? (p.enumFqn ? "enum" : p.messageFqn ? getKey(WKT_FAMILY, p.messageFqn) : undefined)
  if (!fam) return false
  const family = ruleFamilyOf(fam)
  let rule = r && family && r.families.includes(family) ? r.rule : undefined
  let value = v
  if (kw === "format" && family === "string" && typeof v === "string" && Object.hasOwn(FORMAT_RULE, v)) {
    rule = FORMAT_RULE[v]
    value = true
  }
  if (!rule) return false
  if (family === "enum") value = enumNumbers(ac.oracle, p, v)
  const base = RULE_PATH[p.target]
  if (BOUND_KEYWORDS.has(kw)) {
    // bounds next to raw bounds of the family, or a lower bound above the upper one, are read back as protovalidate's outside range (raw)
    let rawRules: unknown = raw[key]
    for (const s of [...base, fam]) rawRules = isPlainObject(rawRules) ? rawRules[s] : undefined
    if (outsideRange(p.node) || (isPlainObject(rawRules) && ["gt", "gte", "lt", "lte"].some((b) => b in rawRules)))
      return false
  }
  return value !== undefined && trySet(ac, o, key, [...base, fam, rule], value)
}

/** openapiv2_field for keyword `kw`: value keywords at the value position (spec §3.2 Field), the rest on the field. */
const tryOpenapi = (ac: AnnotationContext, o: Obj, p: Pos, shape: ShapeKind, kw: string, v: unknown): boolean => {
  const rule = OPENAPI_FIELD_OF_KEYWORD[kw]
  if (!rule || p.target !== targetOf(kw, shape)) return false
  if ((kw.endsWith("Items") && shape !== "repeated") || (kw.endsWith("Properties") && shape !== "map")) return false
  let value = v
  if (kw === "examples") {
    if (!Array.isArray(v) || v.length !== 1) return false
    value = JSON.stringify(v[0])
  } else if (kw === "x-default") value = JSON.stringify(v)
  const exclusive = kw.startsWith("exclusive")
  // `minimum` and `exclusiveMinimum` share the openapiv2 field
  if (rule === "minimum" || rule === "maximum")
    if (p.node[exclusive ? rule : `exclusive${rule[0].toUpperCase()}${rule.slice(1)}`] !== undefined) return false
  if (!trySet(ac, o, OPENAPIV2_FIELD, [rule], value)) return false
  if (exclusive) trySet(ac, o, OPENAPIV2_FIELD, [`exclusive_${rule}`], true)
  return true
}

/** The values of the tag lines that print keyword value `v` as a tag of kind `kind` (`""`: a tag without a value), or a list with undefined when the value cannot be spelled by that tag. */
const tagValues = (kind: TagPrintKind, v: unknown, shape: ShapeKind, slot: Pos): (string | undefined)[] => {
  const ok = (c: unknown, x: unknown = v) => (c ? String(x) : undefined)
  switch (kind) {
    case "bound":
      // decimal numbers; on 64-bit fields decimal integer digits
      return [
        ok(
          slot.scalar && INT64_KINDS.has(slot.scalar)
            ? typeof v === "string" && /^-?\d+$/.test(v)
            : typeof v === "number" && !Object.is(v, -0) && DECIMAL.test(String(v)),
        ),
      ]
    case "count":
    case "itemCount":
    case "entryCount": {
      // counts; @MinItems on repeated fields, on maps it counts entries
      const fits = kind === "count" || shape === (kind === "itemCount" ? "repeated" : "map")
      return [ok(fits && Number.isSafeInteger(v) && (v as number) >= 0)]
    }
    case "text":
    case "format":
      // one line; @Format on strings only
      return [
        ok(
          typeof v === "string" &&
            v &&
            v === v.trim() &&
            !v.includes("\n") &&
            (kind === "text" || slot.scalar === "string"),
        ),
      ]
    case "enumList":
      return [enumTag(v, slot)]
    case "flag":
      return [ok(v === true, "")]
    case "json":
      return [JSON.stringify(v)]
    default:
      return Array.isArray(v) && v.length ? v.map((e) => JSON.stringify(e)) : [undefined]
  }
}

/** A comment tag for keyword `kw`; value tags target the value position of the field (spec §3.2 Field). */
const tryTag = (
  ac: AnnotationContext,
  plan: FieldPlan,
  p: Pos,
  shape: ShapeKind,
  kw: string,
  v: unknown,
  slot: Pos,
): boolean => {
  const spec = TAG_OF_KEYWORD[kw]
  if (!spec || p.target !== targetOf(kw, shape)) return false
  const [tag, kind] = spec
  const lines = tagValues(kind, v, shape, slot).map((x) =>
    typeof x === "string" ? tagLine(ac.tag, tag, x || undefined) : undefined,
  )
  if (lines.includes(undefined)) return false
  plan.tags.push(...(lines as string[]))
  return true
}

/** Print every annotation keyword of a field back as options, tags or prefixes (spec §6). */
export const planField = (ac: AnnotationContext, f: ProtoApiField, comments: boolean): FieldPlan => {
  const raw: Obj = isPlainObject(f.options) ? f.options : {}
  const o = structuredClone(raw) as Obj
  const plan: FieldPlan = { options: o, prefixes: [], tags: [] }
  const shape: ShapeKind =
    f.type === "array" ? "repeated" : f.type === "object" && f.additionalProperties ? "map" : "singular"
  const positions = positionsOf(f)
  const slot = positions[shape === "repeated" ? 1 : shape === "map" ? 2 : 0]
  const tags = comments && !!ac.tag
  const fb = (value: string) => {
    if (!ac.imports.available(FIELD_BEHAVIOR)) return false
    const list = Array.isArray(o[FIELD_BEHAVIOR]) ? (o[FIELD_BEHAVIOR] as unknown[]) : []
    if (!list.includes(value)) o[FIELD_BEHAVIOR] = [...list, value]
    return true
  }
  const prefix = (kw: string) => {
    const text = PREFIX_OF_KEYWORD[kw]
    if (!tags || !text) return false
    plan.prefixes.push(text)
    return true
  }
  const requiredTag = () => {
    const line = tags ? tagLine(ac.tag, "required") : undefined
    if (!line) return false
    plan.tags.push(line)
    return true
  }
  const forced = (key: string, then: () => unknown) => () => {
    // no available option and no tag spells the keyword (`const`, `uniqueItems`, map keys, `immutable` without
    // comments): the convention option is printed with its import (documents not built from this text)
    const file = ac.oracle.extensionFile(key)
    if (!file || ac.imports.sees(file)) return
    ac.imports.need(file)
    then()
  }
  const first = (attempts: (() => boolean)[], fallback?: () => void) => {
    if (!attempts.some((a) => a())) fallback?.()
  }
  // the Identifier prefix adds IDENTIFIER to field_behavior; without the import it prints as the prefix
  const listed = o[FIELD_BEHAVIOR]
  if (tags && Array.isArray(listed) && listed.includes("IDENTIFIER") && !ac.imports.available(FIELD_BEHAVIOR)) {
    plan.prefixes.push(IDENTIFIER_PREFIX)
    o[FIELD_BEHAVIOR] = listed.filter((x) => x !== "IDENTIFIER")
  }
  if (f.required === true)
    first(
      [
        () => fb(BEHAVIOR_OF_KEYWORD.required),
        () => trySet(ac, o, BUF_VALIDATE_FIELD, ["required"], true),
        () =>
          shape === "singular" && !!positions[0].messageFqn && trySet(ac, o, PGV_RULES, ["message", "required"], true),
        requiredTag,
        () => prefix("required"),
      ],
      forced(FIELD_BEHAVIOR, () => fb(BEHAVIOR_OF_KEYWORD.required)),
    )
  for (const p of positions)
    for (const kw of ANNOTATION_KEYWORDS) {
      const v = p.node[kw]
      if (v === undefined) continue
      const behavior = p.target === "" && v === true ? BEHAVIOR_OF_KEYWORD[kw] : undefined
      first(
        [
          () => !!behavior && fb(behavior),
          () =>
            kw === "format" &&
            p === positions[shape === "repeated" ? 1 : 0] &&
            shape !== "map" &&
            p.scalar === "string" &&
            typeof v === "string" &&
            Object.hasOwn(FIELD_INFO_FORMAT_OF, v) &&
            trySet(ac, o, FIELD_INFO, ["format"], FIELD_INFO_FORMAT_OF[v]),
          () => tryRules(ac, raw, o, PROTOVALIDATE, p, shape, kw, v),
          () => tryRules(ac, raw, o, PGV, p, shape, kw, v),
          () => tryOpenapi(ac, o, p, shape, kw, v),
          () => tags && tryTag(ac, plan, p, shape, kw, v, slot),
          () => p.target === "" && v === true && prefix(kw),
        ],
        behavior
          ? forced(FIELD_BEHAVIOR, () => fb(behavior))
          : forced(BUF_VALIDATE_FIELD, () => tryRules(ac, raw, o, PROTOVALIDATE, p, shape, kw, v)),
      )
    }
  for (const [kw, v] of [
    ["x-default", f["x-default"]],
    ["title", f.title],
  ] as const)
    if (v !== undefined)
      first([
        () => tryOpenapi(ac, o, positions[0], shape, kw, v),
        () => tags && tryTag(ac, plan, positions[0], shape, kw, v, slot),
      ])
  return plan
}
