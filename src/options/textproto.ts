// Text-format option values: protobuf constants and aggregates (`{ … }`) typed against their definitions, expanded
// `Any` values, and the best-effort JSON form of a value without a definition.

import type { Location } from "../types.ts"
import type { MField, MMessage } from "../model/index.ts"
import type { AggregateNode, Spanned, TextprotoFieldNode } from "../frontend/text/nodes.ts"
import { tokensText } from "../frontend/text/nodes.ts"
import { isPlainObject } from "../common/objects.ts"
import { canonFloat, fromBase64 } from "../values/canonical.ts"
import { decodeStringLiteral, parseFloatText, parseIntText } from "../values/literals.ts"
import { decodeWire } from "../wire.ts"
import { OptionReader } from "./context.ts"
import { type Converted, type VType, fromScalarText, invalid, valid } from "./scalar.ts"
import { fieldByName, mapValueType, typeOfRef } from "./definitions.ts"
import { isAbsentValue } from "./presence.ts"
import { addRaw, orderTree } from "./tree.ts"
import { anyValue } from "./wkt.ts"

/** marks a text-format field whose value equals an absent one (removed when the message is complete) */
const ABSENT = Symbol("absent")

const lastName = (t: { name: string }) => {
  const i = t.name.lastIndexOf(".")
  return i < 0 ? t.name : t.name.slice(i + 1)
}

/** The text-format layer of the option interpreter. */
export class TextFormatReader extends OptionReader {
  /** Typed value of a protobuf constant for `field` (a field of an options message or of an option's type). */
  constantValue(constant: Spanned, field: MField, loc?: Location): Converted {
    if (constant.type === "aggregate") {
      const t = typeOfRef(field, this.ctx.symbols)
      if (t.kind !== "message" || !t.def) return invalid("an aggregate value needs a message-typed option")
      return valid(this.textprotoMessage((constant as AggregateNode).statements, t.def, loc))
    }
    const t = typeOfRef(field, this.ctx.symbols)
    if (t.kind === "message") return invalid("a message-typed option needs an aggregate value { … }")
    return fromScalarText(this.src(constant).trim(), constant.type === "str-lit", t, true)
  }

  private textprotoScalar(node: Spanned, t: VType): Converted {
    const text = this.src(node).trim()
    return fromScalarText(text, node.type === "textproto-str-lit", t)
  }

  private textprotoValue(node: Spanned & { statements?: Spanned[] }, t: VType, loc?: Location): Converted {
    if (node.type === "textproto-message-value") {
      if (t.kind !== "message" || !t.def) return invalid("a message value is not allowed for this field")
      return valid(this.textprotoMessage(node.statements ?? [], t.def, loc))
    }
    if (t.kind === "message") return invalid("a message field needs a message value { … }")
    return this.textprotoScalar(node, t)
  }

