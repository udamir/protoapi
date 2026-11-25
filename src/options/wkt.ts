// Well-known types in ProtoJSON (spec §3.6): their special JSON forms to message form and back, and the canonical `Any`.

import { hasKey, isPlainObject, setKey } from "../common/objects.ts"
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

/** ProtoJSON's `Timestamp` form, RFC 3339 with an upper-case `T` and `Z` or a `±HH:MM` offset, up to 9 fraction digits */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/
/** The range of `Timestamp`: 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z, in seconds since the epoch */
const TIMESTAMP_MIN = -62135596800
const TIMESTAMP_MAX = 253402300799

/** An RFC 3339 timestamp as seconds since the epoch and nanos (protobuf's ProtoJSON rules: no other date forms, valid fields, within the `Timestamp` range); undefined when `v` is not one. */
const parseTimestamp = (v: string): { seconds: number; nanos: number } | undefined => {
  const m = RFC3339.exec(v)
  if (!m) return undefined
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
  const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) : 0
  if (hour > 23 || minute > 59 || second > 59 || Number(m[9] ?? 0) > 23 || Number(m[10] ?? 0) > 59) return undefined
  // setUTCFullYear: Date.UTC would read the years 0-99 as 1900-1999
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  const seconds = date.getTime() / 1000 + hour * 3600 + minute * 60 + second - offset * 60
  if (seconds < TIMESTAMP_MIN || seconds > TIMESTAMP_MAX) return undefined
  return { seconds, nanos: m[7] ? Number(m[7].padEnd(9, "0")) : 0 }
}

/** ProtoJSON special forms of well-known types -> message form (spec §3.6). Undefined when `v` is not in special form. */
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
    const t = parseTimestamp(v)
    return t && secondsNanos(BigInt(t.seconds), t.nanos)
  }
  if (fqn === "google.protobuf.FieldMask" && typeof v === "string") {
    return { paths: v ? v.split(",").map((p) => p.split(".").map(toSnake).join(".")) : [] }
  }
  if (hasKey(WRAPPERS, fqn) && !isPlainObject(v)) {
    const s = WRAPPERS[fqn]
    // proto3 `value` has implicit presence: a zero wrapper is the empty message
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
  for (const k of keys) setKey(fields, k, valueMessage(o[k]))
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

/** The range of `Duration` seconds in ProtoJSON (about ±10000 years) */
const DURATION_MAX = 315576000000n

/** Message form of a well-known type -> its ProtoJSON value (the `value` of an `Any`, spec §3.6); undefined when the value has none (protobuf's ProtoJSON rejects a `Timestamp` outside 0001-01-01..9999-12-31 or with nanos outside 0..999999999, and a `Duration` beyond ±315576000000 seconds or whose nanos are out of range or of the other sign). */
const toWktJson = (fqn: string, m: Record<string, unknown>): unknown => {
  const seconds = (): bigint => parseIntText(String(m.seconds ?? "0")) ?? 0n
  const nanos = (): number => Number(m.nanos ?? 0)
  if (fqn === "google.protobuf.Duration") {
    const s = seconds()
    const n = nanos()
    if (s > DURATION_MAX || s < -DURATION_MAX || Math.abs(n) > 999999999 || (s < 0n && n > 0) || (s > 0n && n < 0))
      return undefined
    return `${s < 0n || n < 0 ? "-" : ""}${s < 0n ? -s : s}${fraction(n)}s`
  }
  if (fqn === "google.protobuf.Timestamp") {
    const s = seconds()
    const n = nanos()
    if (s < BigInt(TIMESTAMP_MIN) || s > BigInt(TIMESTAMP_MAX) || n < 0 || n > 999999999) return undefined
    const iso = new Date(Number(s) * 1000).toISOString()
    return `${iso.slice(0, 19)}${fraction(n)}Z`
  }
  if (fqn === "google.protobuf.FieldMask")
    return (Array.isArray(m.paths) ? m.paths : []).map((p) => String(p).split(".").map(lowerCamel).join(".")).join(",")
  if (hasKey(WRAPPERS, fqn)) {
    if (m.value !== undefined) return m.value
    const s = WRAPPERS[fqn]
    return INT64_KINDS.has(s) ? "0" : s === "bool" ? false : s === "string" || s === "bytes" ? "" : 0
  }
  return m
}

/** The canonical `Any` value: `@type` first, then the payload's fields, or `value` for well-known payloads (spec §3.6); a well-known payload without a ProtoJSON form (an out-of-range `Timestamp` or `Duration`) keeps its fields. */
export const anyValue = (url: string, fqn: string, payload: Record<string, unknown>): Record<string, unknown> => {
  const value = WKT_VALUE_FORM.has(fqn) ? toWktJson(fqn, payload) : undefined
  return value === undefined ? { "@type": url, ...payload } : { "@type": url, value }
}
