// Lowering of a field (and of an extension's field part): type keywords, presence (rule P), JSON name and default, protoc's option checks, resolved features, annotations and source map entries.

import type { Location, ProtoApiField } from "../types.ts"
import type { MField, MFile, MOneof, MOptionHolder, MTypeRef, OptionTree } from "../model/index.ts"
import { type VType, fromScalarText } from "../options/scalar.ts"
import type { AnnotationResult, FieldShape, Slot, Target } from "../conventions/types.ts"
import { OPENAPIV2_SCHEMA } from "../conventions/keys.ts"
import { type ResolvedFeatures, featuresOf, resolveFeatures, withoutFeatureKeys } from "../features.ts"
import { canonFloatOf, canonInt, INT_RANGE, toBase64 } from "../values/canonical.ts"
import { defaultJsonName } from "../values/json-name.ts"
import { parseFloatText, parseIntText, unescapeC } from "../values/literals.ts"
import { WRAPPERS } from "../values/scalars.ts"
import { isEditions } from "../common/editions.ts"
import { FIELD_NUMBER_MAX, IMPLEMENTATION_RESERVED_END, IMPLEMENTATION_RESERVED_START } from "../common/limits.ts"
import { parentScope } from "../common/names.ts"
import { isPlainObject } from "../common/objects.ts"
import type { LowerContext } from "./context.ts"
import { DEPRECATED, docKeywords, emitElement, orderKeys, reportAnnotations, typeRef } from "./emit.ts"

/** Packed encoding applies to repeated numeric and enum fields (not to maps, strings or bytes). */
const isPackable = (f: MField): boolean => {
  const t = f.type
  return (
    f.repeated &&
    !f.map &&
    (t.kind === "scalar" ? t.scalar !== "string" && t.scalar !== "bytes" : t.resolved?.kind === "enum")
  )
}

/** What the annotation layer sees of a type: a scalar, an enum or a message. */
const slot = (cx: LowerContext, t: MTypeRef): Slot => {
  if (t.kind === "scalar") return { scalar: t.scalar }
  if (t.resolved?.kind === "enum") return { enumDef: cx.input.symbols.enum(t.resolved.fqn) }
  const fqn = t.resolved?.fqn
  // A-11: wrapper well-known types take the tags and rules of their scalar
  if (fqn && fqn in WRAPPERS) return { scalar: WRAPPERS[fqn], wrapper: fqn }
  return { message: true, messageFqn: fqn }
}

/** The type keywords of a field (`type` / `$ref`, `items`, `additionalProperties`, `propertyNames`) and its shape. */
const typeKeywords = (cx: LowerContext, f: MField, out: Record<string, unknown>): FieldShape => {
  if (f.map) {
    out.type = "object"
    out.additionalProperties = typeRef(f.map.value)
    out.propertyNames = { type: f.map.key }
    return { self: { message: true }, map: { key: { scalar: f.map.key }, value: slot(cx, f.map.value) } }
  }
  if (f.repeated) {
    out.type = "array"
    out.items = typeRef(f.type)
    return { self: { message: true }, repeated: slot(cx, f.type) }
  }
  Object.assign(out, typeRef(f.type))
  return { self: slot(cx, f.type) }
}

/** `presence` (rule P): `required`, `explicit`, or nothing for implicit presence, repeated fields, maps and oneof members. */
const presence = (
  f: MField,
  file: MFile,
  features: ResolvedFeatures,
  isMessage: boolean,
  extension: boolean,
  out: Record<string, unknown>,
) => {
  if (f.repeated || f.map) return
  // a file- or message-level LEGACY_REQUIRED does not reach oneof members or extensions (they cannot be required)
  if (f.required || (features.field_presence === "LEGACY_REQUIRED" && !extension && !f.oneof)) out.presence = "required"
  else if (!f.oneof && !isMessage && !f.group) {
    const explicit =
      extension ||
      (file.syntax === "proto2" ? true : file.syntax === "proto3" ? f.optional : features.field_presence === "EXPLICIT")
    if (explicit) out.presence = "explicit"
  }
}

/** A descriptor `default_value` that cannot be parsed for the field's type is an `invalid-option`, dropped (desc#13). */
const descriptorDefault = (t: VType, s: string): string | number | boolean | undefined => {
  if (t.kind === "enum") return t.def && !t.def.values.some((v) => v.name === s) ? undefined : s
  if (t.kind !== "scalar") return s
  switch (t.scalar) {
    case "string":
      return s
    case "bytes":
      return toBase64(unescapeC(s))
    case "bool":
      return s === "true" ? true : s === "false" ? false : undefined
    case "float":
    case "double": {
      const v = parseFloatText(s)
      return v === undefined ? undefined : canonFloatOf(v, t.scalar)
    }
    default: {
      const v = parseIntText(s)
      if (v === undefined) return undefined
      const [lo, hi] = INT_RANGE[t.scalar] ?? [v, v]
      return v < lo || v > hi ? undefined : canonInt(v, t.scalar)
    }
  }
}

