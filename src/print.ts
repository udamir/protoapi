// Printer (design §10): ProtoApiDocument -> .proto text, one text per file. The guarantee is on the document:
// build(print(build(x))) equals build(x) except for x-annotation-conflicts and description whitespace.
//
// Lifted keywords (validation decision 11) are printed back as the convention option they can come from when the
// file's written imports (and their public re-exports) make that option available, in the precedence order of D13;
// otherwise as a comment tag or an AIP prefix. Resolved features (packed, utf8Validation, jsonFormat) and inherited
// editions features are printed in the spelling of the file's syntax.

import type {
  PrintOptions,
  ProtoApiDocument,
  ProtoApiElement,
  ProtoApiEnum,
  ProtoApiExtension,
  ProtoApiField,
  ProtoApiFile,
  ProtoApiHttpRule,
  ProtoApiMessage,
  ProtoApiMethod,
  ProtoApiService,
  ProtoApiTypeRef,
  ProtoScalar,
  ProtoSyntax,
  TagName,
} from "./types.ts"
import type { MField, MFile, MMessage } from "./model.ts"
import { SymbolTable } from "./symbols.ts"
import { linkAll } from "./resolve.ts"
import { textToModel } from "./text.ts"
import { INT_RANGE, canonFloatOf, fromBase64 } from "./values/canonical.ts"
import { FLOAT_KINDS, INT64_KINDS, WRAPPERS, isScalar } from "./values/scalars.ts"
import { OPTIONS_MESSAGE, WKT_VALUE_FORM, fromWktJson } from "./options.ts"
import { NUMERIC_RULES as NUMERIC, OA, OA_FIELD, OA_SCHEMA, STRING_FORMATS, WKT_FAMILY } from "./annotate.ts"
import { normalizePath } from "./paths.ts"
import { featuresOf as treeFeatures } from "./features.ts"
import { isEditions } from "./common/editions.ts"
import { FIELD_NUMBER_MAX, INT32_MAX, MESSAGE_SET_NUMBER_MAX } from "./common/limits.ts"
import { lastSegment, parentScope, qualify } from "./common/names.ts"
import { isPlainObject } from "./common/objects.ts"

const featuresOf = (o: unknown): Obj | undefined => (isPlainObject(o) ? treeFeatures(o) : undefined)

type Obj = Record<string, unknown>

// ---- type oracle for option values ---------------------------------------------------------------------------------

type FType =
  | { kind: "scalar"; scalar: ProtoScalar; repeated?: boolean }
  | { kind: "enum"; fqn?: string; repeated?: boolean }
  | { kind: "message"; fqn: string; repeated?: boolean; map?: { key: ProtoScalar; value: FType } }
  | { kind: "unknown"; repeated?: boolean }

/** Bundled files whose definitions type option values (descriptor.proto, features, WKTs, the conventions). */
const OPTION_FILES = /^(google\/(protobuf|api)|buf|validate|protoc-gen-openapiv2)\//

/** Parsed option definitions of a bundle, once per bundle object. */
const bundleModels = new WeakMap<object, MFile[]>()
const optionModels = (bundle: Readonly<Record<string, string>>): MFile[] => {
  const cached = bundleModels.get(bundle)
  if (cached) return cached
  const files: MFile[] = []
  for (const [p, text] of Object.entries(bundle)) if (OPTION_FILES.test(p)) files.push(textToModel(p, text, [], true))
  bundleModels.set(bundle, files)
  return files
}
const bundleSymbols = new WeakMap<object, SymbolTable>()

/** Every bundled file's top-level declarations (fqn -> path), for documents without `files` (decision 12). */
const bundleIndexes = new WeakMap<object, Map<string, string>>()
const bundleIndex = (bundle: Readonly<Record<string, string>>): Map<string, string> => {
  let idx = bundleIndexes.get(bundle)
  if (idx) return idx
  idx = new Map()
  for (const [p, text] of Object.entries(bundle)) {
    const f = textToModel(p, text, [], true)
    const add = (m: MMessage) => {
      idx?.set(m.fqn, p)
      for (const n of m.nested) add(n)
      for (const e of m.enums) idx?.set(e.fqn, p)
    }
    for (const m of f.messages) add(m)
    for (const e of f.enums) idx.set(e.fqn, p)
  }
  bundleIndexes.set(bundle, idx)
  return idx
}

const ftypeOfModel = (f: MField): FType => {
  const t = f.type
  if (f.map) {
    const v = f.map.value
    const value: FType =
      v.kind === "scalar"
        ? { kind: "scalar", scalar: v.scalar }
        : v.resolved?.kind === "enum"
          ? { kind: "enum", fqn: v.resolved.fqn }
          : { kind: "message", fqn: v.resolved?.fqn ?? "" }
    return { kind: "message", fqn: "", map: { key: f.map.key, value } }
  }
  if (t.kind === "scalar") return { kind: "scalar", scalar: t.scalar, repeated: f.repeated }
  if (t.resolved?.kind === "enum") return { kind: "enum", fqn: t.resolved.fqn, repeated: f.repeated }
  if (t.resolved?.kind === "message") return { kind: "message", fqn: t.resolved.fqn, repeated: f.repeated }
  return { kind: "unknown", repeated: f.repeated }
}

const decodePointerKey = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~")

/** The protobuf scalar of a scalar position (field, `items`, map key or value): its `type` when that names a scalar. */
const scalarOf = (t: unknown): ProtoScalar | undefined => {
  const type = isPlainObject(t) ? (t as { type?: unknown }).type : undefined
  return typeof type === "string" && isScalar(type) ? type : undefined
}

