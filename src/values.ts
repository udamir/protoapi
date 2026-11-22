// Canonical values (design §3.6, D7): 64-bit integers as decimal strings, non-finite floats as "Infinity" /
// "-Infinity" / "NaN", bytes as standard padded base64, enums as names.

import type { ProtoScalar } from "./types.ts"

export const INT64_KINDS = new Set<ProtoScalar>(["int64", "uint64", "sint64", "fixed64", "sfixed64"])
export const INT32_KINDS = new Set<ProtoScalar>(["int32", "uint32", "sint32", "fixed32", "sfixed32"])
export const FLOAT_KINDS = new Set<ProtoScalar>(["float", "double"])

export const SCALARS = new Set<string>([
  "double",
  "float",
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
  "bool",
  "string",
  "bytes",
])

export const isScalar = (name: string): name is ProtoScalar => SCALARS.has(name)

/** Wrapper well-known types and their scalar (`google.protobuf.StringValue` -> `string`). */
export const WRAPPERS: Record<string, ProtoScalar> = {
  "google.protobuf.DoubleValue": "double",
  "google.protobuf.FloatValue": "float",
  "google.protobuf.Int64Value": "int64",
  "google.protobuf.UInt64Value": "uint64",
  "google.protobuf.Int32Value": "int32",
  "google.protobuf.UInt32Value": "uint32",
  "google.protobuf.BoolValue": "bool",
  "google.protobuf.StringValue": "string",
  "google.protobuf.BytesValue": "bytes",
}

/** descriptor FieldDescriptorProto.Type -> scalar name */
export const DESCRIPTOR_SCALAR: Record<string, ProtoScalar> = {
  TYPE_DOUBLE: "double",
  TYPE_FLOAT: "float",
  TYPE_INT64: "int64",
  TYPE_UINT64: "uint64",
  TYPE_INT32: "int32",
  TYPE_FIXED64: "fixed64",
  TYPE_FIXED32: "fixed32",
  TYPE_BOOL: "bool",
  TYPE_STRING: "string",
  TYPE_BYTES: "bytes",
  TYPE_UINT32: "uint32",
  TYPE_SFIXED32: "sfixed32",
  TYPE_SFIXED64: "sfixed64",
  TYPE_SINT32: "sint32",
  TYPE_SINT64: "sint64",
}
/** descriptor type numbers (binary / numeric enum form) */
export const DESCRIPTOR_TYPE_BY_NUMBER: Record<number, string> = {
  1: "TYPE_DOUBLE",
  2: "TYPE_FLOAT",
  3: "TYPE_INT64",
  4: "TYPE_UINT64",
  5: "TYPE_INT32",
  6: "TYPE_FIXED64",
  7: "TYPE_FIXED32",
  8: "TYPE_BOOL",
  9: "TYPE_STRING",
  10: "TYPE_GROUP",
  11: "TYPE_MESSAGE",
  12: "TYPE_BYTES",
  13: "TYPE_UINT32",
  14: "TYPE_ENUM",
  15: "TYPE_SFIXED32",
  16: "TYPE_SFIXED64",
  17: "TYPE_SINT32",
  18: "TYPE_SINT64",
}

/** Parse an integer literal text (decimal, 0x hex, 0 octal, optional sign) to bigint; undefined when invalid. */
export const parseIntText = (text: string): bigint | undefined => {
  let t = text.trim()
  let neg = false
  if (t.startsWith("-")) {
    neg = true
    t = t.slice(1).trim()
  } else if (t.startsWith("+")) t = t.slice(1).trim()
  let v: bigint
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(t)) v = BigInt(t)
    else if (/^0[0-7]+$/.test(t)) v = BigInt(`0o${t.slice(1)}`)
    else if (/^[0-9]+$/.test(t)) v = BigInt(t)
    else return undefined
  } catch {
    return undefined
  }
  return neg ? -v : v
}

/** Parse a float literal text (`inf`, `nan`, `1e10`, `.5`, ints, optional sign, optional `f` suffix in text format). */
export const parseFloatText = (text: string): number | undefined => {
  let t = text.trim().toLowerCase()
  let neg = false
  if (t.startsWith("-")) {
    neg = true
    t = t.slice(1).trim()
  } else if (t.startsWith("+")) t = t.slice(1).trim()
  let v: number
  if (t === "inf" || t === "infinity") v = Number.POSITIVE_INFINITY
  else if (t === "nan") v = Number.NaN
  else {
    const i = parseIntText(t)
    if (i !== undefined && !/[.e]/.test(t)) v = Number(i)
    else {
      const s = t.endsWith("f") ? t.slice(0, -1) : t
      if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s)) return undefined
      v = Number(s)
    }
  }
  return neg ? -v : v
}

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
export const shortestFloat32 = (v: number): number => {
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

export const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s)
export const utf8Decode = (b: Uint8Array): string => new TextDecoder().decode(b)

