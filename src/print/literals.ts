// Scalar literals of the printed text (strings, bytes, floats, enum names) and the canonical-value checks that decide whether a value can be printed into an option field of a given type.

import type { ProtoScalar } from "../types.ts"
import { INT_RANGE, canonFloatOf, fromBase64 } from "../values/canonical.ts"
import { FLOAT_KINDS, INT64_KINDS } from "../values/scalars.ts"
import type { FType } from "./oracle.ts"

/** A `.proto` string literal: JSON's escapes are protobuf escapes too (`\uXXXX` for control characters). */
export const quote = (s: string): string => JSON.stringify(s)

const quoteBytes = (b64: string): string => {
  let out = '"'
  for (const b of fromBase64(b64)) {
    if (b === 0x22) out += '\\"'
    else if (b === 0x5c) out += "\\\\"
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b)
    else out += `\\${b.toString(8).padStart(3, "0")}`
  }
  return `${out}"`
}

const floatLit = (v: unknown): string => {
  if (v === "Infinity") return "inf"
  if (v === "-Infinity") return "-inf"
  if (v === "NaN") return "nan"
  return String(v)
}

/** Print a scalar or enum value by type; unknown types: strings quoted. */
export const scalarLit = (v: unknown, t: FType | undefined): string => {
  if (t?.kind === "enum") return String(v)
  if (t?.kind === "scalar") {
    const s = t.scalar
    if (s === "string") return quote(String(v))
    if (s === "bytes") return quoteBytes(String(v))
    if (FLOAT_KINDS.has(s)) return floatLit(v)
    return String(v)
  }
  if (typeof v === "string") return quote(v)
  return String(v)
}

/** Whether `v` is a canonical value of scalar kind `s` (so the builder reads it back unchanged). */
export const fitsScalar = (v: unknown, s: ProtoScalar): boolean => {
  if (s === "bool") return typeof v === "boolean"
  if (s === "string" || s === "bytes") return typeof v === "string"
  if (FLOAT_KINDS.has(s)) {
    if (typeof v === "string") return v === "Infinity" || v === "-Infinity" || v === "NaN" || v === "-0"
    return typeof v === "number" && (s !== "float" || canonFloatOf(v, "float") === v)
  }
  const range = INT_RANGE[s]
  if (!range) return false
  if (INT64_KINDS.has(s) ? typeof v !== "string" || !/^-?\d+$/.test(v) : typeof v !== "number" || !Number.isInteger(v))
    return false
  const b = BigInt(v as string | number)
  return b >= range[0] && b <= range[1]
}

/** `value` in the canonical form of an option field of type `t`, or undefined when it does not fit. */
export const coerce = (v: unknown, t: FType): unknown => {
  if (t.repeated) {
    if (!Array.isArray(v)) return undefined
    const single = { ...t, repeated: false } as FType
    const out = v.map((x) => coerce(x, single))
    return out.includes(undefined) ? undefined : out
  }
  if (t.kind === "enum") return typeof v === "string" ? v : undefined
  if (t.kind !== "scalar") return undefined
  const s = t.scalar
  let x = v
  if (INT64_KINDS.has(s) && Number.isSafeInteger(v)) x = String(v)
  else if (FLOAT_KINDS.has(s) && typeof v === "string" && /^-?\d+$/.test(v) && String(Number(v)) === v) x = Number(v)
  return fitsScalar(x, s) ? x : undefined
}
