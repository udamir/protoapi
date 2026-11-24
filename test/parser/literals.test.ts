import { describe, expect, test } from "vite-plus/test"
import { decodeBytesLit, decodeStrLit, decodeUtf8, parseFloatLit, parseIntLit } from "../../src/parser/index.ts"
import { bs } from "./helpers.ts"

/** A StrLit-like value from raw token texts (quotes included). */
const lit = (...tokens: string[]) => ({ tokens: tokens.map((text) => ({ start: 0, end: text.length, text })) })
const bytes = (...tokens: string[]) => Array.from(decodeBytesLit(lit(...tokens)))

describe("decodeStrLit", () => {
  test("plain and concatenated literals", () => {
    expect(decodeStrLit(lit('"abc"'))).toBe("abc")
    expect(decodeStrLit(lit("'a'", '"b"', '""'))).toBe("ab")
    expect(decodeStrLit(lit('"é\u{1F600}"'))).toBe("é\u{1F600}")
  })

  test("simple escapes", () => {
    const src = `"${bs}a${bs}b${bs}f${bs}n${bs}r${bs}t${bs}v${bs}${bs}${bs}'${bs}"${bs}?"`
    expect(decodeStrLit(lit(src))).toBe("\x07\b\f\n\r\t\v\\'\"?")
  })

  test("octal escapes: 1 to 3 digits", () => {
    expect(decodeStrLit(lit(`"${bs}101${bs}60${bs}7x"`))).toBe("A0\x07x")
    expect(decodeStrLit(lit(`"${bs}1012"`))).toBe("A2") // at most three digits
    expect(decodeStrLit(lit(`"${bs}303${bs}251"`))).toBe("é") // UTF-8 bytes of é
  })

  test("hex escapes: 1 to 2 digits", () => {
    expect(decodeStrLit(lit(`"${bs}x41${bs}x4${bs}x7e1"`))).toBe("A\x04~1")
    expect(decodeStrLit(lit(`"${bs}xc3${bs}xA9"`))).toBe("é")
  })

  test("unicode escapes", () => {
    expect(decodeStrLit(lit(`"${bs}u00e9${bs}u20AC"`))).toBe("é€")
    expect(decodeStrLit(lit(`"${bs}U0001F600"`))).toBe("\u{1F600}")
    // the scanner rejects surrogate and out-of-range escapes (buf); a hand-made token decodes them to U+FFFD
    expect(decodeStrLit(lit(`"${bs}ud83d${bs}ude00${bs}U00110000"`))).toBe("\u{FFFD}\u{FFFD}\u{FFFD}")
  })

  test("invalid UTF-8 becomes U+FFFD", () => {
    expect(decodeStrLit(lit(`"a${bs}377b"`))).toBe("a\u{FFFD}b")
    expect(decodeStrLit(lit(`"${bs}xe2${bs}x82"`))).toBe("\u{FFFD}")
  })
})

describe("decodeBytesLit", () => {
  test("raw bytes from octal and hex escapes, UTF-8 for other characters", () => {
    expect(bytes(`"${bs}377${bs}000"`)).toEqual([0xff, 0x00])
    expect(bytes(`"${bs}x01${bs}x02"`)).toEqual([1, 2])
    expect(bytes(`"é"`)).toEqual([0xc3, 0xa9])
    expect(bytes(`"${bs}u00e9"`)).toEqual([0xc3, 0xa9])
    expect(bytes(`"${bs}U0001F600"`, "'!'")).toEqual([0xf0, 0x9f, 0x98, 0x80, 0x21])
    expect(bytes(`"${bs}777"`)).toEqual([0xff]) // truncated to a byte, as protoc
    expect(bytes(`"${bs}n${bs}${bs}"`)).toEqual([10, 92])
  })
})

describe("decodeUtf8", () => {
  test("round trip and replacement", () => {
    expect(decodeUtf8(Uint8Array.from([0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]))).toBe("aé\u{1F600}")
    expect(decodeUtf8(Uint8Array.from([0xc0, 0xaf]))).toBe("\u{FFFD}\u{FFFD}")
    expect(decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80]))).toBe("\u{FFFD}\u{FFFD}\u{FFFD}") // surrogate
  })
})

describe("parseIntLit", () => {
  test("decimal, hex, octal, signs, 64-bit range", () => {
    expect(parseIntLit("0")).toBe(0n)
    expect(parseIntLit("42")).toBe(42n)
    expect(parseIntLit("0x1F")).toBe(31n)
    expect(parseIntLit("0X1f")).toBe(31n)
    expect(parseIntLit("017")).toBe(15n)
    expect(parseIntLit("-0x7f")).toBe(-127n)
    expect(parseIntLit("+5")).toBe(5n)
    expect(parseIntLit("-9223372036854775808")).toBe(-9223372036854775808n)
    expect(parseIntLit("18446744073709551615")).toBe(18446744073709551615n)
  })
  test("rejects non-integers", () => {
    expect(() => parseIntLit("1.5")).toThrow(RangeError)
    expect(() => parseIntLit("08")).toThrow(RangeError)
    expect(() => parseIntLit("abc")).toThrow(RangeError)
  })
})

describe("parseFloatLit", () => {
  test("special values", () => {
    expect(parseFloatLit("inf")).toBe(Number.POSITIVE_INFINITY)
    expect(parseFloatLit("-inf")).toBe(Number.NEGATIVE_INFINITY)
    expect(parseFloatLit("Infinity")).toBe(Number.POSITIVE_INFINITY)
    expect(parseFloatLit("nan")).toBeNaN()
    expect(parseFloatLit("-nan")).toBeNaN()
  })
  test("decimal and exponent forms, integers, f suffix", () => {
    expect(parseFloatLit("1e-3")).toBe(0.001)
    expect(parseFloatLit("1E300")).toBe(1e300)
    expect(parseFloatLit(".5")).toBe(0.5)
    expect(parseFloatLit("1.")).toBe(1)
    expect(parseFloatLit("-2.5e+2")).toBe(-250)
    expect(parseFloatLit("5")).toBe(5)
    expect(parseFloatLit("0x10")).toBe(16)
    expect(parseFloatLit("017")).toBe(15)
    expect(parseFloatLit("2.5f")).toBe(2.5)
    expect(parseFloatLit("abc")).toBeNaN()
  })
})