const refFqn = (ref: string) => {
  const s = decodePointerKey(ref.replace(/^#\/components\/(messages|enums)\//, ""))
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

class Oracle {
  readonly symbols: SymbolTable
  private readonly doc: ProtoApiDocument
  constructor(
    doc: ProtoApiDocument,
    bundle: Readonly<Record<string, string>>,
    sources: Readonly<Record<string, string>> | undefined,
  ) {
    this.doc = doc
    const cached = sources ? undefined : bundleSymbols.get(bundle)
    if (cached) this.symbols = cached
    else {
      // the caller's sources win over bundled files with the same path
      const own = Object.entries(sources ?? {})
        .filter(([, text]) => typeof text === "string")
        .map(([p, text]) => textToModel(normalizePath(p), text, []))
      const paths = new Set(own.map((f) => f.path))
      const files = [...own, ...optionModels(bundle).filter((f) => !paths.has(f.path))]
      this.symbols = new SymbolTable(files)
      linkAll(files, this.symbols)
      if (!sources) bundleSymbols.set(bundle, this.symbols)
    }
  }

  private docType(f: ProtoApiField): FType {
    const repeated = f.type === "array"
    const t = (repeated ? f.items : f) as ProtoApiTypeRef | ProtoApiField | undefined
    if (f.type === "object" && f.additionalProperties) {
      return {
        kind: "message",
        fqn: "",
        map: {
          key: scalarOf(f.propertyNames) ?? "string",
          value: this.refType(f.additionalProperties),
        },
      }
    }
    if (!t) return { kind: "unknown" }
    return { ...this.refType(t as ProtoApiTypeRef), repeated }
  }

  private refType(t: ProtoApiTypeRef): FType {
    const scalar = scalarOf(t)
    if (scalar) return { kind: "scalar", scalar }
    if ("$ref" in t && t.$ref)
      return t.$ref.includes("/enums/")
        ? { kind: "enum", fqn: refFqn(t.$ref) }
        : { kind: "message", fqn: refFqn(t.$ref) }
    return { kind: "unknown" }
  }

  /** Type of `key` inside message `fqn` (an `*Options` message or an option value type). */
  field(fqn: string, key: string): FType | undefined {
    const def: MMessage | undefined = this.symbols.message(fqn)
    if (def) {
      const f = def.fields.find((x) => x.name === key)
      if (f) return ftypeOfModel(f)
      const x = this.symbols.extensionByName.get(key)
      if (x && x.field.extendee?.resolved === fqn) return ftypeOfModel(x.field)
    }
    const ext = this.doc.components?.extensions?.[key]
    if (ext && ext.extendee === fqn) return this.docType(ext)
    const msg = this.doc.components?.messages?.[fqn]
    const p = msg?.properties
    if (p && isPlainObject(p) && p[key]) return this.docType(p[key])
    return undefined
  }

  /** The model field `key` of message `fqn`, for oneof checks (definitions only). */
  fieldDef(fqn: string, key: string): MField | undefined {
    return this.symbols.message(fqn)?.fields.find((x) => x.name === key)
  }

  /** Number of enum value `name` of enum `fqn`. */
  enumNumber(fqn: string | undefined, name: string): number | undefined {
    if (!fqn) return undefined
    const de = this.doc.components?.enums?.[fqn]
    const v = de?.values && isPlainObject(de.values) ? de.values[name] : undefined
    if (v && typeof v.number === "number") return v.number
    return this.symbols.enum(fqn)?.values.find((x) => x.name === name)?.number
  }

  /** Declaring file of an extension (option) key. */
  extensionFile(key: string): string | undefined {
    const ext = this.doc.components?.extensions?.[key]
    if (ext?.file) return ext.file
    return this.symbols.extensionByName.get(key)?.file.path
  }

  /** Declaring file of a message or enum. */
  typeFile(fqn: string): string | undefined {
    const c = this.doc.components?.messages?.[fqn] ?? this.doc.components?.enums?.[fqn]
    if (c?.file) return c.file
    return this.symbols.get(fqn)?.file?.path
  }

  /** Public imports of a file the document does not describe (bundled or `sources` files). */
  publicImports(path: string): string[] {
    return (this.symbols.files.get(path)?.imports ?? []).filter((i) => i.flag === "public").map((i) => i.path)
  }

  /** Fully qualified names known outside the document (for printing short names safely). */
  knownNames(): Iterable<string> {
    return this.symbols.symbols.keys()
  }
}

// ---- literals ---------------------------------------------------------------------------------------------------------

/** A `.proto` string literal: JSON's escapes are protobuf escapes too (`\uXXXX` for control characters). */
const quote = (s: string): string => JSON.stringify(s)

const quoteBytes = (b64: string): string => {
  let out = '"'
  for (const b of fromBase64(b64)) {
    if (b === 0x22) out += '\\"'
    else if (b === 0x5c) out += "\\\\"
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b)
    else out += `\\${b.toString(8).padStart(3, "0")}`
  }
  return `${out}"`
}

const floatLit = (v: unknown): string => {
  if (v === "Infinity") return "inf"
  if (v === "-Infinity") return "-inf"
  if (v === "NaN") return "nan"
  return String(v)
}

/** Print a scalar or enum value by type; unknown types: strings quoted. */
const scalarLit = (v: unknown, t: FType | undefined): string => {
  if (t?.kind === "enum") return String(v)
  if (t?.kind === "scalar") {
    const s = t.scalar
    if (s === "string") return quote(String(v))
    if (s === "bytes") return quoteBytes(String(v))
    if (FLOAT_KINDS.has(s)) return floatLit(v)
    return String(v)
  }
  if (typeof v === "string") return quote(v)
  return String(v)
}

/** Whether `v` is a canonical value of scalar kind `s` (so the builder reads it back unchanged). */
const fitsScalar = (v: unknown, s: ProtoScalar): boolean => {
  if (s === "bool") return typeof v === "boolean"
  if (s === "string" || s === "bytes") return typeof v === "string"
  if (FLOAT_KINDS.has(s)) {
    if (typeof v === "string") return v === "Infinity" || v === "-Infinity" || v === "NaN" || v === "-0"
    return typeof v === "number" && (s !== "float" || canonFloatOf(v, "float") === v)
  }
  const range = INT_RANGE[s]
  if (!range) return false
  if (INT64_KINDS.has(s) ? typeof v !== "string" || !/^-?\d+$/.test(v) : typeof v !== "number" || !Number.isInteger(v))
    return false
  const b = BigInt(v as string | number)
  return b >= range[0] && b <= range[1]
}

// ---- comment tags (decision 11, 13) ----------------------------------------------------------------------------------

/** Tag name -> spelling the builder recognises with the same `tags` option, or undefined when it is disabled. */
type TagSpelling = (t: TagName) => string | undefined

const tagSpelling = (tags: PrintOptions["tags"]): TagSpelling | undefined => {
  if (tags === false) return undefined
  const map = isPlainObject(tags) ? (tags as Partial<Record<TagName, string | false>>) : {}
  const renamed = new Set<string>()
  for (const v of Object.values(map)) if (typeof v === "string") renamed.add(v.replace(/^@/, "").toLowerCase())
  return (t) => {
    const r = map[t]
    if (r === false) return undefined
    if (typeof r === "string") return r.replace(/^@/, "")
    // a default name another tag was renamed to now means that tag (A-14)
    const name = `${t[0].toUpperCase()}${t.slice(1)}`
    return renamed.has(name.toLowerCase()) ? undefined : name
  }
}

// ---- conventions ----------------------------------------------------------------------------------------------------

const BV = "buf.validate.field"
const PGV = "validate.rules"
const FIELD_BEHAVIOR = "google.api.field_behavior"
const FIELD_INFO = "google.api.field_info"
const HTTP = "google.api.http"

/** STRING_FORMATS of the annotation layer, inverted: keyword value -> rule field. */
/** STRING_FORMATS of the annotation layer, inverted: keyword value -> rule field. */
const FORMAT_RULE: Record<string, string> = Object.fromEntries(Object.entries(STRING_FORMATS).map(([k, v]) => [v, k]))
const FIELD_INFO_FORMAT: Record<string, string> = { uuid: "UUID4", ipv4: "IPV4", ipv6: "IPV6", ip: "IPV4_OR_IPV6" }

type Target = "" | "items" | "propertyNames" | "additionalProperties"

/** A typed position of a field: the field itself, its items, map key or map value. */
interface Pos {
  target: Target
  node: Obj
  /** scalar kind (wrappers: their scalar) */
  scalar?: ProtoScalar
  enumFqn?: string
  messageFqn?: string
}

/** Value keywords: on `items` / `additionalProperties` for repeated and map fields (decision 5). */
const VALUE = new Set(
  "format minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength pattern enum const".split(
    " ",
  ),
)
/** Every annotation keyword a position can carry (design §3.2 order). */
const ANNOTATION_KEYWORDS =
  "format readOnly writeOnly immutable minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength pattern minItems maxItems uniqueItems minProperties maxProperties enum const examples".split(
    " ",
  )

type Shape = "singular" | "repeated" | "map"

/** The position a keyword is read back at: value keywords and value tags at the value position (design §3.8). */
const targetOf = (kw: string, shape: Shape): Target =>
  VALUE.has(kw) ? (shape === "repeated" ? "items" : shape === "map" ? "additionalProperties" : "") : ""

/** Option message types of the convention options the printer fills. */
const ROOT_TYPE: Record<string, string> = {
  [BV]: "buf.validate.FieldRules",
  [PGV]: "validate.FieldRules",
  [OA_FIELD]: `${OA}JSONSchema`,
  [OA_SCHEMA]: `${OA}Schema`,
  [FIELD_INFO]: "google.api.FieldInfo",
}
/** The rule path of a position inside FieldRules. */
const BASE: Record<Target, string[]> = {
  "": [],
  items: ["repeated", "items"],
  propertyNames: ["map", "keys"],
  additionalProperties: ["map", "values"],
}
/**
 * protovalidate / PGV rule field per keyword, with the family kinds it applies to (as the annotation layer lifts
 * them): n numeric, s string, b bytes, o bool, e enum, r repeated and m map (field level).
 */
const RULES: Record<string, [string, string]> = {
  minimum: ["n", "gte"],
  maximum: ["n", "lte"],
  exclusiveMinimum: ["n", "gt"],
  exclusiveMaximum: ["n", "lt"],
  minLength: ["sb", "min_len"],
  maxLength: ["sb", "max_len"],
  pattern: ["s", "pattern"],
  const: ["nsboe", "const"],
  enum: ["nsbe", "in"],
  examples: ["nsboe", "example"],
  minItems: ["r", "min_items"],
  maxItems: ["r", "max_items"],
  uniqueItems: ["r", "unique"],
  minProperties: ["m", "min_pairs"],
  maxProperties: ["m", "max_pairs"],
}
/** openapiv2 JSONSchema field per keyword (liftOpenapi of the annotation layer, inverted). */
const OPENAPI: Record<string, string> = {
  pattern: "pattern",
  format: "format",
  minLength: "min_length",
  maxLength: "max_length",
  multipleOf: "multiple_of",
  enum: "enum",
  minItems: "min_items",
  maxItems: "max_items",
  minProperties: "min_items",
  maxProperties: "max_items",
  uniqueItems: "unique_items",
  readOnly: "read_only",
  title: "title",
  minimum: "minimum",
  maximum: "maximum",
  exclusiveMinimum: "minimum",
  exclusiveMaximum: "maximum",
  examples: "example",
  "x-default": "default",
}
/** Comment tag per keyword and the kind of its value: b bound, c count, r / m count on repeated / map fields only,
 *  s one-line text, f one-line format (strings), e `@Enum` list, t flag, x one JSON value, X one line per value. */
const TAGS: Record<string, [TagName, string]> = {
  minimum: ["minimum", "b"],
  maximum: ["maximum", "b"],
  exclusiveMinimum: ["exclusiveMinimum", "b"],
  exclusiveMaximum: ["exclusiveMaximum", "b"],
  multipleOf: ["multipleOf", "b"],
  minLength: ["minLength", "c"],
  maxLength: ["maxLength", "c"],
  minItems: ["minItems", "r"],
  maxItems: ["maxItems", "r"],
  minProperties: ["minItems", "m"],
  maxProperties: ["maxItems", "m"],
  pattern: ["pattern", "s"],
  title: ["title", "s"],
  format: ["format", "f"],
  enum: ["enum", "e"],
  readOnly: ["readOnly", "t"],
  writeOnly: ["writeOnly", "t"],
  "x-default": ["default", "x"],
  examples: ["example", "X"],
}
const BEHAVIOR: Record<string, string> = { readOnly: "OUTPUT_ONLY", writeOnly: "INPUT_ONLY", immutable: "IMMUTABLE" }

/** `value` in the canonical form of an option field of type `t`, or undefined when it does not fit. */
const coerce = (v: unknown, t: FType): unknown => {
  if (t.repeated) {
    if (!Array.isArray(v)) return undefined
    const single = { ...t, repeated: false } as FType
    const out = v.map((x) => coerce(x, single))
    return out.includes(undefined) ? undefined : out
  }
  if (t.kind === "enum") return typeof v === "string" ? v : undefined
  if (t.kind !== "scalar") return undefined
  const s = t.scalar
  let x = v
  if (INT64_KINDS.has(s) && Number.isSafeInteger(v)) x = String(v)
  else if (FLOAT_KINDS.has(s) && typeof v === "string" && /^-?\d+$/.test(v) && String(Number(v)) === v) x = Number(v)
  return fitsScalar(x, s) ? x : undefined
}

/** `@Enum` text for string, numeric and enum positions (decision 11), or undefined. */
const enumTag = (v: unknown, slot: Pos): string | undefined => {
  if (!Array.isArray(v) || !v.length) return undefined
  const s = slot.scalar
  if (s === "string")
    return v.every((x) => typeof x === "string") ? v.map((x) => JSON.stringify(x)).join(", ") : undefined
  const ok = slot.enumFqn
    ? v.every((x) => (typeof x === "string" && /^[A-Za-z_]\w*$/.test(x)) || Number.isInteger(x))
    : !!s && NUMERIC.has(s) && v.every((x) => fitsScalar(x, s) && (typeof x !== "number" || DECIMAL.test(String(x))))
  return ok ? v.join(", ") : undefined
}

const PREFIX: Record<string, string> = {
  required: "Required.",
  readOnly: "Output only.",
  writeOnly: "Input only.",
  immutable: "Immutable.",
}
const DECIMAL = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

/** `a > b` for canonical bound values (numbers, 64-bit decimal strings, non-finite strings). */
const greater = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string" && typeof b === "string" && /^-?\d+$/.test(a) && /^-?\d+$/.test(b))
    return BigInt(a) > BigInt(b)
  return Number(a) > Number(b)
}

/** A lower bound above the upper bound: the protovalidate / PGV lift keeps such bounds raw (A-9, D-D). */
const outsideRange = (node: Obj): boolean => {
  const lower = node.exclusiveMinimum ?? node.minimum
  const upper = node.exclusiveMaximum ?? node.maximum
  return lower !== undefined && upper !== undefined && greater(lower, upper)
}

/** What a field prints besides its declaration: option trees, comment lines before / after the description. */
interface FieldPlan {
  options: Obj
  prefixes: string[]
  tags: string[]
}

// ---- printer ---------------------------------------------------------------------------------------------------------

interface PrintContext {
  doc: ProtoApiDocument
  oracle: Oracle
  indent: string
  /** comment annotations (tags, AIP prefixes, `Deprecated:` lines) may be printed */
  comments: boolean
  tag?: TagSpelling
  names: Set<string>
  /** component key -> file it is printed in */
  placement: Map<string, string>
  /** files of the document (or of the printed output for documents without `files`) */
  files: Record<string, ProtoApiFile>
}

/** Groups of consecutive equal keys (extensions of one extendee are printed in one `extend` block). */
const runs = <T>(items: T[], key: (t: T) => string): T[][] => {
  const out: T[][] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (last && key(last[0]) === key(it)) last.push(it)
    else out.push([it])
  }
  return out
}

