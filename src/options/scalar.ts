// Scalar constants: the value type an option value is typed against, and the conversion of the source text of a
// scalar constant (an option value, a text-format value, a `[default = …]`) to its canonical value.

import type { ProtoScalar } from "../types.ts"
import type { MEnum, MMessage } from "../model.ts"
import { canonFloatOf, canonInt, INT_RANGE, toBase64 } from "../values/canonical.ts"
import { decodeStringLiteral, decodeStringLiteralBytes, parseFloatText, parseIntText } from "../values/literals.ts"
import { FLOAT_KINDS } from "../values/scalars.ts"

export type VType =
  | { kind: "scalar"; scalar: ProtoScalar }
  | { kind: "enum"; def?: MEnum }
  | { kind: "message"; def?: MMessage; fqn?: string }
  | { kind: "unknown" }

/** The result of converting a value: the canonical value, or why the value is not valid (for the issue message). */
export type Converted = { ok: true; value: unknown } | { ok: false; reason: string }

export const valid = (value: unknown): Converted => ({ ok: true, value })
export const invalid = (reason: string): Converted => ({ ok: false, reason })

/** An enum value by number in its canonical form: the value's name when the enum has one, else the number. */
export const enumName = (def: MEnum | undefined, v: string | number): unknown => {
  if (typeof v === "number") {
    const found = def?.values.find((x) => x.number === v)
    return found ? found.name : v
  }
  return v
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true })
/** A string literal whose escapes do not form valid UTF-8 (`"\377"`) is not a valid `string` value (buf). */
const isValidUtf8Literal = (text: string): boolean => {
  if (!text.includes("\\")) return true
  try {
    utf8Strict.decode(decodeStringLiteralBytes(text))
    return true
  } catch {
    return false
  }
}

const SIGNED_HEX = /^[-+]?\s*0[xX]/
/** `1e3`: protoc / buf accept an exponent literal without a fraction for an integer option or default */
const EXPONENT_INT = /^([-+]?)\s*(\d+)[eE]\+?(\d+)$/

const parseIntConstant = (text: string, strict: boolean): bigint | undefined => {
  const v = parseIntText(text)
  if (v !== undefined || !strict) return v
  const m = EXPONENT_INT.exec(text.trim())
  if (!m || m[3].length > 4) return undefined
  const n = BigInt(m[2]) * 10n ** BigInt(m[3])
  return m[1] === "-" ? -n : n
}

/**
 * Convert the source text of a scalar constant to its canonical value. `strict`: a `.proto` constant (option statement
 * value or `[default = …]`), whose spellings are narrower than text format's (buf: "non-canonical `bool` literal
 * outside of message expression"); otherwise a text-format value inside an aggregate. Not valid (with the reason): a
 * value of the wrong type, an integer out of range for its kind, an unknown or qualified enum identifier, a
 * non-canonical bool / float spelling, a hexadecimal float, or a `string` that is not UTF-8.
 */
export const fromScalarText = (text: string, isString: boolean, t: VType, strict = false): Converted => {
  if (t.kind === "scalar") {
    const s = t.scalar
    if (s === "string") {
      if (!isString) return invalid("a string literal is expected")
      return isValidUtf8Literal(text) ? valid(decodeStringLiteral(text)) : invalid("the string is not valid UTF-8")
    }
    if (s === "bytes")
      return isString ? valid(toBase64(decodeStringLiteralBytes(text))) : invalid("a string literal is expected")
    if (isString) return invalid(`a string literal is not a ${s} value`)
    if (s === "bool") {
      if (text === "true" || (!strict && (text === "True" || text === "t"))) return valid(true)
      if (text === "false" || (!strict && (text === "False" || text === "f"))) return valid(false)
      return invalid(
        strict && /^(True|False|t|f)$/.test(text)
          ? `${text} is a text-format spelling; a bool option or default must be true or false`
          : `${text} is not a bool value`,
      )
    }
    if (FLOAT_KINDS.has(s)) {
      if (SIGNED_HEX.test(text)) return invalid(`${text}: a hexadecimal literal is not a ${s} value`)
      const word = text.replace(/^[-+]\s*/, "")
      if (/^[A-Za-z]/.test(word)) {
        const lower = word.toLowerCase()
        if (strict ? word !== "inf" && word !== "nan" : lower !== "inf" && lower !== "infinity" && lower !== "nan")
          return invalid(
            strict && (lower === "inf" || lower === "infinity" || lower === "nan")
              ? `${text} is a text-format spelling; a ${s} option or default uses inf or nan`
              : `${text} is not a ${s} value`,
          )
      } else if (/[fF]$/.test(word)) return invalid(`${text}: a float suffix is not allowed`)
      const v = parseFloatText(text)
      return v === undefined ? invalid(`${text} is not a ${s} value`) : valid(canonFloatOf(v, s))
    }
    const v = parseIntConstant(text, strict)
    if (v === undefined) return invalid(`${text} is not an integer`)
    const range = INT_RANGE[s]
    if (range && (v < range[0] || v > range[1])) return invalid(`${text} is out of range for ${s}`)
    return valid(canonInt(v, s))
  }
  if (t.kind === "enum") {
    if (isString) return invalid("an enum value is expected, not a string")
    const n = parseIntText(text)
    if (n !== undefined) {
      if (n < -(2n ** 31n) || n >= 2n ** 31n) return invalid(`${text} is out of range for an enum value`)
      return valid(enumName(t.def, Number(n)))
    }
    if (text.includes(".")) return invalid(`${text}: an enum value is written without qualification`)
    if (t.def && !t.def.values.some((v) => v.name === text)) return invalid(`${t.def.fqn} has no value ${text}`)
    return valid(text)
  }
  return invalid("not a scalar value")
}
