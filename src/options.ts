// Option interpretation shared by both producers (design §3.7, §5.4, §6.2).
//
// Text options (`(name).sub = constant`, aggregates in text format) and ProtoJSON option messages are typed
// against the definitions in the symbol table (bundled descriptor.proto, bundled conventions, the input set) and
// normalised to one canonical tree: snake_case keys, extension keys as fqn without brackets, canonical values
// (§3.6), key order by definition (fields in declaration order, then extensions by number), defaults dropped (rule D).

import type { Location, ProtoScalar, ProtoSyntax } from "./types"
import type { MEnum, MField, MFile, MMessage, MOptionHolder, MRawOption, OptionTree, PendingIssue } from "./model"
import { type SymbolTable, kindName } from "./symbols"
import {
  canonFloat,
  canonFloatOf,
  canonInt,
  INT_RANGE,
  decodeStringLiteral,
  decodeStringLiteralBytes,
  FLOAT_KINDS,
  fromBase64,
  INT32_KINDS,
  INT64_KINDS,
  isPlainObject,
  parseFloatText,
  parseIntText,
  toBase64,
  toSnake,
  utf8Decode,
  utf8Encode,
  WRAPPERS,
} from "./values"

export type OptionsKind =
  | "file"
  | "message"
  | "field"
  | "oneof"
  | "enum"
  | "enumValue"
  | "service"
  | "method"
  | "extensionRange"

export const OPTIONS_MESSAGE: Record<OptionsKind, string> = {
  file: "google.protobuf.FileOptions",
  message: "google.protobuf.MessageOptions",
  field: "google.protobuf.FieldOptions",
  oneof: "google.protobuf.OneofOptions",
  enum: "google.protobuf.EnumOptions",
  enumValue: "google.protobuf.EnumValueOptions",
  service: "google.protobuf.ServiceOptions",
  method: "google.protobuf.MethodOptions",
  extensionRange: "google.protobuf.ExtensionRangeOptions",
}

export interface OptionContext {
  symbols: SymbolTable
  file: MFile
  /** fully qualified scope for extension name lookup (element fqn, or package for files) */
  scope: string
  /** source text of the file (text producer) */
  source?: string
}

export const addPending = (holder: { pending?: PendingIssue[] }, issue: PendingIssue) => {
  if (!holder.pending) holder.pending = []
  holder.pending.push(issue)
}

// ---- definitions ---------------------------------------------------------------------------------------------------

export type VType =
  | { kind: "scalar"; scalar: ProtoScalar }
  | { kind: "enum"; def?: MEnum }
  | { kind: "message"; def?: MMessage; fqn?: string }
  | { kind: "unknown" }

/** The value type of a type reference (a field's type, a map's value type). */
const refType = (t: MField["type"] | undefined, symbols: SymbolTable): VType => {
  if (t?.kind === "scalar") return { kind: "scalar", scalar: t.scalar }
  const r = t?.resolved
  if (r?.kind === "enum") return { kind: "enum", def: symbols.enum(r.fqn) }
  if (r?.kind === "message") return { kind: "message", def: symbols.message(r.fqn), fqn: r.fqn }
  return { kind: "unknown" }
}

const typeOfRef = (field: MField, symbols: SymbolTable): VType => refType(field.type, symbols)

const mapValueType = (field: MField, symbols: SymbolTable): VType => refType(field.map?.value, symbols)

const fieldByName = (def: MMessage, name: string): MField | undefined => def.fields.find((f) => f.name === name)

const fieldByJsonKey = (def: MMessage, key: string): MField | undefined =>
  def.fields.find((f) => f.name === key) ?? def.fields.find((f) => (f.jsonName ?? lowerCamel(f.name)) === key)

const lowerCamel = (name: string): string => name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())

const extensionOf = (symbols: SymbolTable, extendee: string, fqn: string): MField | undefined => {
  const e = symbols.extensionByName.get(fqn)
  if (!e || e.field.extendee?.resolved !== extendee) return undefined
  return e.field
}

const OPTIONS_MESSAGES = new Set<string>(Object.values(OPTIONS_MESSAGE))

/**
 * Whether a field of an option message (or of an option value's type) has implicit presence: a singular scalar or
 * enum field of a proto3 file without `optional`, or of an editions file where `features.field_presence = IMPLICIT`
 * is set on the field, an enclosing message or the file. Such a field set to its zero value is never serialized, so
 * the value is the same as an absent one (C-14). Editions features are read from ProtoJSON or interpreted options.
 */
