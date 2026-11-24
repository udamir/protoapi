// Canonical values (design §3.6, D7): 64-bit integers as decimal strings, non-finite floats as "Infinity" /
// "-Infinity" / "NaN", bytes as standard padded base64, enums as names.

import type { ProtoScalar } from "../types.ts"
import { INT64_KINDS } from "./scalars.ts"

/**
 * Canonical form of a float / double value: finite numbers as JSON numbers; `"Infinity"`, `"-Infinity"`, `"NaN"`
 * (D7) and `"-0"` (negative zero, which JSON cannot carry: `JSON.stringify(-0)` is `0`; validation F-2) as strings.
 * A document never holds `null` or a non-finite number.
 */
export const canonFloat = (v: number): number | string => {
  if (Number.isNaN(v)) return "NaN"
  if (v === Number.POSITIVE_INFINITY) return "Infinity"
  if (v === Number.NEGATIVE_INFINITY) return "-Infinity"
  if (v === 0 && Object.is(v, -0)) return "-0"
  return v
}

/**
 * The shortest decimal that rounds to the same float32 as `v` (C-5, IN-5c): `float` values are narrowed to 32 bits
 * as protoc stores them (`16777217` -> `16777216`, `1e-46` -> `0`, `1e39` -> Infinity); buf writes them widened to
 * double (`0.1` -> `0.10000000149011612`), both producers write `0.1`. The sign of zero is kept.
 */
const shortestFloat32 = (v: number): number => {
  if (!Number.isFinite(v)) return v
  const f = Math.fround(v)
  if (f === 0 || !Number.isFinite(f)) return f
  for (let p = 1; p <= 9; p++) {
    const x = Number(f.toPrecision(p))
    if (Math.fround(x) === f) return x
  }
  return f
}

/** Canonical form of a value of scalar kind `float` or `double`. */
export const canonFloatOf = (v: number, kind: ProtoScalar): number | string =>
  canonFloat(kind === "float" ? shortestFloat32(v) : v)

/** Integer range per scalar kind (options, defaults, descriptor `default_value`). */
export const INT_RANGE: Readonly<Partial<Record<ProtoScalar, readonly [bigint, bigint]>>> = {
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  sint32: [-(2n ** 31n), 2n ** 31n - 1n],
  sfixed32: [-(2n ** 31n), 2n ** 31n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  fixed32: [0n, 2n ** 32n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  sint64: [-(2n ** 63n), 2n ** 63n - 1n],
  sfixed64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
  fixed64: [0n, 2n ** 64n - 1n],
}

/** Canonical form of an integer value by scalar kind. */
export const canonInt = (v: bigint, kind: ProtoScalar): number | string =>
  INT64_KINDS.has(kind) ? v.toString() : Number(v)

// ---- base64 (no Buffer: browser-capable) -----------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

export const toBase64 = (bytes: Uint8Array): string => {
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`
  }
  return out
}

export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/")
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buf >> bits) & 255)
    }
  }
  return new Uint8Array(out)
}