const createFilePrinter = (ctx: PrintContext, path: string, file: ProtoApiFile) => {
  const lines: string[] = []
  const extraImports: string[] = []
  const syntax: ProtoSyntax = file.syntax ?? inferSyntax(ctx.doc, (k) => ctx.placement.get(k) === path)
  const editions = isEditions(syntax)
  /** features objects of the file and the enclosing messages, outermost first */
  const featureChain: (Obj | undefined)[] = [featuresOf(file.options)]
  /** message fqn or package used to print short type names */
  let curScope = file.package ?? ""
  const printedMessages = new Set<string>()
  /** files whose declarations this file may use (set once the helpers below exist) */
  let visible = new Set<string>()

  // ---- imports and visibility ----

  const visibleFiles = (): Set<string> => {
    const out = new Set<string>([path])
    const visit = (p: string) => {
      const f = ctx.files[p]
      const pub = f ? (f.imports ?? []).filter((i) => f.importFlags?.[i] === "public") : ctx.oracle.publicImports(p)
      for (const i of pub) {
        if (out.has(i)) continue
        out.add(i)
        visit(i)
      }
    }
    for (const i of file.imports ?? []) {
      out.add(i)
      visit(i)
    }
    return out
  }

  /** Make `path` available to this file: nothing when a written import already does, else an added import. */
  const need = (path: string | undefined) => {
    if (!path || visible.has(path)) return
    visible.add(path)
    extraImports.push(path)
    for (const p of ctx.oracle.publicImports(path)) visible.add(p)
  }

  const available = (optionKey: string): boolean => {
    const f = ctx.oracle.extensionFile(optionKey)
    return !!f && visible.has(f)
  }

  // ---- output ----

  const emit = (depth: number, text: string) => {
    const pad = ctx.indent.repeat(depth)
    const last = lines[lines.length - 1]
    // an empty body closes on its own line: `message A {}`
    if (text === "}" && last?.endsWith("{") && last.startsWith(pad) && !last.startsWith(`${pad}//`)) {
      lines[lines.length - 1] = `${last}}`
      return
    }
    lines.push(text ? `${pad}${text}` : "")
  }

  const comment = (depth: number, lines: (string | undefined)[]) => {
    for (const l of lines) {
      if (l === undefined) continue
      for (const part of l.split("\n")) emit(depth, part ? `// ${part}` : "//")
    }
  }

  const tagLine = (t: TagName, value?: string): string | undefined => {
    const name = ctx.comments ? ctx.tag?.(t) : undefined
    if (!name) return undefined
    return value === undefined ? `@${name}` : `@${name} ${value}`
  }

  /**
   * Comment lines of an element: the `Deprecated:` line (first: it applies to the first line, item 10), the
   * description, `@Title`, then `extra`. `bareDeprecated`: deprecation without a reason prints as a bare
   * `Deprecated:` line (oneofs have no `deprecated` option, A-4).
   */
  const elementComment = (
    e: ProtoApiElement,
    defaultTitle: string | undefined,
    extra: string[] = [],
    bareDeprecated = false,
  ): string[] => {
    const out: string[] = []
    if (ctx.comments && e.deprecation?.reason) out.push(`Deprecated: ${e.deprecation.reason}`)
    else if (ctx.comments && e.deprecation && bareDeprecated) out.push("Deprecated:")
    if (typeof e.description === "string" && e.description) out.push(e.description)
    if (typeof e.title === "string" && e.title !== defaultTitle) {
      const t = tagLine("title", e.title)
      if (t) out.push(t)
    }
    out.push(...extra)
    return out
  }

  // ---- values ----

  /** Text-format value for an option of type `t`. */
  const valueText = (v: unknown, t: FType | undefined): string => {
    if (t?.kind === "message" && t.map && isPlainObject(v)) {
      const key: FType = { kind: "scalar", scalar: t.map.key }
      const value = t.map.value
      return `[${Object.entries(v)
        .map(
          ([k, x]) =>
            `{ key: ${scalarLit(key.scalar === "bool" ? k === "true" : k, key)} value: ${valueText(x, value)} }`,
        )
        .join(", ")}]`
    }
    if (
      isPlainObject(v) &&
      typeof v["@type"] === "string" &&
      (!t || (t.kind === "message" && t.fqn === "google.protobuf.Any"))
    )
      return anyText(v)
    if (t?.kind === "message" && isPlainObject(v)) return aggregate(v, t.fqn)
    if (isPlainObject(v)) return aggregate(v, "")
    if (Array.isArray(v))
      return `[${v.map((x) => valueText(x, t ? ({ ...t, repeated: false } as FType) : undefined)).join(", ")}]`
    return scalarLit(v, t)
  }

  /** An `Any` in its ProtoJSON form (`{ "@type": url, … }`) as the expanded text form `{ [url] { … } }` (P-8). */
  const anyText = (v: Obj): string => {
    const url = String(v["@type"])
    const fqn = url.slice(url.lastIndexOf("/") + 1)
    if (fqn === "google.protobuf.Any" && isPlainObject(v.value)) return `{ [${url}] ${anyText(v.value)} }`
    let payload: Obj | undefined
    if (WKT_VALUE_FORM.has(fqn)) payload = fromWktJson(fqn, v.value) as Obj | undefined
    if (!payload) {
      payload = { ...v }
      delete payload["@type"]
    }
    return `{ [${url}] ${aggregate(payload, ctx.oracle.symbols.message(fqn) || ctx.doc.components?.messages?.[fqn] ? fqn : "")} }`
  }

  const aggregate = (v: Obj, fqn: string): string => {
    const parts: string[] = []
    for (const [k, x] of Object.entries(v)) {
      const t = fqn ? ctx.oracle.field(fqn, k) : undefined
      const name = k.includes(".") || k.includes("/") ? `[${k}]` : k
      const single = t ? ({ ...t, repeated: false } as FType) : undefined
      if (Array.isArray(x)) parts.push(`${name}: [${x.map((y) => valueText(y, single)).join(", ")}]`)
      else if (isPlainObject(x) && !(t && "map" in t && t.map)) parts.push(`${name} ${valueText(x, single)}`)
      else parts.push(`${name}: ${valueText(x, single)}`)
    }
    return parts.length ? `{ ${parts.join(" ")} }` : "{}"
  }

  /** Option assignments `name = value` for an element's options tree (kind = options message). */
  const optionAssignments = (options: Obj | undefined, kind: keyof typeof OPTIONS_MESSAGE): string[] => {
    if (!options || !isPlainObject(options)) return []
    const optFqn = OPTIONS_MESSAGE[kind]
    const out: string[] = []
    const push = (name: string, v: unknown, t: FType | undefined) => {
      if (Array.isArray(v))
        for (const x of v) out.push(`${name} = ${valueText(x, t ? ({ ...t, repeated: false } as FType) : undefined)}`)
      else out.push(`${name} = ${valueText(v, t)}`)
    }
    for (const [key, v] of Object.entries(options)) {
      if (
        key === "visibility" ||
        key === "extension_declarations" ||
        v === undefined ||
        (Array.isArray(v) && !v.length)
      )
        continue
      const t = ctx.oracle.field(optFqn, key)
      const isExt = key.includes(".")
      const name = isExt ? `(${key})` : key
      if (!t && (typeof v === "string" || isPlainObject(v))) {
        // an unknown option: the source text as written, a sub-path (`(unk.sub).x`) from nested keys
        const raw = (path: string, x: unknown): unknown =>
          isPlainObject(x)
            ? Object.entries(x).forEach(([k, y]) => raw(`${path}.${k}`, y))
            : (Array.isArray(x) ? x : [x]).forEach((y) => out.push(`${path} = ${y}`))
        raw(`(${key})`, v)
        continue
      }
      if (key === "features" && isPlainObject(v)) {
        const flat = (prefix: string, obj: Obj, fqn: string) => {
          for (const [fk, fv] of Object.entries(obj)) {
            const ft = ctx.oracle.field(fqn, fk)
            const seg = fk.includes(".") ? `(${fk})` : fk
            if (fk.includes(".")) need(ctx.oracle.extensionFile(fk))
            if (isPlainObject(fv) && ft?.kind === "message") flat(`${prefix}.${seg}`, fv, ft.fqn)
            else push(`${prefix}.${seg}`, fv, ft)
          }
        }
        flat("features", v, "google.protobuf.FeatureSet")
        continue
      }
      if (isExt) need(ctx.oracle.extensionFile(key))
      push(name, v, t)
    }
    return out
  }

  // ---- types ----

  const typeName = (ref: string): string => {
    const fqn = refFqn(ref)
    if (!ctx.names.has(fqn)) return unresolvedName(fqn)
    need(ctx.placement.get(fqn) ?? ctx.oracle.typeFile(fqn))
    return shortestName(fqn, curScope, ctx.names)
  }

  /** A name the document does not declare (an unresolved reference): spelled so that the builder's best-effort key
   *  (`unresolvedKey`: dotted names as written, simple names in the package) is the same key again. */
  const unresolvedName = (fqn: string): string => {
    const pkg = file.package
    const rest = pkg && fqn.startsWith(`${pkg}.`) ? fqn.slice(pkg.length + 1) : "."
    return rest.includes(".") ? fqn : rest
  }

  const typeOf = (t: ProtoApiTypeRef | ProtoApiField): string => {
    const scalar = scalarOf(t)
    if (scalar) return scalar
    if ("$ref" in t && t.$ref) return typeName(t.$ref)
    return "bytes"
  }

  /** Inherited value of an editions feature for the current element (file, enclosing messages, `extra`). */
  const inheritedFeature = (name: string, extra?: Obj): unknown => {
    let v: unknown
    for (const f of featureChain) if (f && f[name] !== undefined) v = f[name]
    if (extra && extra[name] !== undefined) v = extra[name]
    return v
  }

  // ---- annotation keywords (decision 11) ----

  /** The positions of a field: itself, items, map key, map value. */
  const positionsOf = (f: ProtoApiField): Pos[] => {
    const posOf = (target: Target, node: unknown): Pos => {
      const n = (isPlainObject(node) ? node : {}) as Obj
      const p: Pos = { target, node: n }
      const scalar = scalarOf(n)
      if (scalar) p.scalar = scalar
      else if (typeof n.$ref === "string") {
        const fqn = refFqn(n.$ref)
        if (n.$ref.includes("/enums/")) p.enumFqn = fqn
        else {
          p.messageFqn = fqn
          if (fqn in WRAPPERS) p.scalar = WRAPPERS[fqn]
        }
      }
      return p
    }
    const self = f as unknown as Obj
    if (f.type === "array") return [{ target: "", node: self }, posOf("items", f.items)]
    if (f.type === "object" && f.additionalProperties)
      return [
        { target: "", node: self },
        posOf("propertyNames", f.propertyNames),
        posOf("additionalProperties", f.additionalProperties),
      ]
    return [posOf("", self)]
  }

  /**
   * Set `path` in the option tree `root[key]` when the option is available to the file, the definitions have every
   * segment, no oneof sibling is set, the leaf is free and `value` fits the leaf's type (64-bit numbers become decimal
   * strings, exact digit strings of a double leaf numbers); returns false and changes nothing otherwise.
   */
  const trySet = (root: Obj, key: string, path: string[], value: unknown): boolean => {
    if (!available(key)) return false
    const oracle = ctx.oracle
    let fqn = ROOT_TYPE[key]
    let node: Obj | undefined = isPlainObject(root[key]) ? (root[key] as Obj) : undefined
    let leaf: unknown
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]
      const def = oracle.fieldDef(fqn, seg)
      const t = oracle.field(fqn, seg)
      if (!def || !t) return false
      const n = node
      if (
        def.oneof &&
        n &&
        oracle.symbols
          .message(fqn)
          ?.fields.some((x) => x.oneof === def.oneof && n[x.name] !== undefined && x.name !== seg)
      )
        return false
      if (i === path.length - 1) {
        if (n?.[seg] !== undefined) return false
        leaf = coerce(value, t)
        if (leaf === undefined) return false
        break
      }
      if (t.kind !== "message" || t.repeated || ("map" in t && t.map)) return false
      const next: unknown = n?.[seg]
      if (next !== undefined && !isPlainObject(next)) return false
      node = next as Obj | undefined
      fqn = t.fqn
    }
    let tree = root[key] as Obj
    if (!isPlainObject(tree)) root[key] = tree = {}
    for (const seg of path.slice(0, -1)) tree = (tree[seg] ??= {}) as Obj
    tree[path[path.length - 1]] = leaf
    return true
  }

  /** Values of the enum family (`const`, `in`, `example`) are numbers in protovalidate / PGV. */
  const enumNumbers = (p: Pos, v: unknown): unknown => {
    const one = (x: unknown) =>
      typeof x === "number" ? x : typeof x === "string" ? ctx.oracle.enumNumber(p.enumFqn, x) : undefined
    const out = (Array.isArray(v) ? v : [v]).map(one)
    return out.includes(undefined) ? undefined : Array.isArray(v) ? out : out[0]
  }

  /** protovalidate / PGV (`key`) for keyword `kw` of position `p` (rule families as the annotation layer lifts them). */
  const tryRules = (o: Obj, key: string, p: Pos, shape: Shape, kw: string, v: unknown): boolean => {
    const r = RULES[kw]
    if (p.target === "" && shape !== "singular")
      return !!r && r[0].includes(shape === "repeated" ? "r" : "m") && trySet(o, key, [shape, r[1]], v)
    const fam = p.scalar ?? (p.enumFqn ? "enum" : p.messageFqn ? WKT_FAMILY[p.messageFqn] : undefined)
    if (!fam) return false
    const kind = NUMERIC.has(fam) ? "n" : ({ string: "s", bytes: "b", bool: "o", enum: "e" } as Obj)[fam]
    let rule = r && typeof kind === "string" && r[0].includes(kind) ? r[1] : undefined
    let value = v
    if (kw === "format" && kind === "s" && typeof v === "string" && FORMAT_RULE[v]) {
      rule = FORMAT_RULE[v]
      value = true
    }
    if (!rule) return false
    if (kind === "e") value = enumNumbers(p, v)
    const base = BASE[p.target]
    if (r?.[0] === "n") {
      // A-9: bounds next to raw bounds of the family, or a lower bound above the upper one, are read back as
      // protovalidate's outside range (raw)
      let raw: unknown = rawOptions[key]
      for (const s of [...base, fam]) raw = isPlainObject(raw) ? raw[s] : undefined
      if (outsideRange(p.node) || (isPlainObject(raw) && ["gt", "gte", "lt", "lte"].some((b) => b in raw))) return false
    }
    return value !== undefined && trySet(o, key, [...base, fam, rule], value)
  }

  /** openapiv2_field for keyword `kw`: value keywords at the value position (decision 5), the rest on the field. */
  const tryOpenapi = (o: Obj, p: Pos, shape: Shape, kw: string, v: unknown): boolean => {
    const rule = OPENAPI[kw]
    if (!rule || p.target !== targetOf(kw, shape)) return false
    if ((kw.endsWith("Items") && shape !== "repeated") || (kw.endsWith("Properties") && shape !== "map")) return false
    let value = v
    if (kw === "examples") {
      if (!Array.isArray(v) || v.length !== 1) return false
      value = JSON.stringify(v[0])
    } else if (kw === "x-default") value = JSON.stringify(v)
    const exclusive = kw.startsWith("exclusive")
    // `minimum` and `exclusiveMinimum` share the openapiv2 field
    if (rule === "minimum" || rule === "maximum")
      if (p.node[exclusive ? rule : `exclusive${rule[0].toUpperCase()}${rule.slice(1)}`] !== undefined) return false
    if (!trySet(o, OA_FIELD, [rule], value)) return false
    if (exclusive) trySet(o, OA_FIELD, [`exclusive_${rule}`], true)
    return true
  }

  /** A comment tag for keyword `kw`; value tags target the value position of the field (design §3.8). */
  const tryTag = (plan: FieldPlan, p: Pos, shape: Shape, kw: string, v: unknown, slot: Pos): boolean => {
    const spec = TAGS[kw]
    if (!spec || p.target !== targetOf(kw, shape)) return false
    const [tag, k] = spec
    const ok = (c: unknown, x: unknown = v) => (c ? String(x) : undefined)
    const values: unknown[] =
      k === "b" // decimal numbers; on 64-bit fields decimal integer digits (A-1, A-6)
        ? [
            ok(
              slot.scalar && INT64_KINDS.has(slot.scalar)
                ? typeof v === "string" && /^-?\d+$/.test(v)
                : typeof v === "number" && !Object.is(v, -0) && DECIMAL.test(String(v)),
            ),
          ]
        : k === "c" || k === "r" || k === "m" // counts; @MinItems on repeated fields, on maps it counts entries (decision 4)
          ? [
              ok(
                (k === "c" || shape === (k === "r" ? "repeated" : "map")) &&
                  Number.isSafeInteger(v) &&
                  (v as number) >= 0,
              ),
            ]
          : k === "s" || k === "f" // one line; @Format on strings only
            ? [
                ok(
                  typeof v === "string" &&
                    v &&
                    v === v.trim() &&
                    !v.includes("\n") &&
                    (k === "s" || slot.scalar === "string"),
                ),
              ]
            : k === "e"
              ? [enumTag(v, slot)]
              : k === "t"
                ? [ok(v === true, "")]
                : k === "x"
                  ? [JSON.stringify(v)]
                  : Array.isArray(v) && v.length
                    ? v.map((e) => JSON.stringify(e))
                    : [undefined]
    const lines = values.map((x) => (typeof x === "string" ? tagLine(tag, x || undefined) : undefined))
    if (lines.includes(undefined)) return false
    plan.tags.push(...(lines as string[]))
    return true
  }

  /** the field's options as the document holds them (the raw remainder of lifted conventions) */
  let rawOptions: Obj = {}

  /** Print every annotation keyword of a field back as options, tags or prefixes (decision 11). */
  const planField = (f: ProtoApiField, comments: boolean): FieldPlan => {
    rawOptions = isPlainObject(f.options) ? f.options : {}
    const o = structuredClone(rawOptions) as Obj
    const plan: FieldPlan = { options: o, prefixes: [], tags: [] }
    const shape: Shape =
      f.type === "array" ? "repeated" : f.type === "object" && f.additionalProperties ? "map" : "singular"
    const positions = positionsOf(f)
    const slot = positions[shape === "repeated" ? 1 : shape === "map" ? 2 : 0]
    const tags = comments && ctx.comments
    const fb = (value: string) => {
      if (!available(FIELD_BEHAVIOR)) return false
      const list = Array.isArray(o[FIELD_BEHAVIOR]) ? (o[FIELD_BEHAVIOR] as unknown[]) : []
      if (!list.includes(value)) o[FIELD_BEHAVIOR] = [...list, value]
      return true
    }
    const prefix = (kw: string) => !!(tags && PREFIX[kw] && plan.prefixes.push(PREFIX[kw]))
    const forced = (key: string, then: () => unknown) => () => {
      // no available option and no tag spells the keyword (`const`, `uniqueItems`, map keys, `immutable` without
      // comments): the convention option is printed with its import (documents not built from this text)
      const file = ctx.oracle.extensionFile(key)
      if (!file || visible.has(file)) return
      need(file)
      then()
    }
    const first = (attempts: (() => boolean)[], fallback?: () => void) => {
      if (!attempts.some((a) => a())) fallback?.()
    }
    // the Identifier prefix adds IDENTIFIER to field_behavior; without the import it prints as the prefix
    const listed = o[FIELD_BEHAVIOR]
    if (tags && Array.isArray(listed) && listed.includes("IDENTIFIER") && !available(FIELD_BEHAVIOR)) {
      plan.prefixes.push("Identifier.")
      o[FIELD_BEHAVIOR] = listed.filter((x) => x !== "IDENTIFIER")
    }
    if (f.required === true)
      first(
        [
          () => fb("REQUIRED"),
          () => trySet(o, BV, ["required"], true),
          () => shape === "singular" && !!positions[0].messageFqn && trySet(o, PGV, ["message", "required"], true),
          () => !!(tags && tagLine("required") && plan.tags.push(tagLine("required") as string)),
          () => prefix("required"),
        ],
        forced(FIELD_BEHAVIOR, () => fb("REQUIRED")),
      )
    for (const p of positions)
      for (const kw of ANNOTATION_KEYWORDS) {
        const v = p.node[kw]
        if (v === undefined) continue
        const behavior = p.target === "" && v === true ? BEHAVIOR[kw] : undefined
        first(
          [
            () => !!behavior && fb(behavior),
            () =>
              kw === "format" &&
              p === positions[shape === "repeated" ? 1 : 0] &&
              shape !== "map" &&
              p.scalar === "string" &&
              typeof v === "string" &&
              !!FIELD_INFO_FORMAT[v] &&
              trySet(o, FIELD_INFO, ["format"], FIELD_INFO_FORMAT[v]),
            () => tryRules(o, BV, p, shape, kw, v),
            () => tryRules(o, PGV, p, shape, kw, v),
            () => tryOpenapi(o, p, shape, kw, v),
            () => !!tags && tryTag(plan, p, shape, kw, v, slot),
            () => p.target === "" && v === true && prefix(kw),
          ],
          behavior ? forced(FIELD_BEHAVIOR, () => fb(behavior)) : forced(BV, () => tryRules(o, BV, p, shape, kw, v)),
        )
      }
    for (const [kw, v] of [
      ["x-default", f["x-default"]],
      ["title", f.title],
    ] as const)
      if (v !== undefined)
        first([
          () => tryOpenapi(o, positions[0], shape, kw, v),
          () => !!tags && tryTag(plan, positions[0], shape, kw, v, slot),
        ])
    return plan
  }

  // ---- fields ----

  const printField = (
    depth: number,
    name: string,
    f: ProtoApiField,
    inOneof: boolean,
    oneofFeatures: Obj | undefined,
    extension: boolean,
    groupMessage?: string,
  ) => {
    const opts: string[] = []
    if (f.deprecation) opts.push("deprecated = true")
    if (f.jsonName !== undefined && !extension) opts.push(`json_name = ${quote(f.jsonName)}`)
    const scalar = scalarOf(f)
    const valueType: FType | undefined = scalar
      ? { kind: "scalar", scalar }
      : f.$ref?.includes("/enums/")
        ? { kind: "enum" }
        : undefined
    if (f.default !== undefined) opts.push(`default = ${scalarLit(f.default, valueType)}`)
    let label = ""
    const singular = f.type !== "array" && !(f.type === "object" && f.additionalProperties)
    const isMessageRef = !!f.$ref && !f.$ref.includes("/enums/")
    if (f.type === "array") label = "repeated "
    else if (!inOneof && singular) {
      if (syntax === "proto2") label = f.presence === "required" ? "required " : "optional "
      else if (syntax === "proto3") label = f.presence === "explicit" && !extension ? "optional " : ""
      else if (!extension) {
        const inherited = (inheritedFeature("field_presence", oneofFeatures) as string | undefined) ?? "EXPLICIT"
        const want =
          f.presence === "required"
            ? "LEGACY_REQUIRED"
            : f.presence === "explicit" || isMessageRef
              ? "EXPLICIT"
              : "IMPLICIT"
        if (want !== inherited && !(isMessageRef && want === "EXPLICIT")) opts.push(`features.field_presence = ${want}`)
      }
    }
    if (extension && syntax === "proto2" && f.type !== "array") label = "optional "
    const messageTyped =
      (singular && isMessageRef) ||
      (f.type === "array" && !!f.items && "$ref" in f.items && !f.items.$ref.includes("/enums/"))
    if (editions && messageTyped) {
      const inherited = (inheritedFeature("message_encoding", oneofFeatures) as string | undefined) ?? "LENGTH_PREFIXED"
      const want = f.delimited ? "DELIMITED" : "LENGTH_PREFIXED"
      if (want !== inherited) opts.push(`features.message_encoding = ${want}`)
    }
    opts.push(...resolvedFeatureOptions(f))
    const plan = planField(f, !groupMessage)
    opts.push(...optionAssignments(plan.options, "field"))
    const optText = opts.length ? ` [${opts.join(", ")}]` : ""
    if (groupMessage) {
      // proto2 groups: the comment belongs to the generated message (protoc attaches it there)
      const g = ctx.doc.components?.messages?.[groupMessage] as ProtoApiMessage
      comment(depth, messageComment(groupMessage, g))
      const groupName = lastSegment(groupMessage)
      const lbl = inOneof ? "" : f.type === "array" ? "repeated " : label
      emit(depth, `${lbl}group ${groupName} = ${f.number}${optText} {`)
      printedMessages.add(groupMessage)
      messageBody(depth + 1, groupMessage, g)
      emit(depth, "}")
      return
    }
    // comment: AIP prefixes and the `Deprecated:` line on the first line (they apply to the first line, item 10)
    const first: string[] = [...plan.prefixes]
    if (ctx.comments && f.deprecation?.reason) first.push(`Deprecated: ${f.deprecation.reason}`)
    const lines: string[] = []
    if (first.length) lines.push(first.join(" "))
    if (typeof f.description === "string" && f.description) lines.push(f.description)
    lines.push(...plan.tags)
    comment(depth, lines)
    let type: string
    if (f.type === "object" && f.additionalProperties) {
      type = `map<${scalarOf(f.propertyNames) ?? "string"}, ${typeOf(f.additionalProperties)}>`
      label = ""
    } else if (f.type === "array" && f.items) type = typeOf(f.items)
    else type = typeOf(f)
    emit(depth, `${label}${type} ${name} = ${f.number}${optText};`)
  }

  /**
   * The resolved keywords `packed: false` and `utf8Validation: false` (validation F-3) in the spelling of the syntax:
   * proto2 prints `[packed = true]` when `packed` is absent (its default is EXPANDED), proto3 `[packed = false]`,
   * editions `features.repeated_field_encoding = EXPANDED` / `features.utf8_validation = NONE` (files and messages
   * never carry these features, so the edition defaults PACKED and VERIFY apply).
   */
  const resolvedFeatureOptions = (f: ProtoApiField): string[] => {
    const out: string[] = []
    const items = f.type === "array" ? f.items : undefined
    const packable =
      !!items &&
      (scalarOf(items)
        ? scalarOf(items) !== "string" && scalarOf(items) !== "bytes"
        : "$ref" in items && !!items.$ref?.includes("/enums/"))
    if (packable) {
      if (syntax === "proto2" && f.packed !== false) out.push("packed = true")
      else if (syntax === "proto3" && f.packed === false) out.push("packed = false")
      else if (editions && f.packed === false) out.push("features.repeated_field_encoding = EXPANDED")
    }
    const noUtf8 = (r: unknown) => !!r && (r as { utf8Validation?: boolean }).utf8Validation === false
    if (
      editions &&
      (f.utf8Validation === false || noUtf8(items) || noUtf8(f.propertyNames) || noUtf8(f.additionalProperties))
    )
      out.push("features.utf8_validation = NONE")
    return out
  }

  // ---- messages ----

  let children: Record<"messages" | "enums", Map<string, string[]>> | undefined

  const nestedOf = (fqn: string, kind: "messages" | "enums"): string[] => {
    if (!children) {
      children = { messages: new Map(), enums: new Map() }
      for (const k of ["messages", "enums"] as const) {
        const comps = ctx.doc.components?.[k] ?? {}
        for (const key of Object.keys(comps)) {
          if (ctx.placement.get(key) !== path) continue
          const parent = parentMessage(key)
          if (parent === undefined) continue
          const list = children[k].get(parent)
          if (list) list.push(key)
          else children[k].set(parent, [key])
        }
      }
    }
    return children[kind].get(fqn) ?? []
  }

  /** The message a component is nested in (undefined at top level); missing parents become wrapper messages. */
  const parentMessage = (key: string): string | undefined => {
    const pkg = file.package ?? ""
    const parent = parentScope(key)
    if (!parent || parent === pkg || (pkg && !key.startsWith(`${pkg}.`))) return undefined
    return parent
  }

  /** Top-level message keys of this file, with wrapper messages for nested types (and extensions) whose parent
   *  message is missing (D3 emits referenced types only): a wrapper message keeps their fully qualified names. */
  const topLevel = (): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    const msgs = ctx.doc.components?.messages ?? {}
    const add = (key: string) => {
      const parent = parentMessage(key)
      if (parent === undefined) {
        if (!seen.has(key)) {
          seen.add(key)
          out.push(key)
        }
        return
      }
      if (!msgs[parent] || ctx.placement.get(parent) !== path) add(parent)
    }
    for (const k of ["messages", "enums", "extensions"] as const)
      for (const key of Object.keys(ctx.doc.components?.[k] ?? {}))
        if (ctx.placement.get(key) === path && (k === "messages" || parentMessage(key) !== undefined)) add(key)
    return out
  }

  /** The proto2 group message a field or extension declares, if it prints as a group (P-1). */
  const groupOf = (name: string, f: ProtoApiField, scope: string): string | undefined => {
    if (syntax !== "proto2" || !f.delimited) return undefined
    const ref = f.$ref ?? (f.type === "array" && f.items && "$ref" in f.items ? f.items.$ref : undefined)
    if (!ref) return undefined
    const fqn = refFqn(ref)
    if (parentScope(fqn) !== scope || lastSegment(fqn).toLowerCase() !== name) return undefined
    const m = ctx.doc.components?.messages?.[fqn]
    if (!m || ctx.placement.get(fqn) !== path || printedMessages.has(fqn)) return undefined
    return fqn
  }

  /** Extensions declared in `scope` (a message, a wrapper or the package), in document order. */
  const extensionsIn = (scope: string): [string, ProtoApiExtension][] => {
    const out: [string, ProtoApiExtension][] = []
    const pkg = file.package ?? ""
    for (const [k, x] of Object.entries(ctx.doc.components?.extensions ?? {})) {
      if (ctx.placement.get(k) !== path || !isPlainObject(x)) continue
      // extensions outside the file's package can only be printed at file level
      const s = parentMessage(k) ?? pkg
      if (s === scope) out.push([k, x])
    }
    return out
  }

  /**
   * Nested messages, extension blocks and (for message bodies) fields of one scope, keeping the order of each
   * (components.messages, components.extensions, properties): a group message is printed by its field or extension,
   * so the nested messages before it are printed first (P-4, P-5).
   */
  const printScope = (
    depth: number,
    scope: string,
    children: string[],
    fieldsPart?: (flushBefore: (fqn: string) => void) => void,
  ) => {
    const exts = extensionsIn(scope)
    const extGroups = new Map<string, number>()
    exts.forEach(([k, x], i) => {
      const g = groupOf(lastSegment(k), x, scope)
      if (g) extGroups.set(g, i)
    })
    let nextExt = 0
    const flushExts = (through: number) => {
      if (through < nextExt) return
      const slice = exts.slice(nextExt, through + 1)
      nextExt = through + 1
      for (const run of runs(slice, ([, x]) => x.extendee ?? "")) printExtendBlock(depth, scope, run)
    }
    let nextChild = 0
    const flushChildren = (until: number) => {
      for (; nextChild < until; nextChild++) {
        const c = children[nextChild]
        if (printedMessages.has(c)) continue
        const owner = extGroups.get(c)
        if (owner !== undefined) flushExts(owner)
        else if (!fieldGroups.has(c)) printMessage(depth, c)
      }
    }
    const flushBefore = (fqn: string) => {
      const i = children.indexOf(fqn)
      if (i >= 0) flushChildren(i)
    }
    fieldsPart?.(flushBefore)
    flushChildren(children.length)
    flushExts(exts.length - 1)
  }

  /** group messages owned by fields of the message being printed */
  let fieldGroups = new Set<string>()

  const messageBody = (depth: number, fqn: string, m: ProtoApiMessage) => {
    const outerScope = curScope
    const outerGroups = fieldGroups
    curScope = fqn
    featureChain.push({ ...featuresOf(m.options) })
    try {
      messageBodyInner(depth, fqn, m)
    } finally {
      featureChain.pop()
      curScope = outerScope
      fieldGroups = outerGroups
    }
  }

  /** Message options with the annotation keywords that have a message-level option (openapiv2_schema). */
  const messageOptions = (fqn: string, m: ProtoApiMessage): { options: Obj; tags: string[] } => {
    const o = structuredClone(withDeprecated(m))
    const tags: string[] = []
    if (typeof m.title === "string" && m.title !== lastSegment(fqn)) {
      const ok = trySet(o, OA_SCHEMA, ["json_schema", "title"], m.title)
      if (!ok) {
        const t = tagLine("title", m.title)
        if (t) tags.push(t)
      }
    }
    return { options: o, tags }
  }

  const messageBodyInner = (depth: number, fqn: string, m: ProtoApiMessage) => {
    const { options } = messageOptions(fqn, m)
    for (const line of optionAssignments(options, "message")) emit(depth, `option ${line};`)
    printJsonFormat(depth, m.jsonFormat, true)
    const properties: Record<string, ProtoApiField> = isPlainObject(m.properties) ? m.properties : {}
    const entries = Object.entries(properties)
    const groups = new Map<string, string>()
    for (const [name, f] of entries) {
      const g = groupOf(name, f, fqn)
      if (g) groups.set(name, g)
    }
    fieldGroups = new Set(groups.values())
    const children = nestedOf(fqn, "messages")
    printScope(depth, fqn, children, (flushBefore) => {
      const printedOneofs = new Set<string>()
      for (const [name, f] of entries) {
        if (f.oneof) {
          if (printedOneofs.has(f.oneof)) continue
          printedOneofs.add(f.oneof)
          const members = entries.filter(([, f2]) => f2.oneof === f.oneof)
          for (const [n2] of members) {
            const g = groups.get(n2)
            if (g) flushBefore(g)
          }
          const o = (isPlainObject(m.oneofs) ? m.oneofs[f.oneof] : undefined) ?? {}
          comment(depth, elementComment(o, undefined, [], true))
          emit(depth, `oneof ${f.oneof} {`)
          for (const line of optionAssignments(o.options as Obj | undefined, "oneof"))
            emit(depth + 1, `option ${line};`)
          const oneofFeatures = featuresOf(o.options)
          for (const [n2, f2] of members) printField(depth + 1, n2, f2, true, oneofFeatures, false, groups.get(n2))
          emit(depth, "}")
          continue
        }
        const g = groups.get(name)
        if (g) flushBefore(g)
        printField(depth, name, f, false, undefined, false, g)
      }
    })
    for (const n of nestedOf(fqn, "enums")) printEnum(depth, n)
    printReserved(depth, m.reserved, false)
    printExtensionRanges(depth, m)
  }

  const printReserved = (depth: number, r: unknown, isEnum: boolean) => {
    if (!isPlainObject(r)) return
    const max = isEnum ? INT32_MAX : FIELD_NUMBER_MAX
    const numbers = Array.isArray(r.numbers) ? (r.numbers as [number, number][]) : []
    if (numbers.length)
      emit(
        depth,
        `reserved ${numbers.map(([a, b]) => (a === b ? `${a}` : b === max ? `${a} to max` : `${a} to ${b}`)).join(", ")};`,
      )
    const names = Array.isArray(r.names) ? (r.names as string[]) : []
    if (names.length) emit(depth, `reserved ${names.map((n) => (editions ? n : quote(n))).join(", ")};`)
  }

  const printExtensionRanges = (depth: number, m: ProtoApiMessage) => {
    const decls = isPlainObject(m.options)
      ? (m.options.extension_declarations as Record<string, unknown[]> | undefined)
      : undefined
    // extensionOptions (F-1): each range with options is printed on its own, the rest of a merged interval around it
    const rangeOpts = [...(Array.isArray(m.extensionOptions) ? m.extensionOptions : [])].sort(
      (x, y) => x.range[0] - y.range[0],
    )
    const messageSet = isPlainObject(m.options) && m.options.message_set_wire_format === true
    const printRange = (a: number, b: number, opts: string[]) => {
      const max = b === FIELD_NUMBER_MAX || (messageSet && b === MESSAGE_SET_NUMBER_MAX)
      const range = a === b ? `${a}` : max ? `${a} to max` : `${a} to ${b}`
      emit(depth, `extensions ${range}${opts.length ? ` [${opts.join(", ")}]` : ""};`)
    }
    const rangeOptions = (o: unknown) => optionAssignments(o as Obj, "extensionRange")
    for (const [a, b] of Array.isArray(m.extensions) ? m.extensions : []) {
      const d = decls?.[`${a}-${b}`]
      const inside = rangeOpts.filter((e) => e.range[0] >= a && e.range[1] <= b)
      if (d) {
        const own = inside.find((e) => e.range[0] === a && e.range[1] === b)
        printRange(a, b, [
          ...(Array.isArray(d) ? d : []).map(
            (x) => `declaration = ${aggregate(x as Obj, "google.protobuf.ExtensionRangeOptions.Declaration")}`,
          ),
          ...(own ? rangeOptions(own.options) : []),
        ])
        continue
      }
      let next = a
      for (const e of inside) {
        if (e.range[0] > next) printRange(next, e.range[0] - 1, [])
        printRange(e.range[0], e.range[1], rangeOptions(e.options))
        next = e.range[1] + 1
      }
      if (next <= b) printRange(next, b, [])
    }
  }

  /**
   * `jsonFormat` (F-3) in editions: the feature when it differs from the value the element inherits from the printed
   * file and enclosing messages (absent means ALLOW). A message records what it prints for its nested types.
   */
  const printJsonFormat = (depth: number, jsonFormat: string | undefined, message: boolean) => {
    if (!editions) return
    const want = jsonFormat ?? "ALLOW"
    const inherited = (inheritedFeature("json_format") as string | undefined) ?? "ALLOW"
    if (want !== inherited) emit(depth, `option features.json_format = ${want};`)
    const top = featureChain[featureChain.length - 1]
    if (message && top) top.json_format = want
  }

  /** Comment of a message: `@Title` only when openapiv2_schema cannot carry the title. */
  const messageComment = (fqn: string, m: ProtoApiMessage): string[] => {
    const { tags } = messageOptions(fqn, m)
    return elementComment({ ...m, title: undefined }, undefined, tags)
  }

  const printMessage = (depth: number, fqn: string) => {
    if (printedMessages.has(fqn)) return
    printedMessages.add(fqn)
    const m = ctx.doc.components?.messages?.[fqn]
    const name = lastSegment(fqn)
    if (!m) {
      // wrapper for nested types whose parent is not in the document
      emit(depth, `message ${name} {`)
      const outer = curScope
      curScope = fqn
      printScope(depth + 1, fqn, nestedOf(fqn, "messages"))
      for (const n of nestedOf(fqn, "enums")) printEnum(depth + 1, n)
      curScope = outer
      emit(depth, "}")
      return
    }
    comment(depth, messageComment(fqn, m))
    const vis = isPlainObject(m.options) ? m.options.visibility : undefined
    emit(depth, `${vis ? `${vis} ` : ""}message ${name} {`)
    messageBody(depth + 1, fqn, m)
    emit(depth, "}")
  }

  const printEnum = (depth: number, fqn: string) => {
    const e: ProtoApiEnum | undefined = ctx.doc.components?.enums?.[fqn]
    if (!e) return
    const name = lastSegment(fqn)
    comment(depth, elementComment(e, name))
    const vis = isPlainObject(e.options) ? e.options.visibility : undefined
    emit(depth, `${vis ? `${vis} ` : ""}enum ${name} {`)
    for (const line of optionAssignments(withDeprecated(e), "enum")) emit(depth + 1, `option ${line};`)
    printJsonFormat(depth + 1, e.jsonFormat, false)
    if (editions) {
      const inherited = (inheritedFeature("enum_type") as string | undefined) ?? "OPEN"
      const want = e.closed ? "CLOSED" : "OPEN"
      if (want !== inherited) emit(depth + 1, `option features.enum_type = ${want};`)
    }
    for (const [vn, v] of Object.entries(isPlainObject(e.values) ? e.values : {})) {
      const opts = optionAssignments(withDeprecated(v), "enumValue")
      comment(depth + 1, elementComment(v, undefined))
      emit(depth + 1, `${vn} = ${v.number}${opts.length ? ` [${opts.join(", ")}]` : ""};`)
    }
    printReserved(depth + 1, e.reserved, true)
    emit(depth, "}")
  }

  const printExtendBlock = (depth: number, scope: string, list: [string, ProtoApiExtension][]) => {
    const extendee = list[0][1].extendee ?? ""
    need(ctx.placement.get(extendee) ?? ctx.oracle.typeFile(extendee))
    const outer = curScope
    curScope = scope
    emit(
      depth,
      `extend ${ctx.names.has(extendee) ? shortestName(extendee, scope, ctx.names) : unresolvedName(extendee)} {`,
    )
    for (const [k, x] of list) {
      const n = lastSegment(k)
      const ext = { ...x, title: x.title === n ? undefined : x.title }
      printField(depth + 1, n, ext, false, undefined, true, groupOf(n, x, scope))
    }
    curScope = outer
    emit(depth, "}")
  }

  const printService = (fqn: string, s: ProtoApiService) => {
    curScope = fqn
    const name = lastSegment(fqn)
    comment(0, elementComment(s, name))
    emit(0, `service ${name} {`)
    for (const line of optionAssignments(withDeprecated(s), "service")) emit(1, `option ${line};`)
    for (const [mn, m] of Object.entries(isPlainObject(s.methods) ? s.methods : {}) as [string, ProtoApiMethod][]) {
      // the lifted method options back in the options tree: deprecated, idempotency_level, google.api.http
      const o = withDeprecated(m)
      if (m.idempotency) o.idempotency_level = m.idempotency
      if (isPlainObject(m.http)) o[HTTP] = httpRule(m.http)
      const body = optionAssignments(o, "method").map((line) => `option ${line};`)
      comment(1, elementComment(m, undefined))
      const ref = (x: ProtoApiMethod["request"] | undefined) =>
        typeof x?.schema?.$ref === "string" ? typeName(x.schema.$ref) : "google.protobuf.Empty"
      const req = `${m.request?.stream ? "stream " : ""}${ref(m.request)}`
      const res = `${m.response?.stream ? "stream " : ""}${ref(m.response)}`
      if (!body.length) emit(1, `rpc ${mn}(${req}) returns (${res});`)
      else {
        emit(1, `rpc ${mn}(${req}) returns (${res}) {`)
        for (const b of body) emit(2, b)
        emit(1, "}")
      }
    }
    emit(0, "}")
    curScope = file.package ?? ""
  }

  /** The whole file. */
  const render = (): string => {
    const doc = ctx.doc
    // declarations: top-level messages (and wrappers) with file-level extend blocks in order, enums, services
    const top = topLevel()
    printScope(0, file.package ?? "", top)
    for (const [fqn] of Object.entries(doc.components?.enums ?? {})) {
      if (ctx.placement.get(fqn) !== path || parentMessage(fqn) !== undefined) continue
      printEnum(0, fqn)
    }
    for (const [fqn, s] of Object.entries(doc.services ?? {})) {
      if (ctx.placement.get(fqn) !== path || !isPlainObject(s)) continue
      printService(fqn, s)
    }
    const body = lines.splice(0)
    // file options last (they may need imports too)
    const fileOpts = optionAssignments(file.options as Obj | undefined, "file")
    const header: string[] = []
    if (typeof file.description === "string" && file.description) {
      for (const l of file.description.split("\n")) header.push(l ? `// ${l}` : "//")
      header.push("")
    }
    header.push(syntax === "proto2" || syntax === "proto3" ? `syntax = "${syntax}";` : `edition = ${quote(syntax)};`)
    if (file.package) header.push(`package ${file.package};`)
    const imports = [...(file.imports ?? [])]
    for (const i of extraImports) if (i !== path && !imports.includes(i)) imports.push(i)
    if (imports.length) header.push("")
    for (const i of imports) {
      const flag = file.importFlags?.[i]
      header.push(`import ${flag ? `${flag} ` : ""}${quote(i)};`)
    }
    if (fileOpts.length) header.push("")
    for (const l of fileOpts) header.push(`option ${l};`)
    header.push("")
    // blank line between top-level declarations
    const out: string[] = []
    for (const l of body) {
      const prev = out[out.length - 1]
      const atTop = (x: string) => !!ctx.indent && !x.startsWith(ctx.indent)
      if (prev && l && atTop(l) && !l.startsWith("}") && atTop(prev) && prev.endsWith("}") && !prev.startsWith("//"))
        out.push("")
      out.push(l)
    }
    return `${[...header, ...out]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n+$/, "")}\n`
  }

  visible = visibleFiles()
  return { render }
}

