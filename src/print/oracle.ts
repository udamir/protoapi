// The printer's type oracle: the types of option values (from the bundled option definitions, the caller's `sources` and the document), declaring files of types and options, and the document's type references.

import type { ProtoApiDocument, ProtoApiField, ProtoApiTypeRef, ProtoScalar } from "../types.ts"
import type { MField, MFile, MMessage } from "../model/index.ts"
import { SymbolTable } from "../symbols.ts"
import { linkAll } from "../resolve.ts"
import { OptionsContext } from "../lower/context.ts"
import { textToModel } from "../frontend/text/convert.ts"
import { isScalar } from "../values/scalars.ts"
import { normalizePath } from "../paths.ts"
import { getKey, hasKey, isPlainObject } from "../common/objects.ts"

export type FType =
  | { kind: "scalar"; scalar: ProtoScalar; repeated?: boolean }
  | { kind: "enum"; fqn?: string; repeated?: boolean }
  | { kind: "message"; fqn: string; repeated?: boolean; map?: { key: ProtoScalar; value: FType } }
  | { kind: "unknown"; repeated?: boolean }

/** Bundled files whose definitions type option values (descriptor.proto, features, WKTs, the conventions). */
const OPTION_FILES = /^(google\/(protobuf|api)|buf|validate|protoc-gen-openapiv2)\//

/** The option definitions of a bundle, parsed once per bundle object: in bundle order, and by bundle path. */
interface OptionModels {
  files: MFile[]
  byPath: Map<string, MFile>
}

const bundleModels = new WeakMap<object, OptionModels>()
const optionModels = (bundle: Readonly<Record<string, string>>): OptionModels => {
  const cached = bundleModels.get(bundle)
  if (cached) return cached
  const models: OptionModels = { files: [], byPath: new Map() }
  for (const [p, text] of Object.entries(bundle))
    if (OPTION_FILES.test(p)) {
      const f = textToModel(p, text, [], true)
      models.files.push(f)
      models.byPath.set(p, f)
    }
  bundleModels.set(bundle, models)
  return models
}
const bundleSymbols = new WeakMap<object, SymbolTable>()

/** Every bundled file's top-level declarations (fqn -> path), for documents without `files` (spec §6). The option files are already parsed by `optionModels` (linking does not change the names read here); the rest is parsed here. */
const bundleIndexes = new WeakMap<object, Map<string, string>>()
export const bundleIndex = (bundle: Readonly<Record<string, string>>): Map<string, string> => {
  let idx = bundleIndexes.get(bundle)
  if (idx) return idx
  idx = new Map()
  const parsed = optionModels(bundle).byPath
  for (const [p, text] of Object.entries(bundle)) {
    const f = parsed.get(p) ?? textToModel(p, text, [], true)
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
export const scalarOf = (t: unknown): ProtoScalar | undefined => {
  const type = isPlainObject(t) ? (t as { type?: unknown }).type : undefined
  return typeof type === "string" && isScalar(type) ? type : undefined
}

/** The component key a `$ref` points to. */
export const refFqn = (ref: string) => {
  const s = decodePointerKey(ref.replace(/^#\/components\/(messages|enums)\//, ""))
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export class Oracle {
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
      const texts = new Map<string, string>()
      const own = Object.entries(sources ?? {})
        .filter(([, text]) => typeof text === "string")
        .map(([p, text]) => {
          texts.set(normalizePath(p), text)
          return textToModel(normalizePath(p), text, [])
        })
      const paths = new Set(own.map((f) => f.path))
      const files = [...own, ...optionModels(bundle).files.filter((f) => !paths.has(f.path))]
      for (const f of files) if (!texts.has(f.path) && hasKey(bundle, f.path)) texts.set(f.path, bundle[f.path])
      this.symbols = new SymbolTable(files)
      // the edition defaults of the descriptor.proto in use (the caller's, if `sources` has one) decide the symbol visibility, as in a build
      const options = new OptionsContext(this.symbols, texts)
      linkAll(files, this.symbols, () => options.featureTable())
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
    const ext = getKey(this.doc.components?.extensions, key)
    if (ext && ext.extendee === fqn) return this.docType(ext)
    const msg = getKey(this.doc.components?.messages, fqn)
    const p = msg?.properties
    const pf = isPlainObject(p) ? getKey(p, key) : undefined
    if (pf) return this.docType(pf)
    return undefined
  }

  /** Whether key `key` of a value of message `fqn` (an `*Options` message or an option value type) names an extension: a dotted key, or the fqn of an extension of `fqn` declared outside a package that is not a field name of `fqn`. */
  isExtension(fqn: string, key: string): boolean {
    if (key.includes(".")) return true
    if (this.fieldDef(fqn, key)) return false
    const x = this.symbols.extensionByName.get(key)
    if (x && x.field.extendee?.resolved === fqn) return true
    return getKey(this.doc.components?.extensions, key)?.extendee === fqn
  }

  /** The model field `key` of message `fqn`, for oneof checks (definitions only). */
  fieldDef(fqn: string, key: string): MField | undefined {
    return this.symbols.message(fqn)?.fields.find((x) => x.name === key)
  }

  /** Whether message `fqn` is known, from the definitions or the document (an `Any` payload is printed typed then). */
  hasMessage(fqn: string): boolean {
    return !!(this.symbols.message(fqn) || getKey(this.doc.components?.messages, fqn))
  }

  /** Number of enum value `name` of enum `fqn`. */
  enumNumber(fqn: string | undefined, name: string): number | undefined {
    if (!fqn) return undefined
    const de = getKey(this.doc.components?.enums, fqn)
    const v = de?.values && isPlainObject(de.values) ? getKey(de.values, name) : undefined
    if (v && typeof v.number === "number") return v.number
    return this.symbols.enum(fqn)?.values.find((x) => x.name === name)?.number
  }

  /** Declaring file of an extension (option) key. */
  extensionFile(key: string): string | undefined {
    const ext = getKey(this.doc.components?.extensions, key)
    if (ext?.file) return ext.file
    return this.symbols.extensionByName.get(key)?.file.path
  }

  /** Declaring file of a message or enum. */
  typeFile(fqn: string): string | undefined {
    const c = getKey(this.doc.components?.messages, fqn) ?? getKey(this.doc.components?.enums, fqn)
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
