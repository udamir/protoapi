/**
 * Literal decoders for protobuf text (not from pbkit).
 *
 * String and bytes literals follow protoc's tokenizer (`Tokenizer::ParseStringAppend`): a literal is a byte string; `\NNN` (octal, 1-3 digits, truncated to a byte) and `\xH` / `\xHH` (hex) produce raw bytes, `\uXXXX` and `\UXXXXXXXX` produce the UTF-8 encoding of the code point, and every other character is UTF-8 encoded. Adjacent literals (`"a" 'b'`) are concatenated.
 *
 * Unlike protoc, which combines a `\u` high surrogate followed by a `\u` low surrogate, the scanner rejects every surrogate or out-of-range `\u` / `\U` escape (buf); a token not produced by the parser that has one decodes it to U+FFFD.
 */
import type { StrLit } from "./ast/lexical-elements.ts"

const simpleEscapes: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  "'": 0x27,
  '"': 0x22,
  "?": 0x3f,
}

function isOctal(c: number): boolean {
  return c >= 48 && c <= 55
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  return -1
}

function pushUtf8(out: number[], cp: number): void {
  if (cp < 0x80) out.push(cp)
  else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
  else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
}

function readHex(text: string, at: number, count: number): number {
  let value = 0
  for (let i = 0; i < count; i++) {
    const h = hexValue(text.charCodeAt(at + i))
    if (h < 0) return -1
    value = value * 16 + h
  }
  return value
}

/** Appends the bytes of one quoted literal token (with its quotes) to `out`. */
function appendTokenBytes(out: number[], token: string): void {
  const end = token.length - 1 // closing quote
  let i = 1 // after the opening quote
  while (i < end) {
    const c = token.charCodeAt(i)
    if (c !== 92 /* \ */) {
      const cp = token.codePointAt(i) ?? c
      pushUtf8(out, cp)
      i += cp > 0xffff ? 2 : 1
      continue
    }
    const e = token[i + 1]
    const ec = token.charCodeAt(i + 1)
    if (isOctal(ec)) {
      let value = 0
      let n = 0
      while (n < 3 && i + 1 + n < end && isOctal(token.charCodeAt(i + 1 + n))) {
        value = value * 8 + (token.charCodeAt(i + 1 + n) - 48)
        n++
      }
      out.push(value & 0xff)
      i += 1 + n
    } else if (e === "x" || e === "X") {
      let value = 0
      let n = 0
      while (n < 2 && i + 2 + n < end && hexValue(token.charCodeAt(i + 2 + n)) >= 0) {
        value = value * 16 + hexValue(token.charCodeAt(i + 2 + n))
        n++
      }
      out.push(value)
      i += 2 + n
    } else if (e === "u" || e === "U") {
      const digits = e === "u" ? 4 : 8
      const cp = readHex(token, i + 2, digits)
      i += 2 + digits
      pushUtf8(out, cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp)
    } else if (e !== undefined && e in simpleEscapes) {
      out.push(simpleEscapes[e])
      i += 2
    } else {
      // unknown escape (the tokenizer pattern accepts some upper-case letters): keep the character
      const cp = token.codePointAt(i + 1) ?? 0x5c
      pushUtf8(out, cp)
      i += cp > 0xffff ? 3 : 2
    }
  }
}

/** Decodes a (possibly concatenated) string or bytes literal to its bytes. */
export function decodeBytesLit(strLit: Pick<StrLit, "tokens">): Uint8Array {
  const out: number[] = []
  for (const token of strLit.tokens) appendTokenBytes(out, token.text)
  return Uint8Array.from(out)
}

/**
 * Decodes a (possibly concatenated) string literal: the literal's bytes (see `decodeBytesLit`) read as UTF-8, so
 * `"\303\251"` and `"é"` both give `é`. Invalid UTF-8 sequences become U+FFFD.
 */
export function decodeStrLit(strLit: Pick<StrLit, "tokens">): string {
  let simple = ""
  for (const token of strLit.tokens) {
    if (token.text.includes("\\")) return decodeUtf8(decodeBytesLit(strLit))
    simple += token.text.slice(1, -1)
  }
  return simple
}

/** UTF-8 → string, replacing invalid sequences with U+FFFD (WHATWG decoder behaviour). */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = ""
  let i = 0
  const n = bytes.length
  while (i < n) {
    const b0 = bytes[i]
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
      i++
      continue
    }
    let need = 0
    let cp = 0
    let lower = 0x80
    let upper = 0xbf
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1
      cp = b0 & 0x1f
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2
      cp = b0 & 0x0f
      if (b0 === 0xe0) lower = 0xa0
      if (b0 === 0xed) upper = 0x9f
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3
      cp = b0 & 0x07
      if (b0 === 0xf0) lower = 0x90
      if (b0 === 0xf4) upper = 0x8f
    } else {
      out += "\u{fffd}"
      i++
      continue
    }
    let j = 1
    for (; j <= need; j++) {
      const b = bytes[i + j]
      if (b === undefined || b < lower || b > upper) break
      cp = (cp << 6) | (b & 0x3f)
      lower = 0x80
      upper = 0xbf
    }
    if (j <= need) {
      out += "\u{fffd}"
      i += j
      continue
    }
    out += String.fromCodePoint(cp)
    i += need + 1
  }
  return out
}

const decimalPattern = /^(?:0|[1-9][0-9]*)$/
const hexPattern = /^0[xX][0-9a-fA-F]+$/
const octalPattern = /^0[0-7]+$/

/**
 * Parses an integer literal: decimal, `0x` hexadecimal or leading-`0` octal, with an optional `-` / `+` sign.
 * Throws a `RangeError` for any other text.
 */
export function parseIntLit(text: string): bigint {
  let sign = 1n
  let body = text.trim()
  if (body.startsWith("-") || body.startsWith("+")) {
    if (body[0] === "-") sign = -1n
    body = body.slice(1)
  }
  if (octalPattern.test(body)) return sign * BigInt(`0o${body.slice(1)}`)
  if (hexPattern.test(body) || decimalPattern.test(body)) return sign * BigInt(body)
  throw new RangeError(`invalid integer literal: ${JSON.stringify(text)}`)
}

/**
 * Parses a float literal: decimal / exponent forms (`1.5`, `.5`, `1.`, `1e-3`), `inf` / `infinity` / `nan` (any
 * case), integer literals (decimal, hex, octal), an optional sign, and the text-format `f` suffix (`1.5f`).
 * Returns `NaN` for text that is not a number.
 */
export function parseFloatLit(text: string): number {
  let body = text.trim()
  let sign = 1
  if (body.startsWith("-") || body.startsWith("+")) {
    if (body[0] === "-") sign = -1
    body = body.slice(1)
  }
  const lower = body.toLowerCase()
  if (lower === "inf" || lower === "infinity") return sign * Number.POSITIVE_INFINITY
  if (lower === "nan") return Number.NaN
  if (octalPattern.test(body) || hexPattern.test(body) || decimalPattern.test(body)) {
    return sign * Number(parseIntLit(body))
  }
  if (/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[fF]$/.test(body)) body = body.slice(0, -1)
  if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(body)) return Number.NaN
  return sign * Number(body)
}