/** Fully qualified names of every type and package the document (and the definitions) know. */
const symbolNames = (doc: ProtoApiDocument, oracle: Oracle, files: Record<string, ProtoApiFile>): Set<string> => {
  const out = new Set<string>()
  for (const k of Object.keys(doc.components?.messages ?? {})) out.add(k)
  for (const k of Object.keys(doc.components?.enums ?? {})) out.add(k)
  for (const k of Object.keys(doc.services ?? {})) out.add(k)
  for (const f of Object.values(files)) {
    const parts = (typeof f?.package === "string" ? f.package : "").split(".").filter(Boolean)
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("."))
  }
  for (const k of oracle.knownNames()) out.add(k)
  // packages implied by component keys
  for (const k of [...out]) {
    const parts = k.split(".")
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."))
  }
  return out
}

/** protoc's lookup over a set of names (first component innermost-out, remainder inside the match). */
const lookupName = (name: string, scope: string, names: Set<string>): string | undefined => {
  const dot = name.indexOf(".")
  const first = dot < 0 ? name : name.slice(0, dot)
  let current = scope
  while (true) {
    const candidate = qualify(current, first)
    if (names.has(candidate)) {
      const full = qualify(current, name)
      return names.has(full) ? full : undefined
    }
    if (!current) return undefined
    const i = current.lastIndexOf(".")
    current = i < 0 ? "" : current.slice(0, i)
  }
}