const implicitPresence = (f: MField, def: MMessage): boolean => {
  if (f.repeated || f.map || f.oneof !== undefined || f.fqn !== undefined) return false
  if (f.type.kind === "named" && f.type.resolved?.kind !== "enum") return false
  const syntax = def.file.syntax
  if (syntax === "proto2") return false
  if (syntax === "proto3") return !f.optional
  const presence = (h: MOptionHolder): unknown => {
    const typed = isPlainObject(h.options.features) ? h.options.features.field_presence : undefined
    if (typed !== undefined) return typed
    for (const raw of h.raw) {
      if (raw.kind !== "json") continue
      const fs = raw.value.features
      const v = isPlainObject(fs) ? fs.fieldPresence ?? fs.field_presence : undefined
      if (v !== undefined) return v === 2 ? "IMPLICIT" : v
    }
    return undefined
  }
  const own = presence(f)
  if (own !== undefined) return own === "IMPLICIT"
  // enclosing messages, innermost first, then the file
  const chain: MOptionHolder[] = []
  const find = (ms: MMessage[], path: MMessage[]): boolean => {
    for (const m of ms) {
      if (m === def) {
        chain.push(...[...path, m].reverse())
        return true
      }
      if (find(m.nested, [...path, m])) return true
    }
    return false
  }
  find(def.file.messages, [])
  for (const h of [...chain, def.file]) {
    const v = presence(h)
    if (v !== undefined) return v === "IMPLICIT"
  }
  return false
}

/** The canonical zero value test for a field of type `f` (proto3 implicit-presence rule). */
const isZeroValue = (v: unknown, f: MField, symbols: SymbolTable): boolean => {
  const t = f.type
  if (t.kind === "scalar") {
    const s = t.scalar
    if (s === "string" || s === "bytes") return v === ""
    if (s === "bool") return v === false
    if (INT64_KINDS.has(s)) return v === "0" || v === 0
    return v === 0 && !Object.is(v, -0)
  }
  if (t.resolved?.kind === "enum") {
    if (v === 0) return true
    const e = symbols.enum(t.resolved.fqn)
    return typeof v === "string" && e?.values.find((x) => x.name === v)?.number === 0
  }
  return false
}

/** An option value that equals an absent one: an empty repeated or map field, or an implicit-presence zero (C-14). */
const isAbsentValue = (v: unknown, f: MField, def: MMessage, symbols: SymbolTable): boolean => {
  if (f.repeated || f.map) return Array.isArray(v) ? v.length === 0 : isPlainObject(v) && Object.keys(v).length === 0
  return implicitPresence(f, def) && isZeroValue(v, f, symbols)
}

/** Key of a field inside an option tree: regular fields by name, extensions by fqn. */
const extensionFqn = (_symbols: SymbolTable, field: MField): string | undefined => field.fqn

// ---- canonical scalar conversion ----------------------------------------------------------------------------------

export const INVALID = Symbol("invalid")
/** marks a text-format field whose value equals an absent one (removed when the message is complete) */
const ABSENT = Symbol("absent")
type Converted = unknown | typeof INVALID

const enumName = (def: MEnum | undefined, v: string | number): Converted => {
  if (typeof v === "number") {
    const found = def?.values.find((x) => x.number === v)
    return found ? found.name : v
  }
  return v
}

/** Why the last `fromScalarText` call returned `INVALID` (for the issue message). */
let invalidReason = ""
const invalid = (reason: string): typeof INVALID => {
  invalidReason = reason
  return INVALID
}
/** The reason of the last `INVALID` from `fromScalarText`. */
export const lastInvalidReason = (): string => invalidReason

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
 * outside of message expression"); otherwise a text-format value inside an aggregate. Returns `INVALID` (with
 * `lastInvalidReason()`) for a value of the wrong type, an integer out of range for its kind, an unknown or qualified
 * enum identifier, a non-canonical bool / float spelling, a hexadecimal float, or a `string` that is not UTF-8.
 */
