// grpc-gateway openapiv2 conventions: `openapiv2_field` on fields, `openapiv2_schema` on messages and `openapiv2_operation.deprecated` on methods, lifted into keywords, and the inverse table the printer reads back with.

import { isPlainObject } from "../common/objects.ts"
import { OPENAPIV2_FIELD, OPENAPIV2_OPERATION, OPENAPIV2_SCHEMA, asNumber, putRest } from "./keys.ts"
import { jsonish } from "./tags.ts"
import { type AnnotationResult, type Candidate, type FieldShape, type Target, shapeKind, valueTarget } from "./types.ts"

/** JSONSchema fields that describe values: on `items` / `additionalProperties` for repeated and map fields */
const VALUE_FIELDS: Record<string, string> = {
  pattern: "pattern",
  format: "format",
  min_length: "minLength",
  max_length: "maxLength",
  multiple_of: "multipleOf",
  enum: "enum",
}
/** counts: of items on repeated fields, of entries on maps */
const COUNT_FIELDS = [
  ["min_items", "minItems", "minProperties"],
  ["max_items", "maxItems", "maxProperties"],
] as const
/** bounds, exclusive when the `exclusive_*` flag is set */
const BOUND_FIELDS = [
  ["minimum", "exclusive_minimum", "minimum", "exclusiveMinimum"],
  ["maximum", "exclusive_maximum", "maximum", "exclusiveMaximum"],
] as const

/** openapiv2 JSONSchema field per keyword (the lift below, inverted). */
export const OPENAPI_FIELD_OF_KEYWORD: Record<string, string> = {
  ...Object.fromEntries(Object.entries(VALUE_FIELDS).map(([field, keyword]) => [keyword, field])),
  ...Object.fromEntries(
    COUNT_FIELDS.flatMap(([field, keyword, mapKeyword]) => [
      [keyword, field],
      [mapKeyword, field],
    ]),
  ),
  ...Object.fromEntries(
    BOUND_FIELDS.flatMap(([bound, , keyword, exclusive]) => [
      [keyword, bound],
      [exclusive, bound],
    ]),
  ),
  // the fields lifted one by one
  uniqueItems: "unique_items",
  readOnly: "read_only",
  title: "title",
  examples: "example",
  "x-default": "default",
}

/**
 * openapiv2_field. On a repeated field `min_items`, `max_items` and `unique_items` describe the array and the value keywords go to `items`; on a map the value keywords go to `additionalProperties` and `min_items` / `max_items` become `minProperties` / `maxProperties`. `title`, `read_only`, `example` and `default` stay on the field, as the tags do.
 */
const liftOpenapi = (
  o: Record<string, unknown>,
  out: Candidate[],
  shape: FieldShape | undefined,
): Record<string, unknown> => {
  const r = { ...o }
  const values: Target = valueTarget(shapeKind(shape))
  const push = (keyword: string, value: unknown, t: Target = "") =>
    out.push({ target: t, keyword, value, source: "openapiv2" })
  if ("title" in r) {
    push("title", r.title)
    delete r.title
  }
  for (const [k, kw] of Object.entries(VALUE_FIELDS)) {
    if (!(k in r)) continue
    const v = r[k]
    push(kw, kw === "minLength" || kw === "maxLength" ? asNumber(v) : v, values)
    delete r[k]
  }
  for (const [k, kw, mapKw] of COUNT_FIELDS) {
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
  for (const [bound, exclusive, kw, xkw] of BOUND_FIELDS) {
    if (bound in r) push(r[exclusive] === true ? xkw : kw, r[bound], values)
    delete r[bound]
    delete r[exclusive]
  }
  delete r.description
  return r
}

/** Lift openapiv2_field of a field into `out`; the rest stays under options. */
export const liftOpenapiField = (options: Record<string, unknown>, shape: FieldShape | undefined, out: Candidate[]) => {
  const oa = options[OPENAPIV2_FIELD]
  if (isPlainObject(oa)) putRest(options, OPENAPIV2_FIELD, liftOpenapi(oa, out, shape))
}

/** openapiv2_schema on a message: `json_schema.title` -> `title`, `json_schema.required` -> the named fields (`required: true`, spec §3.8). */
export const liftOpenapiSchema = (
  options: Record<string, unknown>,
  out: Candidate[],
  fieldOf: ((name: string) => string | undefined) | undefined,
  result: AnnotationResult,
) => {
  const schema = options[OPENAPIV2_SCHEMA]
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
  putRest(rest, "json_schema", js)
  putRest(options, OPENAPIV2_SCHEMA, rest)
}

/** `openapiv2_operation.deprecated` on a method, removed from the options; true when it was set. */
export const liftOpenapiOperation = (options: Record<string, unknown>): boolean => {
  const op = options[OPENAPIV2_OPERATION]
  if (!isPlainObject(op) || op.deprecated !== true) return false
  const rest: Record<string, unknown> = { ...op }
  delete rest.deprecated
  putRest(options, OPENAPIV2_OPERATION, rest)
  return true
}