/** Shortest suffix of `fqn` that resolves back to `fqn` from `scope`; else the absolute `.fqn`. */
const shortestName = (fqn: string, scope: string, names: Set<string>): string => {
  const parts = fqn.split(".")
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts.slice(i).join(".")
    if (lookupName(candidate, scope, names) === fqn) return candidate
  }
  return `.${fqn}`
}

/** The google.api.HttpRule option tree of a normalised `http` keyword (D16, inverted). */
const httpRule = (h: ProtoApiHttpRule): Obj => {
  const m = `${h.method}`.toLowerCase()
  const t: Obj = ["get", "put", "post", "delete", "patch"].includes(m)
    ? { [m]: h.path }
    : { custom: { kind: h.method, path: h.path } }
  if (h.body) t.body = h.body
  if (h.responseBody) t.response_body = h.responseBody
  if (Array.isArray(h.additionalBindings)) t.additional_bindings = h.additionalBindings.map(httpRule)
  return t
}

/** An element's options with `deprecated = true` when it is deprecated (the built-in option the keyword lifts). */
const withDeprecated = (e: ProtoApiElement): Obj => ({
  ...(e.deprecation ? { deprecated: true } : {}),
  ...(isPlainObject(e.options) ? e.options : {}),
})

// ---- documents without `files` (decision 12) -------------------------------------------------------------------------