/** The field's `default` as a canonical value; a value that does not fit the type is reported and dropped. */
const canonicalDefault = (
  cx: LowerContext,
  f: MField,
  file: MFile,
  pointer: string,
): string | number | boolean | undefined => {
  const d = f.default
  if (!d) return undefined
  const t: VType =
    f.type.kind === "scalar"
      ? { kind: "scalar", scalar: f.type.scalar }
      : f.type.resolved?.kind === "enum"
        ? { kind: "enum", def: cx.input.symbols.enum(f.type.resolved.fqn) }
        : { kind: "unknown" }
  if (d.kind === "text") {
    const c = d.value as unknown as { type: string; start: number; end: number }
    const src = cx.input.sources.get(file.path) ?? ""
    const text = src.slice(c.start, c.end).trim()
    const v = fromScalarText(text, c.type === "str-lit", t, true)
    if (!v.ok) {
      // a message or unresolved field type is reported elsewhere (default not allowed / unresolved-type)
      if (t.kind === "scalar" || t.kind === "enum")
        cx.issue(
          "invalid-option",
          `default value ${text} is not valid for field ${f.name}: ${v.reason}; it is dropped`,
          file,
          pointer,
          f.locs.default ?? f.locs[""],
        )
      return undefined
    }
    return v.value as string | number | boolean
  }
  const v = descriptorDefault(t, d.value)
  if (v !== undefined) return v
  cx.issue(
    "invalid-option",
    `default value ${JSON.stringify(d.value)} is not valid for field ${f.name} (${
      t.kind === "scalar" ? t.scalar : t.kind === "enum" ? (t.def?.fqn ?? "enum") : "message"
    }); it is dropped`,
    file,
    pointer,
    f.locs.default ?? f.locs[""],
  )
  return undefined
}

/** protoc's field option checks that do not stop the build (invalid-option issues). */
const checkFieldOptions = (
  cx: LowerContext,
  f: MField,
  file: MFile,
  options: OptionTree,
  features: ResolvedFeatures,
  isMessage: boolean,
  extension: boolean,
  pointer: string,
) => {
  const loc = (key: string) => f.optionLocs[key] ?? f.locs[""]
  if ((options.packed !== undefined || f.optionLocs.packed !== undefined) && !isPackable(f))
    cx.issue(
      "invalid-option",
      `[packed] applies only to repeated numeric and enum fields (${f.name})`,
      file,
      pointer,
      loc("packed"),
    )
  const own = featuresOf(options)?.field_presence
  if (own !== undefined && (f.repeated || f.map || f.oneof || extension || (isMessage && own === "IMPLICIT")))
    cx.issue(
      "invalid-option",
      `features.field_presence cannot be set on field ${f.name}`,
      file,
      pointer,
      loc("features"),
    )
  if (f.default !== undefined) {
    const implicit =
      file.syntax === "proto3" || (isEditions(file.syntax) && features.field_presence === "IMPLICIT" && !f.oneof)
    if (implicit || f.repeated || f.map || isMessage)
      cx.issue(
        "invalid-option",
        `a default value is not allowed on field ${f.name}`,
        file,
        pointer,
        f.locs.default ?? f.locs[""],
      )
  }
}

/** The field number is in 1..max and outside the implementation-reserved range. */
const checkNumber = (cx: LowerContext, f: MField, file: MFile, pointer: string) => {
  if (
    f.number < 1 ||
    f.number > FIELD_NUMBER_MAX ||
    (f.number >= IMPLEMENTATION_RESERVED_START && f.number <= IMPLEMENTATION_RESERVED_END)
  )
    cx.issue("invalid-number", `field number ${f.number} is not allowed`, file, pointer, f.locs.number ?? f.locs[""])
}

/** F-3: resolved features against the fixed modern baseline (proto3 / editions defaults are not written). */
const resolvedKeywords = (
  f: MField,
  options: OptionTree,
  features: ResolvedFeatures,
  isMessage: boolean,
  out: Record<string, unknown>,
) => {
  if (!f.map && (f.group || (isMessage && features.message_encoding === "DELIMITED"))) out.delimited = true
  const encoding =
    typeof options.packed === "boolean" ? (options.packed ? "PACKED" : "EXPANDED") : features.repeated_field_encoding
  if (isPackable(f) && encoding === "EXPANDED") out.packed = false
  if (features.utf8_validation === "NONE") {
    const isString = (r: MTypeRef | undefined) => r?.kind === "scalar" && r.scalar === "string"
    if (f.map) {
      if (f.map.key === "string") (out.propertyNames as Record<string, unknown>).utf8Validation = false
      if (isString(f.map.value)) (out.additionalProperties as Record<string, unknown>).utf8Validation = false
    } else if (isString(f.type)) {
      if (f.repeated) (out.items as Record<string, unknown>).utf8Validation = false
      else out.utf8Validation = false
    }
  }
}

