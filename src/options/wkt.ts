// Well-known types in ProtoJSON (§3.7): their special JSON forms to message form and back, and the canonical `Any`.

import { isPlainObject } from "../common/objects.ts"
import { canonFloat, canonFloatOf, fromBase64, toBase64 } from "../values/canonical.ts"
import { lowerCamel, toSnake } from "../values/json-name.ts"
import { parseFloatText, parseIntText } from "../values/literals.ts"
import { FLOAT_KINDS, INT64_KINDS, WRAPPERS } from "../values/scalars.ts"

const secondsNanos = (seconds: bigint, nanos: number) => {
  const out: Record<string, unknown> = {}
  if (seconds !== 0n) out.seconds = seconds.toString()
  if (nanos !== 0) out.nanos = nanos
  return out
}

/** ProtoJSON special forms of well-known types -> message form (§3.7). Undefined when `v` is not in special form. */
export const fromWktJson = (fqn: string, v: unknown): unknown => {
  if (fqn === "google.protobuf.Duration" && typeof v === "string") {
    const m = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(v)
    if (!m) return undefined
    const sign = m[1] ? -1 : 1
    const seconds = BigInt(m[2]) * BigInt(sign)
    const nanos = m[3] ? Number(m[3].padEnd(9, "0")) * sign : 0
    return secondsNanos(seconds, nanos)
  }
  if (fqn === "google.protobuf.Timestamp" && typeof v === "string") {
    const ms = Date.parse(v)
    if (Number.isNaN(ms)) return undefined
    const frac = /\.(\d{1,9})/.exec(v)
    const seconds = BigInt(Math.floor(ms / 1000))
    return secondsNanos(seconds, frac ? Number(frac[1].padEnd(9, "0")) : 0)
  }
  if (fqn === "google.protobuf.FieldMask" && typeof v === "string") {
    return { paths: v ? v.split(",").map((p) => p.split(".").map(toSnake).join(".")) : [] }
  }
  if (fqn in WRAPPERS && !isPlainObject(v)) {
    const s = WRAPPERS[fqn]
    // proto3 `value` has implicit presence: a zero wrapper is the empty message (C-14)
    if (v === 0 || v === "0" || v === false || v === "") return {}
    if (INT64_KINDS.has(s)) return { value: String(v) }
    if (FLOAT_KINDS.has(s)) {
      const n = typeof v === "number" ? v : parseFloatText(String(v))
      return { value: n === undefined ? v : canonFloatOf(n, s) }
    }
    if (s === "bytes" && typeof v === "string") return { value: toBase64(fromBase64(v)) }
    return { value: v }
  }
  // Struct, Value and ListValue are written in message form like the text producer (no JSON `null` in a document)
  if (fqn === "google.protobuf.Struct" && isPlainObject(v)) return structMessage(v)
  if (fqn === "google.protobuf.ListValue" && Array.isArray(v)) return listMessage(v)
  if (fqn === "google.protobuf.Value" && v !== undefined) return valueMessage(v)
  if (fqn === "google.protobuf.Empty" && isPlainObject(v)) return {}
  return undefined
}

const structMessage = (o: Record<string, unknown>): Record<string, unknown> => {
  const keys = Object.keys(o).sort()
  if (!keys.length) return {}
  const fields: Record<string, unknown> = {}
  for (const k of keys) fields[k] = valueMessage(o[k])
  return { fields }
}
const listMessage = (a: unknown[]): Record<string, unknown> => (a.length ? { values: a.map(valueMessage) } : {})
const valueMessage = (x: unknown): Record<string, unknown> => {
  if (x === null) return { null_value: "NULL_VALUE" }
  if (typeof x === "number") return { number_value: canonFloat(x) }
  if (typeof x === "string") return { string_value: x }
  if (typeof x === "boolean") return { bool_value: x }
  if (Array.isArray(x)) return { list_value: listMessage(x) }
  if (isPlainObject(x)) return { struct_value: structMessage(x) }
  return {}
}

/** Well-known types whose ProtoJSON form is a JSON value (inside an `Any`: `{ "@type", value }`). */
export const WKT_VALUE_FORM = new Set<string>([
  "google.protobuf.Duration",
  "google.protobuf.Timestamp",
  "google.protobuf.FieldMask",
  "google.protobuf.Empty",
  "google.protobuf.Any",
  ...Object.keys(WRAPPERS),
])
/** JSON-valued well-known types kept in message form inside an `Any`, so that a document holds no JSON `null`. */
export const WKT_JSON_VALUES = new Set<string>([
  "google.protobuf.Struct",
  "google.protobuf.Value",
  "google.protobuf.ListValue",
])

const fraction = (nanos: number): string => {
  const n = Math.abs(nanos)
  if (n === 0) return ""
  if (n % 1e6 === 0) return `.${String(n / 1e6).padStart(3, "0")}`
  if (n % 1e3 === 0) return `.${String(n / 1e3).padStart(6, "0")}`
  return `.${String(n).padStart(9, "0")}`
}

/** Message form of a well-known type -> its ProtoJSON value (the `value` of an `Any`, decision 2). */
const toWktJson = (fqn: string, m: Record<string, unknown>): unknown => {
  const seconds = (): bigint => parseIntText(String(m.seconds ?? "0")) ?? 0n
  const nanos = (): number => Number(m.nanos ?? 0)
  if (fqn === "google.protobuf.Duration") {
    const s = seconds()
    const n = nanos()
    return `${s < 0n || n < 0 ? "-" : ""}${s < 0n ? -s : s}${fraction(n)}s`
  }
  if (fqn === "google.protobuf.Timestamp") {
    const iso = new Date(Number(seconds()) * 1000).toISOString()
    return `${iso.slice(0, 19)}${fraction(nanos())}Z`
  }
  if (fqn === "google.protobuf.FieldMask")
    return (Array.isArray(m.paths) ? m.paths : []).map((p) => String(p).split(".").map(lowerCamel).join(".")).join(",")
  if (fqn in WRAPPERS) {
    if (m.value !== undefined) return m.value
    const s = WRAPPERS[fqn]
    return INT64_KINDS.has(s) ? "0" : s === "bool" ? false : s === "string" || s === "bytes" ? "" : 0
  }
  return m
}

/** The canonical `Any` value: `@type` first, then the payload's fields, or `value` for well-known payloads (C-9). */
export const anyValue = (url: string, fqn: string, payload: Record<string, unknown>): Record<string, unknown> =>
  WKT_VALUE_FORM.has(fqn) ? { "@type": url, value: toWktJson(fqn, payload) } : { "@type": url, ...payload }