/**
 * Syntax of printed content without a `syntax` (decision 12): features -> 2023 (visibility -> 2024), proto2 constructs
 * (`required`, defaults, groups, extension ranges, closed enums, the proto2 resolved features) -> proto2, else proto3.
 * Read from the JSON text of the elements; keywords inside option values do not count.
 */
const inferSyntax = (doc: ProtoApiDocument, include: (key: string) => boolean): ProtoSyntax => {
  const parts: unknown[] = []
  for (const group of [doc.components?.messages, doc.components?.enums, doc.components?.extensions, doc.services])
    for (const [k, v] of Object.entries(group ?? {})) if (include(k)) parts.push(v)
  const all = JSON.stringify(parts)
  const own = JSON.stringify(parts, (k, v) => (k === "options" ? undefined : v))
  return /"visibility":/.test(all)
    ? "2024"
    : /"features":/.test(all)
      ? "2023"
      : /"presence":"required"|"default":[^{]|"delimited":true|"jsonFormat":"|"closed":true|"utf8Validation":false|"packed":false|"extensions":\[\[/.test(
            own,
          )
        ? "proto2"
        : "proto3"
}

/**
 * Placement of the components of a document without `files` (decision 12): types the bundle declares are imported, the
 * rest is printed in `fileName` with the longest common package prefix of the keys as the package; a document whose
 * keys lie in several packages gets one file per package (`<package path>/<fileName>` after the first).
 */