export const fromScalarText = (text: string, isString: boolean, t: VType, strict = false): Converted => {
  if (t.kind === "scalar") {
    const s = t.scalar
    if (s === "string") {
      if (!isString) return invalid("a string literal is expected")
      return isValidUtf8Literal(text) ? decodeStringLiteral(text) : invalid("the string is not valid UTF-8")
    }
    if (s === "bytes")
      return isString ? toBase64(decodeStringLiteralBytes(text)) : invalid("a string literal is expected")
    if (isString) return invalid(`a string literal is not a ${s} value`)
    if (s === "bool") {
      if (text === "true" || (!strict && (text === "True" || text === "t"))) return true
      if (text === "false" || (!strict && (text === "False" || text === "f"))) return false
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
      return v === undefined ? invalid(`${text} is not a ${s} value`) : canonFloatOf(v, s)
    }
    const v = parseIntConstant(text, strict)
    if (v === undefined) return invalid(`${text} is not an integer`)
    const range = INT_RANGE[s]
    if (range && (v < range[0] || v > range[1])) return invalid(`${text} is out of range for ${s}`)
    return canonInt(v, s)
  }
  if (t.kind === "enum") {
    if (isString) return invalid("an enum value is expected, not a string")
    const n = parseIntText(text)
    if (n !== undefined) {
      if (n < -(2n ** 31n) || n >= 2n ** 31n) return invalid(`${text} is out of range for an enum value`)
      return enumName(t.def, Number(n))
    }
    if (text.includes(".")) return invalid(`${text}: an enum value is written without qualification`)
    if (t.def && !t.def.values.some((v) => v.name === text)) return invalid(`${t.def.fqn} has no value ${text}`)
    return text
  }
  return invalid("not a scalar value")
}

// ---- text constants and text format ---------------------------------------------------------------------------------

/** Minimal structural view of the parser nodes the interpreter reads (pbkit AST). */
interface Spanned {
  type: string
  start: number
  end: number
}
interface AggregateNode extends Spanned {
  statements: Spanned[]
}
interface TextprotoFieldNode extends Spanned {
  fieldName: Spanned & { typeName?: Spanned; domain?: Spanned }
  value: Spanned & { statements?: Spanned[]; valueOrCommas?: Spanned[] }
}

export class OptionInterpreter {
  constructor(
    private readonly ctx: OptionContext,
    private readonly holder: MOptionHolder,
  ) {}

  /** the pointer suffix of the option statement being interpreted (issues inside aggregate values point at it) */
  private currentSub?: string

  private issue(code: PendingIssue["code"], message: string, loc?: Location, sub?: string) {
    addPending(this.holder, { code, message, loc, sub: sub ?? this.currentSub })
  }

  private src(node: Spanned): string {
    return this.ctx.source ? this.ctx.source.slice(node.start, node.end) : ""
  }

  /** Typed value of a protobuf constant for `field` (a field of an options message or of an option's type). */
  constantValue(constant: Spanned, field: MField, loc?: Location): Converted {
    if (constant.type === "aggregate") {
      const t = typeOfRef(field, this.ctx.symbols)
      if (t.kind !== "message" || !t.def) return invalid("an aggregate value needs a message-typed option")
      return this.textprotoMessage((constant as AggregateNode).statements, t.def, loc)
    }
    const t = typeOfRef(field, this.ctx.symbols)
    if (t.kind === "message") return invalid("a message-typed option needs an aggregate value { … }")
    return fromScalarText(this.src(constant).trim(), constant.type === "str-lit", t, true)
  }

  private textprotoScalar(node: Spanned, t: VType): Converted {
    const text = this.src(node).trim()
    return fromScalarText(text, node.type === "textproto-str-lit", t)
  }

  /** Where option names and values look names up from: the file, with `import option` files visible (decision 18). */
  private get from() {
    return { file: this.ctx.file, options: true }
  }

  private textprotoValue(
    node: Spanned & { statements?: Spanned[] },
    field: MField,
    t: VType,
    loc?: Location,
  ): Converted {
    if (node.type === "textproto-message-value") {
      if (t.kind !== "message" || !t.def) return invalid("a message value is not allowed for this field")
      return this.textprotoMessage(node.statements ?? [], t.def, loc)
    }
    if (t.kind === "message") return invalid("a message field needs a message value { … }")
    return this.textprotoScalar(node, t)
  }

