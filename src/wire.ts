// Protobuf wire format decoder: a message from its binary encoding, in the canonical option-value form. Used for the
// payload of an `Any` written with `type_url` and `value`, and for the records of a binary descriptor set.

import type { ProtoScalar } from "./types.ts"
import type { MField, MMessage } from "./model/index.ts"
import type { SymbolTable } from "./symbols.ts"
import { canonFloat, canonFloatOf, canonInt, toBase64 } from "./values/canonical.ts"
import { utf8Decode } from "./values/literals.ts"
import { type VType, enumName, zeroValue } from "./options/scalar.ts"
import { refType, typeOfRef } from "./options/definitions.ts"
import { isAbsentValue } from "./options/presence.ts"
import { hasKey, setKey } from "./common/objects.ts"

/** A field of a definition made for `decodeWire`, its value type given. */
type WireField = MField & { vt?: VType }

/** A message definition for `decodeWire`: `[number, name, type, repeated]` per field (proto2 presence). */
export const wireDef = (fields: [number, string, VType, boolean?][]): MMessage =>
  ({
    file: { syntax: "proto2" },
    fields: fields.map(([number, name, vt, repeated]) => ({ number, name, vt, repeated, type: { kind: "named" } })),
  }) as unknown as MMessage

export const scalarType = (scalar: ProtoScalar): VType => ({ kind: "scalar", scalar })

/** A message from its wire bytes, in the form of `textprotoMessage` (fields by number, unknown ones skipped, rule D); `any` expands a decoded `google.protobuf.Any`. Throws a RangeError on malformed bytes. */
export const decodeWire = (
  b: Uint8Array,
  def: MMessage,
  symbols: SymbolTable,
  any = (m: Record<string, unknown>) => m,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  let p = 0
  const take = (n: number) => {
    if (p + n > b.length) throw RangeError()
    return b.subarray(p, (p += n))
  }
  const varint = (): bigint => {
    let v = 0n
    for (let s = 0n; ; s += 7n) {
      const c = take(1)[0]
      v |= BigInt(c & 127) << s
      if (c < 128) return v
    }
  }
  const len = () => take(Number(varint()))
  /** one value of type `t` with wire type `w` */
  const value = (t: VType, w: number): unknown => {
    const s = t.kind === "scalar" ? t.scalar : "int32"
    if (w === 2) {
      const x = len()
      return t.kind === "message"
        ? decodeWire(x, t.def as MMessage, symbols, any)
        : s === "string"
          ? utf8Decode(x)
          : toBase64(x)
    }
    // fixed64 / fixed32; groups (3, 4) and unknown wire types fail in `take`
    const x = w ? new DataView(take(w === 1 ? 8 : w === 5 ? 4 : Number.POSITIVE_INFINITY).slice().buffer) : undefined
    if (s === "double") return canonFloat(x?.getFloat64(0, true) ?? 0)
    if (s === "float") return canonFloatOf(x?.getFloat32(0, true) ?? 0, s)
    let v = !x ? varint() : w === 1 ? x.getBigUint64(0, true) : BigInt(x.getUint32(0, true))
    if (s === "bool") return v !== 0n
    if (s.startsWith("sint")) v = (v >> 1n) ^ -(v & 1n)
    const bits = s.endsWith("32") ? 32 : 64
    v = s[0] === "u" || s[0] === "f" ? BigInt.asUintN(bits, v) : BigInt.asIntN(bits, v)
    return t.kind === "enum" ? enumName(t.def, Number(v)) : canonInt(v, s)
  }
  while (p < b.length) {
    const tag = Number(varint())
    const w = tag & 7
    const f = def.fields.find((x) => x.number === tag >>> 3) as WireField | undefined
    const m = f?.map
    // a map entry is a message of `key` (1) and `value` (2)
    const t: VType | undefined = m
      ? {
          kind: "message",
          def: wireDef([
            [1, "key", scalarType(m.key)],
            [2, "value", refType(m.value, symbols)],
          ]),
        }
      : f && (f.vt ?? typeOfRef(f, symbols))
    const e = !t ? -1 : t.kind === "message" ? 2 : t.kind === "scalar" ? (WIRE_TYPE[t.scalar] ?? 0) : 0
    const packed = f?.repeated && w === 2 && e !== 2
    if (!f || !t || (w !== e && !packed)) {
      // an unknown field, or a known one with another wire type: skipped
      if (w === 2) len()
      else value(scalarType("uint64"), w)
      continue
    }
    const values: unknown[] = []
    if (packed) for (const end = Number(varint()) + p; p < end;) values.push(value(t, e))
    else values.push(value(t, w))
    for (const v of values) {
      if (!m) {
        if (!f.repeated) setKey(out, f.name, v)
        else if (hasKey(out, f.name)) (out[f.name] as unknown[]).push(v)
        else setKey(out, f.name, [v])
        continue
      }
      // a missing key or value is the zero value of its type
      const entry = v as { key?: unknown; value?: unknown }
      const key = "key" in entry ? entry.key : zeroValue(scalarType(m.key))
      if (!hasKey(out, f.name)) setKey(out, f.name, {})
      setKey(
        out[f.name] as Record<string, unknown>,
        String(key),
        "value" in entry ? entry.value : zeroValue(refType(m.value, symbols)),
      )
    }
  }
  for (const f of def.fields) if (hasKey(out, f.name) && isAbsentValue(out[f.name], f, def, symbols)) delete out[f.name]
  return def.fqn === "google.protobuf.Any" ? any(out) : out
}

/** Wire types of the scalars that are not varints. */
const WIRE_TYPE: Record<string, number> = {
  double: 1,
  fixed64: 1,
  sfixed64: 1,
  float: 5,
  fixed32: 5,
  sfixed32: 5,
  string: 2,
  bytes: 2,
}