const placeWithoutFiles = (
  doc: ProtoApiDocument,
  fileName: string,
  bundle: Readonly<Record<string, string>>,
): { placement: Map<string, string>; files: Record<string, ProtoApiFile> } => {
  const placement = new Map<string, string>()
  const c = doc.components ?? {}
  const msgs = c.messages ?? {}
  const index = bundleIndex(bundle)
  const imports = new Set<string>()
  const byPackage = new Map<string, string[]>()
  for (const group of [c.messages, c.enums, c.extensions, doc.services])
    for (const key of Object.keys(group ?? {})) {
      const b = group === c.messages || group === c.enums ? index.get(key) : undefined
      if (b) {
        imports.add(b)
        placement.set(key, b)
        continue
      }
      // the package of a key: its parents that are messages (or look like ones) are not part of it
      let k = key
      while (parentScope(k) && (msgs[parentScope(k)] || /^[A-Z]/.test(lastSegment(parentScope(k))))) k = parentScope(k)
      const pkg = parentScope(k)
      byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), key])
    }
  const files: Record<string, ProtoApiFile> = {}
  const packages = byPackage.size ? [...byPackage.keys()] : [""]
  packages.forEach((pkg, i) => {
    const path = i ? `${pkg.split(".").join("/")}/${fileName}` : fileName
    for (const key of byPackage.get(pkg) ?? []) placement.set(key, path)
    files[path] = { ...(pkg ? { package: pkg } : {}), imports: [...imports] }
  })
  for (const [path, f] of Object.entries(files)) f.syntax = inferSyntax(doc, (k) => placement.get(k) === path)
  return { placement, files }
}