  /** Typed object from text-format message statements against a message definition. */
  textprotoMessage(statements: Spanned[], def: MMessage, loc?: Location): Converted {
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
        let converted: Converted
        if (field.map) {
          converted = this.mapEntryValue(v, field, loc)
          if (converted === INVALID) continue
          const entry = converted as { key: string; value: unknown }
          const m = (out[key] ??= {}) as Record<string, unknown>
          m[entry.key] = entry.value
          continue
        }
        converted = this.textprotoValue(v, field, t as VType, loc)
        if (converted === INVALID) {
          this.issue("invalid-option", `invalid value for ${def.fqn}.${field.name}: ${lastInvalidReason()}`, loc)
          continue
        }
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

  /** An `Any` written with its fields (`{ type_url: "…" value: "\x08\x01" }`) as the expanded form of `anyText`: the payload is decoded from `value` against the type, as buf's ProtoJSON does. An empty `Any` stays `{}`; a `value` without `type_url`, an unknown type or bytes that do not decode give an `unknown-option` issue and keep it as written. */
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

  private mapEntryValue(v: Spanned & { statements?: Spanned[] }, field: MField, loc?: Location): Converted {
    if (v.type !== "textproto-message-value") return INVALID
    let k: unknown
    let val: unknown
    for (const st of v.statements ?? []) {
      if (st.type !== "textproto-field") continue
      const tf = st as TextprotoFieldNode
      const n = this.src(tf.fieldName)
      if (n === "key") k = this.textprotoScalar(tf.value, { kind: "scalar", scalar: field.map?.key ?? "string" })
      else if (n === "value") {
        const vt = mapValueType(field, this.ctx.symbols)
        val = this.textprotoValue(tf.value, field, vt, loc)
      }
    }
    if (k === INVALID || val === INVALID || k === undefined) return INVALID
    return { key: String(k), value: val }
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
    const payload = this.textprotoMessage(value.statements ?? [], def, loc) as Record<string, unknown>
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

  // ---- text option statements -------------------------------------------------------------------------------------

  /**
   * Interpret one text option statement into `tree`. Returns the top-level key it set and the location to record for
   * it: the statement as located by the front end, or the whole statement for a repeated field (C-10).
   */
  interpretText(
    raw: Extract<MRawOption, { kind: "text" }>,
    kind: OptionsKind,
    tree: OptionTree,
  ): { key: string; loc?: Location } | undefined {
    const { symbols } = this.ctx
    const segments = optionNameSegments(raw.name, (n) => this.src(n))
    if (!segments.length) return undefined
    const rawKey = segments.map((s) => s.name).join(".")
    let def = symbols.message(OPTIONS_MESSAGE[kind])
    const path: { key: string; field: MField }[] = []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (!def) return this.unknown(raw, rawKey, tree)
      let field: MField | undefined
      let key: string
      if (seg.ext) {
        // protoc / buf: the first symbol of any kind found from the scope outward (`LookupSymbol`); a message or
        // other non-extension there is an error, not skipped
        const r = symbols.lookup(seg.name, this.ctx.scope, "any", this.from)
        const found = r.found
        if (found && found.kind !== "extension") {
          this.issue(
            "unresolved-type",
            `option name (${seg.name}) resolves to ${kindName(found.kind)} ${found.fqn}, which is not an extension`,
            raw.loc,
            `options/${rawKey}`,
          )
          tree[rawKey] = raw.text
          return { key: rawKey, loc: raw.loc }
        }
        const entry = found ? symbols.extensionByName.get(found.fqn) : undefined
        if (!entry || entry.field.extendee?.resolved !== def.fqn)
          return this.unknown(
            raw,
            rawKey,
            tree,
            r.hidden ? symbols.hiddenReason(r.hidden, this.from) : undefined,
            i ? undefined : segments.map((x) => x.name),
          )
        field = entry.field
        key = entry.fqn
      } else {
        field = fieldByName(def, seg.name)
        key = seg.name
        if (!field) {
          if (i === 0) return this.unknown(raw, rawKey, tree)
          // C-11: a sub-field the definition does not have (protovalidate before 1.0, a newer FeatureSet) is kept raw
          this.issue(
            "unknown-option",
            `option ${rawKey}: ${def.fqn} has no field "${seg.name}"; the value is kept as written`,
            raw.loc,
            `options/${path[0].key}`,
          )
          setRaw(
            tree,
            [...path.map((p) => p.key), ...segments.slice(i).map((x) => x.name)],
            this.bestEffort(raw.value as unknown as Spanned),
          )
          return { key: path[0].key, loc: raw.loc }
        }
      }
      path.push({ key, field })
      if (i < segments.length - 1) {
        if (field.repeated || field.map) {
          this.issue("invalid-option", `option ${rawKey}: a repeated or map field needs an aggregate value`, raw.loc)
          return undefined
        }
        const t = typeOfRef(field, symbols)
        def = t.kind === "message" ? t.def : undefined
        if (!def) return this.unknown(raw, rawKey, tree)
      }
    }
    const leaf = path[path.length - 1]
    // C-10: protoc / buf locate an option statement that sets a repeated field by the whole statement
    const loc = leaf.field.repeated && raw.stmtLoc ? raw.stmtLoc : raw.loc
    this.currentSub = `options/${path[0].key}`
    const value = this.constantValue(raw.value as unknown as Spanned, leaf.field, raw.loc)
    this.currentSub = undefined
    if (value === INVALID) {
      this.issue(
        "invalid-option",
        `invalid value for option ${rawKey}: ${lastInvalidReason()}`,
        raw.loc,
        `options/${path[0].key}`,
      )
      return undefined
    }
    if (path.length > 1) {
      const parent = typeOfRef(path[path.length - 2].field, symbols)
      if (
        parent.kind === "message" &&
        parent.def &&
        !leaf.field.repeated &&
        isAbsentValue(value, leaf.field, parent.def, symbols)
      ) {
        // an implicit-presence zero is the same as an absent value; the enclosing message is still set (C-14)
        this.setPath(tree, path.slice(0, -1), {}, raw.loc, false)
        return { key: path[0].key, loc }
      }
    }
    this.setPath(tree, path, value, raw.loc, (raw.value as unknown as Spanned).type === "aggregate")
    return { key: path[0].key, loc }
  }

  /** An option whose definition is unknown: its source text under the name as written, parentheses stripped. A sub-path of an unknown extension (`(unk.sub).x`, `names` = the segments) nests like a known one: `unk.sub: { x }`. */
  private unknown(
    raw: Extract<MRawOption, { kind: "text" }>,
    rawKey: string,
    tree: OptionTree,
    reason?: string,
    names?: string[],
  ): { key: string; loc?: Location } {
    const key = names?.[0] ?? rawKey
    this.issue(
      "unknown-option",
      reason ? `unknown option ${rawKey}: ${reason}` : `unknown option ${rawKey}`,
      raw.loc,
      `options/${key}`,
    )
    if (names && names.length > 1) setRaw(tree, names, raw.text)
    else tree[rawKey] = raw.text
    return { key, loc: raw.loc }
  }

  /**
   * Set `value` at `path`. A non-repeated field set twice is an `invalid-option` (last wins). A sub-path statement
   * merges into a message set before; an aggregate replaces it and is an `invalid-option` when the message was set
   * already (A-5; buf: "message extension `p.agg` set multiple times").
   */
  private setPath(
    tree: OptionTree,
    path: { key: string; field: MField }[],
    value: unknown,
    loc: Location | undefined,
    aggregate: boolean,
  ) {
    let cur = tree as Record<string, unknown>
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i].key
      if (!isPlainObject(cur[k])) cur[k] = {}
      cur = cur[k] as Record<string, unknown>
    }
    const { key, field } = path[path.length - 1]
    if (field.repeated && !field.map) {
      const arr = (Array.isArray(cur[key]) ? cur[key] : (cur[key] = [])) as unknown[]
      arr.push(value)
    } else if ((field.map || !aggregate) && isPlainObject(cur[key]) && isPlainObject(value)) {
      deepMerge(cur[key] as Record<string, unknown>, value)
    } else {
      if (key in cur)
        this.issue(
          "invalid-option",
          `option ${path.map((p) => p.key).join(".")} is set more than once`,
          loc,
          `options/${path[0].key}`,
        )
      cur[key] = value
    }
  }

  // ---- ProtoJSON ----------------------------------------------------------------------------------------------------

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

  // ---- whole holder ------------------------------------------------------------------------------------------------

  /** Interpret every raw option of the holder into `holder.options` (typed, ordered, rule D applied). */
  run(kind: OptionsKind, syntax: ProtoSyntax) {
    const { symbols } = this.ctx
    const def = symbols.message(OPTIONS_MESSAGE[kind])
    const tree: OptionTree = {}
    for (const raw of this.holder.raw) {
      if (raw.kind === "text") {
        const set = this.interpretText(raw, kind, tree)
        if (set?.loc && !(set.key in this.holder.optionLocs)) this.holder.optionLocs[set.key] = set.loc
      } else {
        Object.assign(tree, this.jsonMessage(raw.value, def, ""))
        if (raw.locs && def) {
          for (const [num, loc] of Object.entries(raw.locs)) {
            const key = keyByNumber(symbols, def, Number(num))
            if (key && !(key in this.holder.optionLocs)) this.holder.optionLocs[key] = loc
          }
        }
      }
    }
    this.holder.options = dropDefaults(kind, orderTree(tree, def, symbols), syntax)
  }
}