/** Decode protoc's C-escaped `default_value` for bytes fields (CEscape: octal escapes, \n, \", …). */
export const unescapeC = (text: string): Uint8Array => {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== "\\") {
      for (const b of utf8Encode(ch)) out.push(b)
      continue
    }
    const n = text[++i]
    const simple: Record<string, number> = {
      n: 10,
      r: 13,
      t: 9,
      a: 7,
      b: 8,
      f: 12,
      v: 11,
      "\\": 92,
      "'": 39,
      '"': 34,
      "?": 63,
    }
    if (n in simple) out.push(simple[n])
    else if (/[0-7]/.test(n)) {
      let j = i
      let s = ""
      while (j < text.length && s.length < 3 && /[0-7]/.test(text[j])) s += text[j++]
      out.push(Number.parseInt(s, 8) & 255)
      i = j - 1
    } else if (n === "x" || n === "X") {
      let j = i + 1
      let s = ""
      while (j < text.length && s.length < 2 && /[0-9a-fA-F]/.test(text[j])) s += text[j++]
      out.push(Number.parseInt(s, 16) & 255)
      i = j - 1
    } else if (n !== undefined) for (const b of utf8Encode(n)) out.push(b)
  }
  return new Uint8Array(out)
}

/** protoc's default JSON name (rule J). */
export const defaultJsonName = (name: string): string => {
  let out = ""
  let upper = false
  for (const ch of name) {
    if (ch === "_") upper = true
    else if (upper) {
      out += ch.toUpperCase()
      upper = false
    } else out += ch
  }
  return out
}

/** lowerCamelCase -> snake_case (generic rule for unknown definitions). */
export const toSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Decode the source text of one or more adjacent protobuf string literals (`"a" 'b'`) to bytes. Escapes: \a \b \f
 *  \n \r \t \v \\ \' \" \?, octal \NNN, hex \xHH, \uXXXX, \UXXXXXXXX (UTF-8 encoded). */
export const decodeStringLiteralBytes = (text: string): Uint8Array => {
  const out: number[] = []
  let i = 0
  const pushUtf8 = (s: string) => {
    for (const b of utf8Encode(s)) out.push(b)
  }
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    "\\": 92,
    "'": 39,
    '"': 34,
    "?": 63,
  }
  while (i < text.length) {
    const q = text[i]
    if (q !== '"' && q !== "'") {
      i++
      continue
    }
    i++
    while (i < text.length && text[i] !== q) {
      const ch = text[i]
      if (ch !== "\\") {
        const s = String.fromCodePoint(text.codePointAt(i) ?? 0)
        pushUtf8(s)
        i += s.length
        continue
      }
      const n = text[i + 1]
      i += 2
      if (n in simple) out.push(simple[n])
      else if (n >= "0" && n <= "7") {
        let s = n
        while (s.length < 3 && text[i] >= "0" && text[i] <= "7") s += text[i++]
        out.push(Number.parseInt(s, 8) & 255)
      } else if (n === "x" || n === "X") {
        let s = ""
        while (s.length < 2 && /[0-9a-fA-F]/.test(text[i] ?? "")) s += text[i++]
        out.push(Number.parseInt(s || "0", 16) & 255)
      } else if (n === "u" || n === "U") {
        const len = n === "u" ? 4 : 8
        const hex = text.slice(i, i + len)
        i += len
        pushUtf8(String.fromCodePoint(Number.parseInt(hex, 16)))
      } else if (n !== undefined) pushUtf8(n)
    }
    i++ // closing quote
  }
  return new Uint8Array(out)
}

export const decodeStringLiteral = (text: string): string => {
  // fast path: one literal without escapes
  const q = text[0]
  if ((q === '"' || q === "'") && text.length >= 2 && text[text.length - 1] === q) {
    const inner = text.slice(1, -1)
    if (!inner.includes("\\") && !inner.includes(q)) return inner
  }
  return utf8Decode(decodeStringLiteralBytes(text))
}