/** A printer whose option-value types come from the given bundle (`protoapi` injects the bundled definitions). */
export const createPrinter =
  (bundle: Readonly<Record<string, string>>) =>
  /** Print a document back to `.proto` files (path -> text); files marked `bundled` are not printed. */
  (doc: ProtoApiDocument, options: PrintOptions = {}): Record<string, string> => {
    if (!isPlainObject(doc) || !isPlainObject(options)) throw new TypeError("printProto: wrong argument types")
    return printWith(doc, options, bundle)
  }

const printWith = (
  doc: ProtoApiDocument,
  options: PrintOptions,
  bundle: Readonly<Record<string, string>>,
): Record<string, string> => {
  const indent = typeof options.indent === "string" ? options.indent : "  "
  const tag = tagSpelling(options.tags)
  const oracle = new Oracle(doc, bundle, isPlainObject(options.sources) ? options.sources : undefined)
  const fileName = typeof options.fileName === "string" && options.fileName ? options.fileName : "protoapi.proto"
  let placement = new Map<string, string>()
  let files: Record<string, ProtoApiFile>
  const docFiles = isPlainObject(doc.files) ? (doc.files as Record<string, ProtoApiFile>) : undefined
  if (docFiles && Object.keys(docFiles).length) {
    files = {}
    for (const [p, f] of Object.entries(docFiles)) files[p] = isPlainObject(f) ? f : {}
    const first = Object.keys(files).find((p) => !files[p].bundled) ?? Object.keys(files)[0]
    const place = (key: string, c: unknown) => {
      const file = isPlainObject(c) && typeof c.file === "string" && c.file in files ? c.file : first
      placement.set(key, file)
    }
    for (const k of ["messages", "enums", "extensions"] as const)
      for (const [key, c] of Object.entries(doc.components?.[k] ?? {})) place(key, c)
    for (const [key, s] of Object.entries(doc.services ?? {})) place(key, s)
  } else {
    const r = placeWithoutFiles(doc, fileName, bundle)
    placement = r.placement
    files = r.files
  }
  const ctx: PrintContext = {
    doc,
    oracle,
    indent,
    comments: !!tag,
    tag,
    names: symbolNames(doc, oracle, files),
    placement,
    files,
  }
  const out: Record<string, string> = {}
  // files marked `bundled` are not printed: a rebuild resolves them from the bundle (U3)
  for (const [path, f] of Object.entries(files)) if (!f.bundled) out[path] = createFilePrinter(ctx, path, f).render()
  return out
}