const lastName = (t: { name: string }) => {
  const i = t.name.lastIndexOf(".")
  return i < 0 ? t.name : t.name.slice(i + 1)
}

/** Option name segments: plain dotted parts split, parenthesised parts kept whole. */
export const optionNameSegments = (
  name: { optionNameSegmentOrDots?: unknown[] },
  src: (n: Spanned) => string,
): { name: string; ext: boolean }[] => {
  const out: { name: string; ext: boolean }[] = []
  for (const s of (name.optionNameSegmentOrDots ?? []) as (Spanned & { bracketOpen?: unknown; name?: Spanned })[]) {
    if (s.type !== "option-name-segment" || !s.name) continue
    const text = tokensText(s.name, src)
    if (s.bracketOpen) out.push({ name: text, ext: true })
    else for (const part of text.split(".")) if (part) out.push({ name: part, ext: false })
  }
  return out
}

/** Whitespace and comments between the tokens of a name or a number. */
export const TRIVIA = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\s+/g

/** A dotted name node as written, without the whitespace and comments between its tokens (C-15). */
export const tokensText = (n: unknown, src: (n: Spanned) => string): string => {
  const parts = (n as { identOrDots?: { text: string }[] } | undefined)?.identOrDots
  if (Array.isArray(parts)) return parts.map((t) => t.text).join("")
  return src(n as Spanned).replace(TRIVIA, "")
}

