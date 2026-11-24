// ProtoJSON option values (descriptor input): option messages and values with JSON keys and special forms converted
// to the canonical tree.

import type { MField, MMessage } from "../model.ts"
import { isPlainObject } from "../common/objects.ts"
import { canonFloatOf, fromBase64, toBase64 } from "../values/canonical.ts"
import { toSnake } from "../values/json-name.ts"
import { parseFloatText, parseIntText } from "../values/literals.ts"
import { FLOAT_KINDS, INT32_KINDS, INT64_KINDS } from "../values/scalars.ts"
import { OPTIONS_MESSAGES } from "./kinds.ts"
import { type VType, enumName } from "./scalar.ts"
import { extensionOf, fieldByJsonKey, mapValueType, typeOfRef } from "./definitions.ts"
import { isAbsentValue } from "./presence.ts"
import { orderTree, snakeKeys } from "./tree.ts"
import { WKT_JSON_VALUES, WKT_VALUE_FORM, anyValue, fromWktJson } from "./wkt.ts"
import { OptionStatementReader } from "./statement.ts"

/** The ProtoJSON layer of the option interpreter. */
export class ProtoJsonReader extends OptionStatementReader {
  /** Convert a ProtoJSON message of type `def` (an `*Options` message or an option value) to the canonical tree. */
  jsonMessage(obj: Record<string, unknown>, def: MMessage | undefined, sub: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      const ext = /^\[(.+)\]$/.exec(k)
      let field: MField | undefined
      let key: string
      if (ext) {
        key = ext[1]
        field = def ? extensionOf(this.ctx.symbols, def.fqn, key) : undefined
        if (!field) {
          this.issue("unknown-option", `unknown option ${key}`, undefined, sub ? undefined : `options/${key}`)
          out[key] = v as unknown
          continue
        }
      } else {
        field = def ? fieldByJsonKey(def, k) : undefined
        key = field?.name ?? toSnake(k)
        if (!field) {
          // C-11: a field the definition does not have is kept raw, keys converted by the generic rule
          if (def)
            this.issue(
              "unknown-option",
              `${def.fqn} has no field "${key}"; the value is kept as written`,
              undefined,
              sub ? undefined : `options/${key}`,
            )
          out[key] = snakeKeys(v)
          continue
        }
        // never part of a descriptor's meaning; ProtoJSON with implicit fields writes it as [] (C-14)
        if (key === "uninterpreted_option" && def && OPTIONS_MESSAGES.has(def.fqn)) continue
      }
      const outer = this.currentSub
      if (!sub) this.currentSub = `options/${key}`
      const value = this.jsonField(v, field)
      this.currentSub = outer
      if (def && isAbsentValue(value, field, def, this.ctx.symbols)) continue
      out[key] = value
    }
    return out
  }

  /** A ProtoJSON `Any` (`{ "@type": url, … }`) in the canonical form of `anyText` (C-9). */
  private anyJson(v: Record<string, unknown>): Record<string, unknown> {
    const url = String(v["@type"])
    const fqn = url.slice(url.lastIndexOf("/") + 1)
    const def = this.ctx.symbols.message(fqn)
    const rest: Record<string, unknown> = { ...v }
    delete rest["@type"]
    if (!def) {
      this.issue("unknown-option", `unknown type ${url} in an Any option value; the value is kept as written`)
      return { "@type": url, ...(snakeKeys(rest) as Record<string, unknown>) }
    }
    if (fqn === "google.protobuf.Any")
      return anyValue(url, fqn, isPlainObject(rest.value) ? this.anyJson(rest.value) : {})
    if (WKT_VALUE_FORM.has(fqn) || WKT_JSON_VALUES.has(fqn)) {
      const msg =
        fromWktJson(fqn, rest.value) ?? (isPlainObject(rest.value) ? this.jsonMessage(rest.value, def, "value") : {})
      return anyValue(url, fqn, orderTree(msg as Record<string, unknown>, def, this.ctx.symbols))
    }
    return anyValue(url, fqn, orderTree(this.jsonMessage(rest, def, "value"), def, this.ctx.symbols))
  }

  private jsonField(v: unknown, field: MField): unknown {
    const symbols = this.ctx.symbols
    if (field.map) {
      if (!isPlainObject(v)) return v
      const vt = mapValueType(field, symbols)
      const out: Record<string, unknown> = {}
      for (const [mk, mv] of Object.entries(v)) out[mk] = this.jsonSingle(mv, vt)
      return out
    }
    const t = typeOfRef(field, symbols)
    if (field.repeated) return Array.isArray(v) ? v.map((x) => this.jsonSingle(x, t)) : [this.jsonSingle(v, t)]
    return this.jsonSingle(v, t)
  }

  private jsonSingle(v: unknown, t: VType): unknown {
    if (t.kind === "scalar") {
      const s = t.scalar
      if (INT64_KINDS.has(s)) {
        const n = parseIntText(String(v))
        return n === undefined ? v : n.toString()
      }
      if (INT32_KINDS.has(s)) return typeof v === "string" ? Number(v) : v
      if (FLOAT_KINDS.has(s)) {
        if (typeof v === "number") return canonFloatOf(v, s)
        const n = parseFloatText(String(v))
        return n === undefined ? v : canonFloatOf(n, s)
      }
      if (s === "bytes") return typeof v === "string" ? toBase64(fromBase64(v)) : v
      return v
    }
    if (t.kind === "enum") return typeof v === "number" ? enumName(t.def, v) : v
    if (t.kind === "message") {
      if (t.fqn === "google.protobuf.Any" && isPlainObject(v) && typeof v["@type"] === "string") return this.anyJson(v)
      const wkt = t.fqn ? fromWktJson(t.fqn, v) : undefined
      if (wkt !== undefined) return wkt
      return isPlainObject(v) ? this.jsonMessage(v, t.def, "value") : v
    }
    return v
  }
}
