// Literal text -> values: integer and float literals, protobuf string literals and protoc's C-escaped bytes, UTF-8.

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

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s)
export const utf8Decode = (b: Uint8Array): string => new TextDecoder().decode(b)

/** The single-character escapes of protobuf string literals and of protoc's CEscape: `\n` -> 10, `\"` -> 34, … */
const SIMPLE_ESCAPES: Record<string, number> = {
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
    if (n in SIMPLE_ESCAPES) out.push(SIMPLE_ESCAPES[n])
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

/** Decode the source text of one or more adjacent protobuf string literals (`"a" 'b'`), as the parser accepted it, to bytes. Escapes: \a \b \f \n \r \t \v \\ \' \" \?, octal \NNN, hex \xHH, \uXXXX, \UXXXXXXXX (UTF-8 encoded). */
export const decodeStringLiteralBytes = (text: string): Uint8Array => {
  const out: number[] = []
  let i = 0
  const pushUtf8 = (s: string) => {
    for (const b of utf8Encode(s)) out.push(b)
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
      if (n in SIMPLE_ESCAPES) out.push(SIMPLE_ESCAPES[n])
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
        const cp = Number.parseInt(text.slice(i, i + len), 16)
        i += len
        // the parser rejects surrogate and out-of-range escapes (buf): only hand-written text reaches the U+FFFD
        pushUtf8(cp >= 0xd800 && (cp <= 0xdfff || cp > 0x10ffff) ? "\u{fffd}" : String.fromCodePoint(cp))
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