const keyByNumber = (symbols: SymbolTable, def: MMessage, num: number): string | undefined => {
  const f = def.fields.find((x) => x.number === num)
  if (f) return f.name
  for (const x of symbols.extensionsByExtendee.get(def.fqn) ?? []) if (x.number === num) return extensionFqn(symbols, x)
  return undefined
}

const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(b)) {
    if (isPlainObject(a[k]) && isPlainObject(v)) deepMerge(a[k] as Record<string, unknown>, v)
    else if (Array.isArray(a[k]) && Array.isArray(v)) (a[k] as unknown[]).push(...v)
    else a[k] = v
  }
}

/** Add a raw value under `key`; a key set again becomes an array (a repeated field written twice). */
const addRaw = (out: Record<string, unknown>, key: string, value: unknown) => {
  if (!(key in out)) out[key] = value
  else if (Array.isArray(out[key])) (out[key] as unknown[]).push(value)
  else out[key] = [out[key], value]
}

/** Set a raw value at a key path, creating objects on the way (C-11). */
const setRaw = (tree: Record<string, unknown>, keys: string[], value: unknown) => {
  let cur = tree
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  addRaw(cur, keys[keys.length - 1], value)
}

/** ProtoJSON keys of a value without a definition converted by the generic rule (lowerCamelCase -> snake_case). */
const snakeKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(snakeKeys)
  if (!isPlainObject(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[/^\[.+\]$/.test(k) ? k.slice(1, -1) : toSnake(k)] = snakeKeys(x)
  return out
}

// ---- well-known type JSON forms ---------------------------------------------------------------------------------------

const secondsNanos = (seconds: bigint, nanos: number) => {
  const out: Record<string, unknown> = {}
  if (seconds !== 0n) out.seconds = seconds.toString()
  if (nanos !== 0) out.nanos = nanos
  return out
}

/** ProtoJSON special forms of well-known types -> message form (§3.7). Undefined when `v` is not in special form. */
export const fromWktJson = (fqn: string, v: unknown): unknown => {
  if (fqn === "google.protobuf.Duration" && typeof v === "string") {
    const m = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(v)
    if (!m) return undefined
    const sign = m[1] ? -1 : 1
    const seconds = BigInt(m[2]) * BigInt(sign)
    const nanos = m[3] ? Number(m[3].padEnd(9, "0")) * sign : 0
    return secondsNanos(seconds, nanos)
  }
  if (fqn === "google.protobuf.Timestamp" && typeof v === "string") {
    const ms = Date.parse(v)
    if (Number.isNaN(ms)) return undefined
    const frac = /\.(\d{1,9})/.exec(v)
    const seconds = BigInt(Math.floor(ms / 1000))
    return secondsNanos(seconds, frac ? Number(frac[1].padEnd(9, "0")) : 0)
  }
  if (fqn === "google.protobuf.FieldMask" && typeof v === "string") {
    return { paths: v ? v.split(",").map((p) => p.split(".").map(toSnake).join(".")) : [] }
  }
  if (fqn in WRAPPERS && !isPlainObject(v)) {
    const s = WRAPPERS[fqn]
    // proto3 `value` has implicit presence: a zero wrapper is the empty message (C-14)
    if (v === 0 || v === "0" || v === false || v === "") return {}
    if (INT64_KINDS.has(s)) return { value: String(v) }
    if (FLOAT_KINDS.has(s)) {
      const n = typeof v === "number" ? v : parseFloatText(String(v))
      return { value: n === undefined ? v : canonFloatOf(n, s) }
    }
    if (s === "bytes" && typeof v === "string") return { value: toBase64(fromBase64(v)) }
    return { value: v }
  }
  // Struct, Value and ListValue are written in message form like the text producer (no JSON `null` in a document)
  if (fqn === "google.protobuf.Struct" && isPlainObject(v)) return structMessage(v)
  if (fqn === "google.protobuf.ListValue" && Array.isArray(v)) return listMessage(v)
  if (fqn === "google.protobuf.Value" && v !== undefined) return valueMessage(v)
  if (fqn === "google.protobuf.Empty" && isPlainObject(v)) return {}
  return undefined
}

const structMessage = (o: Record<string, unknown>): Record<string, unknown> => {
  const keys = Object.keys(o).sort()
  if (!keys.length) return {}
  const fields: Record<string, unknown> = {}
  for (const k of keys) fields[k] = valueMessage(o[k])
  return { fields }
}
const listMessage = (a: unknown[]): Record<string, unknown> => (a.length ? { values: a.map(valueMessage) } : {})
const valueMessage = (x: unknown): Record<string, unknown> => {
  if (x === null) return { null_value: "NULL_VALUE" }
  if (typeof x === "number") return { number_value: canonFloat(x) }
  if (typeof x === "string") return { string_value: x }
  if (typeof x === "boolean") return { bool_value: x }
  if (Array.isArray(x)) return { list_value: listMessage(x) }
  if (isPlainObject(x)) return { struct_value: structMessage(x) }
  return {}
}

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
    const e = !t ? -1 : t.kind === "message" ? 2 : t.kind === "scalar" ? WIRE_TYPE[t.scalar] ?? 0 : 0
    const packed = f?.repeated && w === 2 && e !== 2
    if (!f || !t || (w !== e && !packed)) {
      // an unknown field, or a known one with another wire type: skipped
      if (w === 2) len()
      else value(scalarType("uint64"), w)
      continue
    }
    const values: unknown[] = []
    if (packed) for (const end = Number(varint()) + p; p < end; ) values.push(value(t, e))
    else values.push(value(t, w))
    for (const v of values) {
      const entry = v as { key?: unknown; value?: unknown }
      if (!m) f.repeated ? ((out[f.name] ??= []) as unknown[]).push(v) : (out[f.name] = v)
      else if ("key" in entry && "value" in entry)
        ((out[f.name] ??= {}) as Record<string, unknown>)[String(entry.key)] = entry.value
      else throw RangeError()
    }
  }
  for (const f of def.fields) if (f.name in out && isAbsentValue(out[f.name], f, def, symbols)) delete out[f.name]
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