  /** Typed object from text-format message statements against a message definition. */
  textprotoMessage(statements: Spanned[], def: MMessage, loc?: Location): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const st of statements) {
      if (st.type !== "textproto-field") continue
      const tf = st as TextprotoFieldNode
      const fname = tf.fieldName
      let field: MField | undefined
      let key: string
      if (fname.type === "textproto-extension-name") {
        const name = tokensText(fname.typeName, (n) => this.src(n))
        const entry =
          this.ctx.symbols.extensionByName.get(name.replace(/^\./, "")) ??
          (() => {
            const s = this.ctx.symbols.lookup(name, this.ctx.scope, "extension", this.from).found
            return s ? this.ctx.symbols.extensionByName.get(s.fqn) : undefined
          })()
        if (!entry || entry.field.extendee?.resolved !== def.fqn) {
          this.issue("unknown-option", `unknown extension [${name}] in an option value of type ${def.fqn}`, loc)
          out[name.replace(/^\./, "")] = this.src(tf.value)
          continue
        }
        field = entry.field
        key = entry.fqn
      } else if (fname.type === "textproto-any-name") {
        const url = this.src(fname)
          .replace(/^\[|\]$/g, "")
          .replace(/\s+/g, "")
        Object.assign(out, this.anyText(url, tf.value, loc))
        continue
      } else {
        const name = this.src(fname)
        field =
          fieldByName(def, name) ??
          def.fields.find((f) => f.group && f.type.kind === "named" && lastName(f.type) === name)
        key = field?.name ?? name
        if (!field) {
          // C-11: a field the definition does not have (an older or newer version of it) is kept raw
          this.issue("unknown-option", `${def.fqn} has no field "${name}"; the value is kept as written`, loc)
          addRaw(out, name, this.bestEffort(tf.value))
          continue
        }
      }
      const t = field.map ? undefined : typeOfRef(field, this.ctx.symbols)
      const values: Spanned[] =
        tf.value.type === "textproto-list-value"
          ? (tf.value.valueOrCommas ?? []).filter((v) => v.type !== "textproto-comma")
          : [tf.value]
      for (const v of values) {
        if (field.map) {
          const entry = this.mapEntryValue(v, field, loc)
          if (!entry) continue
          const m = (out[key] ??= {}) as Record<string, unknown>
          m[entry.key] = entry.value
          continue
        }
        const result = this.textprotoValue(v, t as VType, loc)
        if (!result.ok) {
          this.issue("invalid-option", `invalid value for ${def.fqn}.${field.name}: ${result.reason}`, loc)
          continue
        }
        const converted = result.value
        if (!field.repeated && isAbsentValue(converted, field, def, this.ctx.symbols)) {
          if (key in out) this.issue("invalid-option", `${def.fqn}.${field.name} is set more than once`, loc)
          out[key] = ABSENT
          continue
        }
        if (field.repeated) {
          const arr = (out[key] ??= []) as unknown[]
          arr.push(converted)
        } else {
          if (key in out) this.issue("invalid-option", `${def.fqn}.${field.name} is set more than once`, loc)
          out[key] = converted
        }
      }
    }
    for (const k in out) if (out[k] === ABSENT) delete out[k]
    return def.fqn === "google.protobuf.Any" ? this.anyFields(out, loc) : out
  }

  /** An `Any` written with its fields (`{ type_url: "…" value: "\x08\x01" }`) in the expanded form of `anyText`, the payload decoded from `value` as buf does. An empty `Any` stays `{}`; a `value` without `type_url`, an unknown type or bytes that do not decode are an `unknown-option`, kept as written. */
  private anyFields(any: Record<string, unknown>, loc?: Location): Record<string, unknown> {
    const url = any.type_url
    // an expanded or an empty Any
    if (url === undefined && (any.value === undefined || "@type" in any)) return any
    const fqn = String(url).slice(String(url).lastIndexOf("/") + 1)
    const def = this.ctx.symbols.message(fqn) as MMessage
    try {
      return anyValue(
        url as string,
        fqn,
        orderTree(
          decodeWire(fromBase64(String(any.value ?? "")), def, this.ctx.symbols, (m) => this.anyFields(m)),
          def,
          this.ctx.symbols,
        ),
      )
    } catch {
      this.issue(
        "unknown-option",
        `the Any value of type ${url ?? "(no type_url)"} cannot be decoded; it is kept as written`,
        loc,
      )
      return any
    }
  }

  /** A map entry message (`{ key: … value: … }`); undefined when it is not one or a key or value is not valid. */
  private mapEntryValue(
    v: Spanned & { statements?: Spanned[] },
    field: MField,
    loc?: Location,
  ): { key: string; value: unknown } | undefined {
    if (v.type !== "textproto-message-value") return undefined
    let k: Converted | undefined
    let val: Converted | undefined
    for (const st of v.statements ?? []) {
      if (st.type !== "textproto-field") continue
      const tf = st as TextprotoFieldNode
      const n = this.src(tf.fieldName)
      if (n === "key") k = this.textprotoScalar(tf.value, { kind: "scalar", scalar: field.map?.key ?? "string" })
      else if (n === "value") {
        const vt = mapValueType(field, this.ctx.symbols)
        val = this.textprotoValue(tf.value, vt, loc)
      }
    }
    if (k === undefined || !k.ok || (val !== undefined && !val.ok)) return undefined
    return { key: String(k.value), value: val?.ok ? val.value : undefined }
  }

  /**
   * An expanded `Any` (`[type.googleapis.com/pkg.T] { … }`) in the ProtoJSON form `{ "@type": url, …fields }`, typed
   * against the payload type (C-9, decision 2). Well-known payload types use their ProtoJSON `value` form. An unknown
   * type gives an `unknown-option` issue and a best-effort value.
   */
  private anyText(url: string, value: Spanned & { statements?: Spanned[] }, loc?: Location): Record<string, unknown> {
    const fqn = url.slice(url.lastIndexOf("/") + 1)
    const def = this.ctx.symbols.message(fqn)
    if (!def || value.type !== "textproto-message-value") {
      this.issue("unknown-option", `unknown type ${url} in an Any option value; the value is kept as written`, loc)
      const raw = this.bestEffort(value)
      return { "@type": url, ...(isPlainObject(raw) ? raw : { value: raw }) }
    }
    const payload = this.textprotoMessage(value.statements ?? [], def, loc)
    return anyValue(url, fqn, orderTree(payload, def, this.ctx.symbols))
  }

  /**
   * A text-format value without a definition, as JSON (C-11, decision 3): messages as objects keyed by the field names
   * as written (a name set twice gives an array), lists as arrays, strings decoded, `true` / `false` as booleans,
   * numbers as JSON numbers (integers beyond 2^53 as decimal strings, non-finite floats per D7), identifiers as
   * strings.
   */
  bestEffort(node: Spanned & { statements?: Spanned[]; valueOrCommas?: Spanned[] }): unknown {
    if (node.type === "aggregate" || node.type === "textproto-message-value") {
      const out: Record<string, unknown> = {}
      for (const st of node.statements ?? []) {
        if (st.type !== "textproto-field") continue
        const tf = st as TextprotoFieldNode
        const n = tf.fieldName
        const name =
          n.type === "textproto-extension-name"
            ? tokensText(n.typeName, (x) => this.src(x)).replace(/^\./, "")
            : n.type === "textproto-any-name"
              ? "@type"
              : this.src(n)
        addRaw(out, name, this.bestEffort(tf.value))
      }
      return out
    }
    if (node.type === "textproto-list-value")
      return (node.valueOrCommas ?? []).filter((v) => v.type !== "textproto-comma").map((v) => this.bestEffort(v))
    const text = this.src(node).trim()
    if (node.type === "str-lit" || node.type === "textproto-str-lit") return decodeStringLiteral(text)
    if (text === "true" || text === "True" || text === "t") return true
    if (text === "false" || text === "False" || text === "f") return false
    const i = parseIntText(text)
    if (i !== undefined) return i >= -(2n ** 53n) && i <= 2n ** 53n ? Number(i) : i.toString()
    const word = /^[-+]?\s*[A-Za-z]/.test(text)
    const f = word && !/^[-+]?\s*(inf|infinity|nan)$/i.test(text) ? undefined : parseFloatText(text)
    return f === undefined ? text : canonFloat(f)
  }
}