/** The annotation layer's keywords, options and `x-default` on the field and its `items` / map schemas. */
const annotationKeywords = (out: Record<string, unknown>, ann: AnnotationResult) => {
  docKeywords(out, ann)
  Object.assign(out, ann.keywords[""])
  for (const target of ["items", "additionalProperties", "propertyNames"] as Target[]) {
    const kw = ann.keywords[target]
    if (Object.keys(kw).length && isPlainObject(out[target]))
      out[target] = orderKeys({ ...(out[target] as object), ...kw })
  }
  if (Object.keys(ann.options).length) out.options = ann.options
  if (ann.xDefault !== undefined) out["x-default"] = ann.xDefault
}

/** Source map entries of the resolved keywords (F-3): the option that sets them on the field itself, when there is one. */
const resolvedEntries = (
  f: MField,
  options: OptionTree,
  out: Record<string, unknown>,
): [string, Location | undefined][] => {
  const entries: [string, Location | undefined][] = []
  const own = featuresOf(options)
  if (out.packed === false)
    entries.push([
      "packed",
      typeof options.packed === "boolean"
        ? f.optionLocs.packed
        : own?.repeated_field_encoding !== undefined
          ? f.optionLocs.features
          : undefined,
    ])
  if (own?.utf8_validation !== undefined)
    for (const at of ["", "items", "propertyNames", "additionalProperties"]) {
      const node = at ? (out[at] as Record<string, unknown> | undefined) : out
      if (node?.utf8Validation === false)
        entries.push([at ? `${at}/utf8Validation` : "utf8Validation", f.optionLocs.features])
    }
  return entries
}

/**
 * A field of a message, or the field part of an extension (`extension`): `chain` holds the option trees of the enclosing scopes (file first), `scope` is where its option names are looked up from, `schema` the message whose `openapiv2_schema.json_schema.required` names it.
 */
export const lowerField = (
  cx: LowerContext,
  f: MField,
  file: MFile,
  chain: OptionTree[],
  scope: string,
  pointer: string,
  oneof: MOneof | undefined,
  extension: boolean,
  schema?: MOptionHolder,
): ProtoApiField => {
  const options = { ...cx.opts(f, "field", file, scope) }
  const oneofOpts = oneof ? cx.opts(oneof, "oneof", file, parentScope(scope)) : undefined
  const features: ResolvedFeatures = resolveFeatures(cx.defaults(file.syntax), file.syntax, [
    ...chain,
    oneofOpts,
    options,
  ])
  const out: Record<string, unknown> = { number: f.number }
  const isMessage =
    f.type.kind === "named" && (f.type.resolved?.kind === "message" || (!f.type.resolved && f.type.hint !== "enum"))
  const shape = typeKeywords(cx, f, out)
  presence(f, file, features, isMessage, extension, out)
  if (f.oneof) out.oneof = f.oneof
  if (!extension && f.jsonName !== undefined && f.jsonName !== defaultJsonName(f.name)) out.jsonName = f.jsonName
  const def = canonicalDefault(cx, f, file, pointer)
  if (def !== undefined) out.default = def
  checkFieldOptions(cx, f, file, options, features, isMessage, extension, pointer)
  resolvedKeywords(f, options, features, isMessage, out)
  const ann = cx.annotate(
    // lifted features leave the field's own options; packed and the resolved features are keywords
    "field",
    f,
    withoutFeatureKeys(options, ["field_presence", "message_encoding"]),
    { shape, extra: schema && [{ keyword: "required", value: true, source: "openapiv2", option: OPENAPIV2_SCHEMA }] },
  )
  annotationKeywords(out, ann)
  reportAnnotations(cx, out, ann, `${extension ? "extension" : "field"} ${f.name}`, file, pointer, f)
  checkNumber(cx, f, file, pointer)
  emitElement(cx, out, ann, file, pointer, f, {
    keys: {
      number: "number",
      type: "type",
      jsonName: "jsonName",
      default: "default",
      extendee: "extendee",
      ...(out.presence ? { presence: f.locs.label ? "label" : "" } : {}),
    },
    keywords: DEPRECATED,
    resolved: resolvedEntries(f, options, out),
    outer: schema,
  })
  return orderKeys(out) as unknown as ProtoApiField
}