/** Well-known types whose ProtoJSON form is a JSON value (inside an `Any`: `{ "@type", value }`). */
export const WKT_VALUE_FORM = new Set<string>([
  "google.protobuf.Duration",
  "google.protobuf.Timestamp",
  "google.protobuf.FieldMask",
  "google.protobuf.Empty",
  "google.protobuf.Any",
  ...Object.keys(WRAPPERS),
])
/** JSON-valued well-known types kept in message form inside an `Any`, so that a document holds no JSON `null`. */
const WKT_JSON_VALUES = new Set<string>([
  "google.protobuf.Struct",
  "google.protobuf.Value",
  "google.protobuf.ListValue",
])

const fraction = (nanos: number): string => {
  const n = Math.abs(nanos)
  if (n === 0) return ""
  if (n % 1e6 === 0) return `.${String(n / 1e6).padStart(3, "0")}`
  if (n % 1e3 === 0) return `.${String(n / 1e3).padStart(6, "0")}`
  return `.${String(n).padStart(9, "0")}`
}

/** Message form of a well-known type -> its ProtoJSON value (the `value` of an `Any`, decision 2). */
const toWktJson = (fqn: string, m: Record<string, unknown>): unknown => {
  const seconds = (): bigint => parseIntText(String(m.seconds ?? "0")) ?? 0n
  const nanos = (): number => Number(m.nanos ?? 0)
  if (fqn === "google.protobuf.Duration") {
    const s = seconds()
    const n = nanos()
    return `${s < 0n || n < 0 ? "-" : ""}${s < 0n ? -s : s}${fraction(n)}s`
  }
  if (fqn === "google.protobuf.Timestamp") {
    const iso = new Date(Number(seconds()) * 1000).toISOString()
    return `${iso.slice(0, 19)}${fraction(nanos())}Z`
  }
  if (fqn === "google.protobuf.FieldMask")
    return (Array.isArray(m.paths) ? m.paths : []).map((p) => String(p).split(".").map(lowerCamel).join(".")).join(",")
  if (fqn in WRAPPERS) {
    if (m.value !== undefined) return m.value
    const s = WRAPPERS[fqn]
    return INT64_KINDS.has(s) ? "0" : s === "bool" ? false : s === "string" || s === "bytes" ? "" : 0
  }
  return m
}

/** The canonical `Any` value: `@type` first, then the payload's fields, or `value` for well-known payloads (C-9). */
const anyValue = (url: string, fqn: string, payload: Record<string, unknown>): Record<string, unknown> =>
  WKT_VALUE_FORM.has(fqn) ? { "@type": url, value: toWktJson(fqn, payload) } : { "@type": url, ...payload }

// ---- ordering and rule D ------------------------------------------------------------------------------------------

/** Order keys by definition: fields in declaration order, then extensions by number, then unknown keys. */
export const orderTree = (
  tree: Record<string, unknown>,
  def: MMessage | undefined,
  symbols: SymbolTable,
): Record<string, unknown> => {
  if (!def) return tree
  const out: Record<string, unknown> = {}
  const childType = (f: MField): MMessage | undefined => {
    const t = f.map ? f.map.value : f.type
    return t.kind === "named" && t.resolved?.kind === "message" ? symbols.message(t.resolved.fqn) : undefined
  }
  const orderValue = (v: unknown, f: MField): unknown => {
    const child = childType(f)
    if (f.map && isPlainObject(v)) {
      const m: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort())
        m[k] = child && isPlainObject(v[k]) ? orderTree(v[k] as Record<string, unknown>, child, symbols) : v[k]
      return m
    }
    if (!child) return v
    if (Array.isArray(v)) return v.map((x) => (isPlainObject(x) ? orderTree(x, child, symbols) : x))
    return isPlainObject(v) ? orderTree(v, child, symbols) : v
  }
  // an expanded Any (C-9): `@type` first, then the payload in its own order
  if ("@type" in tree && def.fqn === "google.protobuf.Any") out["@type"] = tree["@type"]
  for (const f of def.fields) if (f.name in tree) out[f.name] = orderValue(tree[f.name], f)
  const exts = (symbols.extensionsByExtendee.get(def.fqn) ?? [])
    .map((f) => ({ f, fqn: extensionFqn(symbols, f) }))
    .filter((e): e is { f: MField; fqn: string } => !!e.fqn && e.fqn in tree)
    .sort((a, b) => a.f.number - b.f.number || a.fqn.localeCompare(b.fqn))
  for (const { f, fqn } of exts) out[fqn] = orderValue(tree[fqn], f)
  for (const k of Object.keys(tree)) if (!(k in out)) out[k] = tree[k]
  return out
}

const RULE_D: Record<OptionsKind | "any", Record<string, unknown>> = {
  any: { deprecated: false },
  field: {
    jstype: "JS_NORMAL",
    ctype: "STRING",
    lazy: false,
    unverified_lazy: false,
    weak: false,
    debug_redact: false,
    retention: "RETENTION_UNKNOWN",
  },
  enum: { allow_alias: false },
  message: { message_set_wire_format: false, no_standard_descriptor_accessor: false },
  method: { idempotency_level: "IDEMPOTENCY_UNKNOWN" },
  file: {
    java_multiple_files: false,
    java_generic_services: false,
    cc_generic_services: false,
    py_generic_services: false,
    optimize_for: "SPEED",
    cc_enable_arenas: true,
  },
  oneof: {},
  enumValue: {},
  service: {},
  extensionRange: {},
}

/** Rule D: options equal to their protobuf default are not written. */
export const dropDefaults = (kind: OptionsKind, tree: OptionTree, syntax: ProtoSyntax): OptionTree => {
  const out: OptionTree = {}
  const table = { ...RULE_D.any, ...RULE_D[kind] }
  for (const [k, v] of Object.entries(tree)) {
    if (k in table && table[k] === v) continue
    if (kind === "message" && k === "map_entry") continue
    if (kind === "field" && k === "packed" && v === (syntax === "proto3")) continue
    if (kind === "field" && k === "targets" && Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

/** utf8 helper re-export for producers */
export const encodeUtf8 = utf8Encode
