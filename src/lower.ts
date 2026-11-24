// Lowering (design §7): model -> ProtoApiDocument + source map + issues. Shared by both producers.

import type {
  BuildIssue,
  BuildOptions,
  ImportsMode,
  Location,
  ProtoApiDocument,
  ProtoApiEnum,
  ProtoApiExtension,
  ProtoApiField,
  ProtoApiFile,
  ProtoApiHttpRule,
  ProtoApiMessage,
  ProtoApiMethod,
  ProtoApiService,
  ProtoApiTypeRef,
  SourceMap,
} from "./types.ts"
import type {
  Locs,
  MComments,
  MEnum,
  MExtensionRange,
  MField,
  MFile,
  MMessage,
  MOneof,
  MOptionHolder,
  MService,
  MTypeRef,
  OptionTree,
  PendingIssue,
} from "./model.ts"
import type { SymbolTable } from "./symbols.ts"
import {
  type OptionsKind,
  OptionInterpreter,
  fromScalarText,
  INVALID,
  lastInvalidReason,
  type VType,
} from "./options.ts"
import { annotate } from "./annotate.ts"
import type { AnnotationInput, AnnotationResult, CommentLine, FieldShape, Slot, Target } from "./conventions/types.ts"
import { HTTP_RULE, OPENAPIV2_OPERATION, OPENAPIV2_SCHEMA } from "./conventions/keys.ts"
import { tagCollisions } from "./conventions/tags.ts"
import {
  BUNDLED_FEATURE_DEFAULTS,
  FeatureDefaults,
  type ResolvedFeatures,
  featureDefaultsSource,
  featuresOf,
  mergeFeatureDefaults,
  resolveFeatures,
} from "./features.ts"
import { normalizeComment } from "./comments.ts"
import { canonFloatOf, canonInt, INT_RANGE, toBase64 } from "./values/canonical.ts"
import { defaultJsonName } from "./values/json-name.ts"
import { parseFloatText, parseIntText, unescapeC } from "./values/literals.ts"
import { WRAPPERS } from "./values/scalars.ts"
import { ptr } from "./paths.ts"
import { isEditions } from "./common/editions.ts"
import {
  FIELD_NUMBER_MAX,
  IMPLEMENTATION_RESERVED_END,
  IMPLEMENTATION_RESERVED_START,
  MESSAGE_SET_NUMBER_MAX,
} from "./common/limits.ts"
import {
  enumPointer,
  extensionFqn,
  extensionPointer,
  filePointer,
  messagePointer,
  parentScope,
  servicePointer,
} from "./common/names.ts"
import { isPlainObject } from "./common/objects.ts"

export interface LowerInput {
  /** every file known to the build (user files and loaded bundle files) */
  files: MFile[]
  /** entry file paths in entry order */
  entry: string[]
  symbols: SymbolTable
  options: BuildOptions
  /** emission mode (`BuildOptions.imports`, the `includeImports` alias resolved) */
  imports: ImportsMode
  /** source text by file path (text producer) */
  sources: Map<string, string>
  issues: BuildIssue[]
}

export interface LowerOutput {
  document: ProtoApiDocument
  sourceMap: SourceMap
}

const FIELD_KEY_ORDER = [
  "title",
  "file",
  "description",
  "deprecation",
  "extendee",
  "number",
  "type",
  "$ref",
  "items",
  "additionalProperties",
  "propertyNames",
  "presence",
  "oneof",
  "jsonName",
  "default",
  "delimited",
  "packed",
  "utf8Validation",
  "required",
  "format",
  "readOnly",
  "writeOnly",
  "immutable",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "enum",
  "const",
  "examples",
  "options",
  "x-default",
  "x-annotation-conflicts",
]
const FIELD_RANK = new Map(FIELD_KEY_ORDER.map((k, i) => [k, i]))

const orderKeys = <T extends object>(o: T): T => {
  const src = o as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of FIELD_KEY_ORDER) if (src[k] !== undefined) out[k] = src[k]
  for (const k in src) if (!FIELD_RANK.has(k) && src[k] !== undefined) out[k] = src[k]
  return out as T
}

/** Sort and merge inclusive intervals (D8); adjacent intervals merge. */
export const mergeRanges = (ranges: [number, number][]): [number, number][] => {
  const sorted = ranges.map((r): [number, number] => [r[0], r[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push(r)
  }
  return out
}

/** Features written as resolved keywords (`packed`, `utf8Validation`, `jsonFormat`; decision F-3) and never kept under
 *  `options.features`, on any element. */
const RESOLVED_FEATURES = ["repeated_field_encoding", "utf8_validation", "json_format"]

/**
 * `options` without what the format writes as keywords: `packed` and the resolved features (F-3), plus `lifted`, the
 * lifted features declared on this element (`field_presence` / `message_encoding` on fields, `enum_type` on enums,
 * rule D). Always a new object.
 */
const withoutFeatureKeys = (options: OptionTree, lifted: string[] = []): OptionTree => {
  const out: OptionTree = { ...options }
  delete out.packed
  const fo = featuresOf(options)
  if (fo) {
    const rest = { ...fo }
    for (const k of [...RESOLVED_FEATURES, ...lifted]) delete rest[k]
    if (Object.keys(rest).length) out.features = rest
    else delete out.features
  }
  return out
}

/**
 * Location of a comment line of an element (validation L-3: keyword entries from comment tags point at the tag line),
 * computed from the element's span and its leading comment text alone, so that both producers give the same span:
 * the `//` lines of a leading comment end on the line above the element and start at its column. Block comments
 * (text without a final newline) and trailing comments give no entry.
 */
export const commentLineLoc = (
  element: Location | undefined,
  leading: string | undefined,
  line: CommentLine | undefined,
): Location | undefined => {
  if (!element || !leading || !line || line.trailing || !leading.endsWith("\n")) return undefined
  const want = line.text.trim()
  if (!want) return undefined
  const raw = leading.slice(0, -1).split("\n")
  const k = raw.findIndex((l) => l.trim().replace(/[ \t\v\f]+/g, " ") === want)
  if (k < 0) return undefined
  const lineNo = element.start.line - raw.length + k
  if (lineNo < 0) return undefined
  const column = element.start.column
  return {
    file: element.file,
    start: { line: lineNo, column },
    end: { line: lineNo, column: column + 2 + raw[k].length },
  }
}

/** The written range (index into `ranges`) that starts the merged interval `[a, b]`: the lowest start inside it. */
const rangeIn = (ranges: [number, number][], a: number, b: number): number => {
  let best = -1
  ranges.forEach(([x, y], i) => {
    if (x >= a && y <= b && (best < 0 || x < ranges[best][0])) best = i
  })
  return best
}

/** Edition defaults read from a FeatureSet definition; cached per (bundled, reused) model object. */
const definitionDefaults = new WeakMap<MMessage, FeatureDefaults>()

/** The title, description and deprecation the annotation layer gives an element, in that key order. */
const docKeywords = (out: Record<string, unknown>, a: AnnotationResult) => {
  if (a.title !== undefined) out.title = a.title
  if (a.description) out.description = a.description
  if (a.deprecation) out.deprecation = a.deprecation
}

export class Lowering {
  private readonly interpreted = new WeakSet<MOptionHolder>()
  private readonly sourceMap = new Map<string, Location>()
  private readonly useMap: boolean
  private readonly useFiles: boolean
  private readonly mode: NonNullable<BuildOptions["annotations"]>
  private readonly emittedMessages = new Set<string>()
  private readonly emittedEnums = new Set<string>()
  private readonly orderedFiles: MFile[] = []
  private readonly entry: Set<string>
  private featureDefaults?: FeatureDefaults

  private readonly input: LowerInput

  constructor(input: LowerInput) {
    this.input = input
    this.entry = new Set(input.entry)
    this.useMap = input.options.sourceMap !== false
    this.useFiles = input.options.files !== false
    this.mode = input.options.annotations ?? "all"
    // A-14: a tag rename that takes another tag's name
    if (this.mode === "all")
      for (const message of tagCollisions(input.options.tags)) input.issues.push({ code: "invalid-tag", message })
  }

  // ---- helpers --------------------------------------------------------------------------------------------------

  /** The typed options of `holder`, interpreted once per build (`scope`: where option names are looked up from). */
  opts(holder: MOptionHolder, kind: OptionsKind, file: MFile, scope: string): OptionTree {
    if (!this.interpreted.has(holder)) {
      this.interpreted.add(holder)
      if (!holder.raw.length) {
        holder.options = {}
        return holder.options
      }
      new OptionInterpreter(
        { symbols: this.input.symbols, file, scope, source: this.input.sources.get(file.path) },
        holder,
      ).run(kind, file.syntax)
    }
    return holder.options
  }

  /**
   * Edition defaults (F-4): the `edition_defaults` of `google.protobuf.FeatureSet` in the descriptor.proto of this
   * build (a user-supplied one wins over the bundle, design §5.2); features it does not define, or a build without a
   * descriptor.proto (protoapi/core), use the bundled descriptor.proto's defaults.
   */
  defaults(syntax: MFile["syntax"]): ResolvedFeatures {
    if (!this.featureDefaults) {
      const fs = this.input.symbols.message("google.protobuf.FeatureSet")
      let table = fs ? definitionDefaults.get(fs) : BUNDLED_FEATURE_DEFAULTS
      if (!table && fs) {
        const editions = this.input.symbols.enum("google.protobuf.Edition")
        const own = featureDefaultsSource(
          fs.fields.map((f) => ({
            name: f.name,
            editionDefaults: this.opts(f, "field", fs.file, fs.fqn).edition_defaults,
          })),
          (editions?.values ?? []).map((v) => ({ name: v.name, number: v.number })),
        )
        table = new FeatureDefaults(mergeFeatureDefaults(BUNDLED_FEATURE_DEFAULTS.source, own))
        definitionDefaults.set(fs, table)
      }
      this.featureDefaults = table ?? BUNDLED_FEATURE_DEFAULTS
    }
    return this.featureDefaults.forSyntax(syntax)
  }

  private map(pointer: string, loc: Location | undefined) {
    if (this.useMap && loc && !this.sourceMap.has(pointer)) this.sourceMap.set(pointer, loc)
  }

  private mapLocs(pointer: string, locs: Locs, keys: Record<string, string>) {
    if (!this.useMap) return
    this.map(pointer, locs[""])
    for (const sub in keys) {
      const loc = locs[keys[sub]]
      if (loc) this.map(`${pointer}/${sub}`, loc)
    }
  }

  private mapOptions(pointer: string, holder: MOptionHolder, written: object | undefined) {
    if (!this.useMap || !written) return
    for (const key of Object.keys(written)) {
      const loc = holder.optionLocs[key]
      if (loc) this.map(`${pointer}/options/${ptr(key)}`, loc)
    }
  }

  /**
   * Keyword-level entries of the annotation layer (validation L-3): a keyword lifted from an option points at the
   * option statement, one from a comment tag or an AIP prefix at the comment line; `deprecation` likewise.
   */
  private mapAnnotations(
    pointer: string,
    holder: MOptionHolder & { locs: Locs; comments: MComments },
    ann: AnnotationResult,
    outer: MOptionHolder = holder,
  ) {
    if (!this.useMap) return
    const line = (c: CommentLine | undefined) => commentLineLoc(holder.locs[""], holder.comments.leading, c)
    for (const o of ann.origins) {
      const base = o.target ? `${pointer}/${o.target}` : pointer
      // `json_schema.required` of the message (S1): the message's option statement
      const at = o.option === OPENAPIV2_SCHEMA ? outer : holder
      this.map(`${base}/${ptr(o.keyword)}`, o.option ? at.optionLocs[o.option] : line(o.comment))
    }
    const d = ann.deprecationOrigin
    if (ann.deprecation && d)
      this.map(
        `${pointer}/deprecation`,
        d.source === "option"
          ? holder.optionLocs.deprecated
          : d.source === "openapiv2"
            ? holder.optionLocs[OPENAPIV2_OPERATION]
            : line(d.comment),
      )
  }

  /** Reserved numbers and names, one entry per document index (validation L-2): the written range that starts the
   *  merged interval, the first occurrence of the name. */
  private mapReserved(
    pointer: string,
    el: { reservedRanges: [number, number][]; reservedNames: string[]; reservedLocs?: MMessage["reservedLocs"] },
    numbers: [number, number][],
    names: string[],
  ) {
    if (!this.useMap || !el.reservedLocs) return
    numbers.forEach(([a, b], i) =>
      this.map(`${pointer}/reserved/numbers/${i}`, el.reservedLocs?.ranges[rangeIn(el.reservedRanges, a, b)]),
    )
    names.forEach((n, i) =>
      this.map(`${pointer}/reserved/names/${i}`, el.reservedLocs?.names[el.reservedNames.indexOf(n)]),
    )
  }

  private flush(holder: { pending?: PendingIssue[] }, pointer: string, file: MFile, fallback?: Location) {
    for (const p of holder.pending ?? []) {
      this.input.issues.push({
        code: p.code,
        message: p.message,
        file: file.path,
        location: p.loc ?? fallback,
        pointer: p.sub ? `${pointer}/${p.sub.split("/").map(ptr).join("/")}` : pointer,
      })
    }
    holder.pending = undefined
  }

  private issue(code: BuildIssue["code"], message: string, file: MFile, pointer: string, location?: Location) {
    this.input.issues.push({ code, message, file: file.path, pointer, location })
  }

  /** The common keys of a declaration: `title`, `file`, then `description` and `deprecation` (§7 key order). */
  private head(name: string, file: MFile, ann: AnnotationResult): Record<string, unknown> {
    const out: Record<string, unknown> = { title: name }
    if (this.useFiles) out.file = file.path
    docKeywords(out, ann)
    return out
  }

  private refOf(t: MTypeRef): string {
    if (t.kind === "named") {
      if (t.resolved) return t.resolved.kind === "enum" ? enumPointer(t.resolved.fqn) : messagePointer(t.resolved.fqn)
      const key = t.unresolvedKey ?? t.name.replace(/^\./, "")
      return t.hint === "enum" ? enumPointer(key) : messagePointer(key)
    }
    return ""
  }

  private typeRef(t: MTypeRef): ProtoApiTypeRef {
    if (t.kind === "scalar") return { type: t.scalar }
    return { $ref: this.refOf(t) }
  }

  private slot(t: MTypeRef): Slot {
    if (t.kind === "scalar") return { scalar: t.scalar }
    if (t.resolved?.kind === "enum") return { enumDef: this.input.symbols.enum(t.resolved.fqn) }
    const fqn = t.resolved?.fqn
    // A-11: wrapper well-known types take the tags and rules of their scalar
    if (fqn && fqn in WRAPPERS) return { scalar: WRAPPERS[fqn], wrapper: fqn }
    return { message: true, messageFqn: fqn }
  }

  /** The issues of an annotation result: invalid tags, convention options that do not fit, conflicts (A-15). */
  /** The end of an element's lowering: conflicts, annotation issues, its source map entries, its pending issues. */
  private finish(
    out: Record<string, unknown>,
    ann: AnnotationResult,
    what: string,
    file: MFile,
    pointer: string,
    el: MOptionHolder & { locs: Locs; comments: MComments },
    keys: Record<string, string> = {},
  ) {
    if (ann.conflicts.length) out["x-annotation-conflicts"] = ann.conflicts
    this.annotationIssues(ann, what, file, pointer, el)
    this.mapLocs(pointer, el.locs, keys)
    if (out.deprecation) this.map(`${pointer}/deprecation`, el.optionLocs.deprecated)
    this.mapAnnotations(pointer, el, ann)
    this.mapOptions(pointer, el, out.options as object | undefined)
    this.flush(el, pointer, file, el.locs[""])
  }

  private annotationIssues(
    ann: AnnotationResult,
    what: string,
    file: MFile,
    pointer: string,
    holder: MOptionHolder & { locs: Locs },
  ) {
    for (const t of ann.invalidTags)
      this.issue("invalid-tag", `invalid comment tag ${t} (${what})`, file, pointer, holder.locs[""])
    for (const o of ann.invalidOptions)
      this.issue(
        "invalid-option",
        `${o.message} (${what})`,
        file,
        `${pointer}/options/${ptr(o.key)}`,
        holder.optionLocs[o.key] ?? holder.locs[""],
      )
    ann.conflicts.forEach((c, i) =>
      this.issue(
        "annotation-conflict",
        `${what}: ${c.keyword} from ${c.kept.source} (${JSON.stringify(c.kept.value)}) is kept, ${c.dropped.source} (${JSON.stringify(c.dropped.value)}) is dropped`,
        file,
        `${pointer}/x-annotation-conflicts/${i}`,
        holder.locs[""],
      ),
    )
  }

  // ---- emission set ---------------------------------------------------------------------------------------------

  private orderFiles() {
    const byPath = this.input.symbols.files
    const visited = new Set<string>()
    const visit = (path: string) => {
      if (visited.has(path)) return
      visited.add(path)
      const f = byPath.get(path)
      if (!f) return
      for (const imp of f.imports) visit(imp.path)
      this.orderedFiles.push(f)
    }
    for (const e of [...this.input.entry].sort()) visit(e)
  }

  /** The file's declarations are emitted in full (`BuildOptions.imports`): entries, user files in "user", all in "all". */
  private full(file: MFile): boolean {
    const mode = this.input.imports
    return mode === "all" || this.entry.has(file.path) || (mode === "user" && !file.bundled)
  }

  private computeEmission() {
    const queue: string[] = []
    const addMsg = (m: MMessage) => {
      if (m.mapEntry || this.emittedMessages.has(m.fqn)) return
      this.emittedMessages.add(m.fqn)
      queue.push(m.fqn)
    }
    const addRef = (t: MTypeRef | undefined) => {
      if (t?.kind !== "named" || !t.resolved) return
      if (t.resolved.kind === "enum") this.emittedEnums.add(t.resolved.fqn)
      else {
        const m = this.input.symbols.message(t.resolved.fqn)
        if (m) addMsg(m)
      }
    }
    const fieldRefs = (f: MField) => {
      addRef(f.type)
      addRef(f.map?.value)
    }
    const walk = (m: MMessage) => {
      addMsg(m)
      for (const n of m.nested) walk(n)
      for (const e of m.enums) this.emittedEnums.add(e.fqn)
      for (const x of m.extensions) fieldRefs(x)
    }
    for (const f of this.orderedFiles) {
      if (!this.full(f)) continue
      for (const m of f.messages) walk(m)
      for (const e of f.enums) this.emittedEnums.add(e.fqn)
      for (const x of f.extensions) fieldRefs(x)
      for (const s of f.services) {
        for (const m of s.methods) {
          addRef(m.input)
          addRef(m.output)
        }
      }
    }
    while (queue.length) {
      const m = this.input.symbols.message(queue.pop() as string)
      if (!m) continue
      for (const f of m.fields) fieldRefs(f)
    }
  }

  // ---- fields ---------------------------------------------------------------------------------------------------

  /** A descriptor `default_value` that cannot be parsed for the field's type is an `invalid-option`, dropped (desc#13). */
  private descriptorDefault(t: VType, s: string): string | number | boolean | typeof INVALID {
    if (t.kind === "enum") return t.def && !t.def.values.some((v) => v.name === s) ? INVALID : s
    if (t.kind !== "scalar") return s
    switch (t.scalar) {
      case "string":
        return s
      case "bytes":
        return toBase64(unescapeC(s))
      case "bool":
        return s === "true" ? true : s === "false" ? false : INVALID
      case "float":
      case "double": {
        const v = parseFloatText(s)
        return v === undefined ? INVALID : canonFloatOf(v, t.scalar)
      }
      default: {
        const v = parseIntText(s)
        if (v === undefined) return INVALID
        const [lo, hi] = INT_RANGE[t.scalar] ?? [v, v]
        return v < lo || v > hi ? INVALID : canonInt(v, t.scalar)
      }
    }
  }

  private canonicalDefault(f: MField, file: MFile, pointer: string): string | number | boolean | undefined {
    const d = f.default
    if (!d) return undefined
    const t: VType =
      f.type.kind === "scalar"
        ? { kind: "scalar", scalar: f.type.scalar }
        : f.type.resolved?.kind === "enum"
          ? { kind: "enum", def: this.input.symbols.enum(f.type.resolved.fqn) }
          : { kind: "unknown" }
    if (d.kind === "text") {
      const c = d.value as unknown as { type: string; start: number; end: number }
      const src = this.input.sources.get(this.currentFile?.path ?? "") ?? ""
      const text = src.slice(c.start, c.end).trim()
      const v = fromScalarText(text, c.type === "str-lit", t, true)
      if (v === INVALID) {
        // a message or unresolved field type is reported elsewhere (default not allowed / unresolved-type)
        if (t.kind === "scalar" || t.kind === "enum")
          this.issue(
            "invalid-option",
            `default value ${text} is not valid for field ${f.name}: ${lastInvalidReason()}; it is dropped`,
            file,
            pointer,
            f.locs.default ?? f.locs[""],
          )
        return undefined
      }
      return v as string | number | boolean
    }
    const v = this.descriptorDefault(t, d.value)
    if (v !== INVALID) return v
    this.issue(
      "invalid-option",
      `default value ${JSON.stringify(d.value)} is not valid for field ${f.name} (${
        t.kind === "scalar" ? t.scalar : t.kind === "enum" ? (t.def?.fqn ?? "enum") : "message"
      }); it is dropped`,
      file,
      pointer,
      f.locs.default ?? f.locs[""],
    )
    return undefined
  }

  private currentFile?: MFile

  /** protoc's field option checks that do not stop the build (invalid-option issues). */
  private checkFieldOptions(
    f: MField,
    file: MFile,
    options: OptionTree,
    features: ResolvedFeatures,
    isMessage: boolean,
    extension: boolean,
    pointer: string,
  ) {
    const loc = (key: string) => f.optionLocs[key] ?? f.locs[""]
    if (options.packed !== undefined || f.optionLocs.packed !== undefined) {
      const t = f.type
      const packable =
        f.repeated &&
        !f.map &&
        (t.kind === "scalar" ? t.scalar !== "string" && t.scalar !== "bytes" : t.resolved?.kind === "enum")
      if (!packable)
        this.issue(
          "invalid-option",
          `[packed] applies only to repeated numeric and enum fields (${f.name})`,
          file,
          pointer,
          loc("packed"),
        )
    }
    const own = featuresOf(options)?.field_presence
    if (own !== undefined && (f.repeated || f.map || f.oneof || extension || (isMessage && own === "IMPLICIT")))
      this.issue(
        "invalid-option",
        `features.field_presence cannot be set on field ${f.name}`,
        file,
        pointer,
        loc("features"),
      )
    if (f.default !== undefined) {
      const implicit =
        file.syntax === "proto3" || (isEditions(file.syntax) && features.field_presence === "IMPLICIT" && !f.oneof)
      if (implicit || f.repeated || f.map || isMessage)
        this.issue(
          "invalid-option",
          `a default value is not allowed on field ${f.name}`,
          file,
          pointer,
          f.locs.default ?? f.locs[""],
        )
    }
  }

  private lowerField(
    f: MField,
    file: MFile,
    chain: OptionTree[],
    scope: string,
    pointer: string,
    oneof: MOneof | undefined,
    extension: boolean,
    schema?: MOptionHolder,
  ): ProtoApiField {
    const options = { ...this.opts(f, "field", file, scope) }
    const oneofOpts = oneof ? this.opts(oneof, "oneof", file, parentScope(scope)) : undefined
    const features: ResolvedFeatures = resolveFeatures(this.defaults(file.syntax), file.syntax, [
      ...chain,
      oneofOpts,
      options,
    ])
    const out: Record<string, unknown> = { number: f.number }
    const isMessage =
      f.type.kind === "named" && (f.type.resolved?.kind === "message" || (!f.type.resolved && f.type.hint !== "enum"))
    let shape: FieldShape
    if (f.map) {
      out.type = "object"
      out.additionalProperties = this.typeRef(f.map.value)
      out.propertyNames = { type: f.map.key }
      shape = { self: { message: true }, map: { key: { scalar: f.map.key }, value: this.slot(f.map.value) } }
    } else if (f.repeated) {
      out.type = "array"
      out.items = this.typeRef(f.type)
      shape = { self: { message: true }, repeated: this.slot(f.type) }
    } else {
      Object.assign(out, this.typeRef(f.type))
      shape = { self: this.slot(f.type) }
    }
    // presence (rule P)
    const singular = !f.repeated && !f.map
    if (singular) {
      // a file- or message-level LEGACY_REQUIRED does not reach oneof members or extensions (they cannot be required)
      if (f.required || (features.field_presence === "LEGACY_REQUIRED" && !extension && !f.oneof))
        out.presence = "required"
      else if (!f.oneof && !isMessage && !f.group) {
        const explicit =
          extension ||
          (file.syntax === "proto2"
            ? true
            : file.syntax === "proto3"
              ? f.optional
              : features.field_presence === "EXPLICIT")
        if (explicit) out.presence = "explicit"
      }
    }
    if (f.oneof) out.oneof = f.oneof
    if (!extension && f.jsonName !== undefined && f.jsonName !== defaultJsonName(f.name)) out.jsonName = f.jsonName
    const def = this.canonicalDefault(f, file, pointer)
    if (def !== undefined) out.default = def
    this.checkFieldOptions(f, file, options, features, isMessage, extension, pointer)
    if (!f.map && (f.group || (isMessage && features.message_encoding === "DELIMITED"))) out.delimited = true
    // F-3: resolved features against the fixed modern baseline (proto3 / editions defaults are not written)
    const t = f.type
    const packable =
      f.repeated &&
      !f.map &&
      (t.kind === "scalar" ? t.scalar !== "string" && t.scalar !== "bytes" : t.resolved?.kind === "enum")
    const encoding =
      typeof options.packed === "boolean" ? (options.packed ? "PACKED" : "EXPANDED") : features.repeated_field_encoding
    if (packable && encoding === "EXPANDED") out.packed = false
    if (features.utf8_validation === "NONE") {
      const isString = (r: MTypeRef | undefined) => r?.kind === "scalar" && r.scalar === "string"
      if (f.map) {
        if (f.map.key === "string") (out.propertyNames as Record<string, unknown>).utf8Validation = false
        if (isString(f.map.value)) (out.additionalProperties as Record<string, unknown>).utf8Validation = false
      } else if (isString(t)) {
        if (f.repeated) (out.items as Record<string, unknown>).utf8Validation = false
        else out.utf8Validation = false
      }
    }
    const ann = this.annotate(
      // lifted features leave the field's own options; packed and the resolved features are keywords
      "field",
      f,
      withoutFeatureKeys(options, ["field_presence", "message_encoding"]),
      { shape, extra: schema && [{ keyword: "required", value: true, source: "openapiv2", option: OPENAPIV2_SCHEMA }] },
    )
    docKeywords(out, ann)
    Object.assign(out, ann.keywords[""])
    for (const target of ["items", "additionalProperties", "propertyNames"] as Target[]) {
      const kw = ann.keywords[target]
      if (Object.keys(kw).length && isPlainObject(out[target]))
        out[target] = orderKeys({ ...(out[target] as object), ...kw })
    }
    if (Object.keys(ann.options).length) out.options = ann.options
    if (ann.xDefault !== undefined) out["x-default"] = ann.xDefault
    if (ann.conflicts.length) out["x-annotation-conflicts"] = ann.conflicts
    this.annotationIssues(ann, `${extension ? "extension" : "field"} ${f.name}`, file, pointer, f)
    // checks
    if (
      f.number < 1 ||
      f.number > FIELD_NUMBER_MAX ||
      (f.number >= IMPLEMENTATION_RESERVED_START && f.number <= IMPLEMENTATION_RESERVED_END)
    )
      this.issue(
        "invalid-number",
        `field number ${f.number} is not allowed`,
        file,
        pointer,
        f.locs.number ?? f.locs[""],
      )
    // source map
    this.mapLocs(pointer, f.locs, {
      number: "number",
      type: "type",
      jsonName: "jsonName",
      default: "default",
      extendee: "extendee",
      ...(out.presence ? { presence: f.locs.label ? "label" : "" } : {}),
    })
    if (out.deprecation) this.map(`${pointer}/deprecation`, f.optionLocs.deprecated)
    this.mapAnnotations(pointer, f, ann, schema)
    if (this.useMap) {
      // resolved keywords (F-3): the option that sets them on the field itself, when there is one
      const own = featuresOf(options)
      if (out.packed === false)
        this.map(
          `${pointer}/packed`,
          typeof options.packed === "boolean"
            ? f.optionLocs.packed
            : own?.repeated_field_encoding !== undefined
              ? f.optionLocs.features
              : undefined,
        )
      if (own?.utf8_validation !== undefined)
        for (const at of ["", "/items", "/propertyNames", "/additionalProperties"]) {
          const node = at ? (out[at.slice(1)] as Record<string, unknown> | undefined) : out
          if (node?.utf8Validation === false) this.map(`${pointer}${at}/utf8Validation`, f.optionLocs.features)
        }
    }
    this.mapOptions(pointer, f, out.options as object | undefined)
    this.flush(f, pointer, file, f.locs[""])
    return orderKeys(out) as unknown as ProtoApiField
  }

  // ---- messages --------------------------------------------------------------------------------------------------

  /** The annotation layer for an element: its comments and options in the build's mode and tags. */
  private annotate(
    kind: AnnotationInput["kind"],
    el: { comments: { leading?: string; trailing?: string } },
    options: OptionTree,
    more?: Partial<AnnotationInput>,
  ): AnnotationResult {
    return annotate({
      kind,
      leading: el.comments.leading,
      trailing: el.comments.trailing,
      options,
      mode: this.mode,
      tags: this.input.options.tags,
      ...more,
    })
  }

  private lowerMessage(m: MMessage, chain: OptionTree[]): ProtoApiMessage {
    const file = m.file
    this.currentFile = file
    const pointer = messagePointer(m.fqn)
    const options = { ...this.opts(m, "message", file, parentScope(m.fqn)) }
    const inner = [...chain, options]
    const features = resolveFeatures(this.defaults(file.syntax), file.syntax, inner)
    // the message's own annotations first: openapiv2_schema.json_schema.required names fields (A-13)
    const byName = new Map<string, string>()
    for (const f of m.fields) byName.set(f.name, f.name)
    for (const f of m.fields) {
      const json = f.jsonName ?? defaultJsonName(f.name)
      if (!byName.has(json)) byName.set(json, f.name)
    }
    const ann = this.annotate("message", m, withoutFeatureKeys(options), { fieldOf: (name) => byName.get(name) })
    const schemaRequired = new Set(ann.requiredFields ?? [])
    const properties: Record<string, ProtoApiField> = {}
    const seenNumbers = new Map<number, string>()
    const reserved = mergeRanges(m.reservedRanges)
    const reservedNames = [...new Set(m.reservedNames)].sort()
    for (const f of m.fields) {
      const fp = `${pointer}/properties/${ptr(f.name)}`
      if (f.name in properties) {
        this.issue("duplicate-name", `field name ${f.name} is used more than once in ${m.fqn}`, file, fp, f.locs[""])
        continue
      }
      const oneof = f.oneof ? m.oneofs.find((o) => o.name === f.oneof) : undefined
      properties[f.name] = this.lowerField(
        f,
        file,
        inner,
        m.fqn,
        fp,
        oneof,
        false,
        schemaRequired.has(f.name) ? m : undefined,
      )
      if (seenNumbers.has(f.number))
        this.issue(
          "duplicate-number",
          `field number ${f.number} is used by ${seenNumbers.get(f.number)} and ${f.name}`,
          file,
          fp,
          f.locs.number ?? f.locs[""],
        )
      else seenNumbers.set(f.number, f.name)
      if (reserved.some(([a, b]) => f.number >= a && f.number <= b) || reservedNames.includes(f.name))
        this.issue(
          "reserved-conflict",
          `field ${f.name} = ${f.number} uses a reserved number or name`,
          file,
          fp,
          f.locs[""],
        )
    }
    const out = this.head(m.name, file, ann)
    out.type = "object"
    out.properties = properties
    if (m.oneofs.length) {
      const oneofs: Record<string, Record<string, unknown>> = {}
      for (const o of m.oneofs) {
        const op = `${pointer}/oneofs/${ptr(o.name)}`
        const oo = this.opts(o, "oneof", file, parentScope(m.fqn))
        const oa = this.annotate("oneof", o, withoutFeatureKeys(oo))
        const entry: Record<string, unknown> = {}
        // A-4: a `@Deprecated` tag or `Deprecated:` line on a oneof (OneofOptions has no `deprecated`)
        docKeywords(entry, oa)
        if (Object.keys(oa.options).length) entry.options = oa.options
        if (oa.conflicts.length) entry["x-annotation-conflicts"] = oa.conflicts
        oneofs[o.name] = entry
        this.annotationIssues(oa, `oneof ${o.name}`, file, op, o)
        this.map(op, o.locs[""])
        this.mapAnnotations(op, o, oa)
        this.mapOptions(op, o, entry.options as object | undefined)
        this.flush(o, op, file, o.locs[""])
      }
      out.oneofs = oneofs
    }
    if (reserved.length || reservedNames.length) {
      const r: Record<string, unknown> = {}
      if (reserved.length) r.numbers = reserved
      if (reservedNames.length) r.names = reservedNames
      out.reserved = r
      this.map(`${pointer}/reserved`, m.locs.reserved ?? m.locs.reservedNames)
      this.mapReserved(pointer, m, reserved, reservedNames)
    }
    // extension ranges: ranges carrying declarations are kept apart; other range options -> extensionOptions (F-1)
    const plain: [number, number][] = []
    const declarations: Record<string, unknown> = {}
    const rangeOptions: { range: [number, number]; options: OptionTree; holder: MExtensionRange }[] = []
    const rangesWithout: MExtensionRange[] = []
    const messageSet = options.message_set_wire_format === true
    for (const r of m.extensionRanges) {
      // protoc: `max` in a message set is 2147483646 instead of 536870911
      if (r.toMax && messageSet) r.end = MESSAGE_SET_NUMBER_MAX
      const ro = this.opts(r, "extensionRange", file, parentScope(m.fqn))
      if (ro.declaration !== undefined) declarations[`${r.start}-${r.end}`] = ro.declaration
      const other = withoutFeatureKeys(ro)
      delete other.declaration
      if (Object.keys(other).length) rangeOptions.push({ range: [r.start, r.end], options: other, holder: r })
      else rangesWithout.push(r)
      plain.push([r.start, r.end])
    }
    if (plain.length) {
      const declared = new Set(Object.keys(declarations))
      const merged = mergeRanges(plain.filter(([a, b]) => !declared.has(`${a}-${b}`)))
      const kept = plain.filter(([a, b]) => declared.has(`${a}-${b}`))
      out.extensions = [...merged, ...kept].sort((a, b) => a[0] - b[0])
      this.map(`${pointer}/extensions`, m.locs.extensions)
      if (this.useMap) {
        // one entry per interval (validation L-2): the written range that starts it
        const written = m.extensionRanges.map((r): [number, number] => [r.start, r.end])
        ;(out.extensions as [number, number][]).forEach(([a, b], i) =>
          this.map(`${pointer}/extensions/${i}`, m.extensionRanges[rangeIn(written, a, b)]?.rangeLoc),
        )
      }
    }
    rangeOptions.sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1])
    if (rangeOptions.length) out.extensionOptions = rangeOptions.map((e) => ({ range: e.range, options: e.options }))
    rangeOptions.forEach((e, i) => {
      // the statement of the range and its option statements (validation L-2)
      this.map(`${pointer}/extensionOptions/${i}`, e.holder.loc)
      this.mapOptions(`${pointer}/extensionOptions/${i}`, e.holder, e.options)
    })
    rangeOptions.forEach((e, i) => this.flush(e.holder, `${pointer}/extensionOptions/${i}`, file, e.holder.loc))
    for (const r of rangesWithout) this.flush(r, `${pointer}/extensions`, file, r.loc)
    if (features.json_format && features.json_format !== "ALLOW") {
      out.jsonFormat = features.json_format
      if (featuresOf(options)?.json_format !== undefined) this.map(`${pointer}/jsonFormat`, m.optionLocs.features)
    }
    const restOptions: Record<string, unknown> = { ...ann.options }
    if (Object.keys(declarations).length) restOptions.extension_declarations = declarations
    if (m.visibility) restOptions.visibility = m.visibility
    if (Object.keys(restOptions).length) out.options = restOptions
    this.finish(out, ann, `message ${m.fqn}`, file, pointer, m)
    return out as unknown as ProtoApiMessage
  }

  // ---- enums ------------------------------------------------------------------------------------------------------

  private lowerEnum(e: MEnum, chain: OptionTree[]): ProtoApiEnum {
    const file = e.file
    const pointer = enumPointer(e.fqn)
    const scope = parentScope(e.fqn)
    const options = { ...this.opts(e, "enum", file, scope) }
    const features = resolveFeatures(this.defaults(file.syntax), file.syntax, [...chain, options])
    const ann = this.annotate("enum", e, withoutFeatureKeys(options, ["enum_type"]))
    const out = this.head(e.name, file, ann)
    out.type = "string"
    const values: Record<string, unknown> = {}
    for (const v of e.values) {
      const vp = `${pointer}/values/${ptr(v.name)}`
      if (v.name in values) {
        this.issue("duplicate-name", `enum value ${v.name} is used more than once in ${e.fqn}`, file, vp, v.locs[""])
        continue
      }
      const vo = this.opts(v, "enumValue", file, scope)
      const va = this.annotate("enumValue", v, withoutFeatureKeys(vo))
      const entry: Record<string, unknown> = {}
      docKeywords(entry, va)
      entry.number = v.number
      if (Object.keys(va.options).length) entry.options = va.options
      values[v.name] = entry
      this.finish(entry, va, `enum value ${v.name}`, file, vp, v, { number: "number" })
    }
    out.values = values
    const reserved = mergeRanges(e.reservedRanges)
    const reservedNames = [...new Set(e.reservedNames)].sort()
    if (reserved.length || reservedNames.length) {
      const r: Record<string, unknown> = {}
      if (reserved.length) r.numbers = reserved
      if (reservedNames.length) r.names = reservedNames
      out.reserved = r
      this.map(`${pointer}/reserved`, e.locs.reserved ?? e.locs.reservedNames)
      this.mapReserved(pointer, e, reserved, reservedNames)
    }
    if (features.enum_type === "CLOSED") out.closed = true
    if (features.json_format && features.json_format !== "ALLOW") {
      out.jsonFormat = features.json_format
      if (featuresOf(options)?.json_format !== undefined) this.map(`${pointer}/jsonFormat`, e.optionLocs.features)
    }
    const restOptions: Record<string, unknown> = { ...ann.options }
    if (e.visibility) restOptions.visibility = e.visibility
    if (Object.keys(restOptions).length) out.options = restOptions
    this.finish(out, ann, `enum ${e.fqn}`, file, pointer, e)
    return out as unknown as ProtoApiEnum
  }

  // ---- services -----------------------------------------------------------------------------------------------------

  private lowerService(s: MService): ProtoApiService {
    const file = s.file
    const pointer = servicePointer(s.fqn)
    const options = withoutFeatureKeys(this.opts(s, "service", file, s.fqn))
    const ann = this.annotate("service", s, options)
    const out = this.head(s.name, file, ann)
    const methods: Record<string, ProtoApiMethod> = {}
    for (const m of s.methods) {
      const mp = `${pointer}/methods/${ptr(m.name)}`
      if (m.name in methods) {
        this.issue("duplicate-name", `method ${m.name} is declared more than once in ${s.fqn}`, file, mp, m.locs[""])
        continue
      }
      const mo = withoutFeatureKeys(this.opts(m, "method", file, s.fqn))
      const entry: Record<string, unknown> = {}
      let idempotency: unknown
      let http: ProtoApiHttpRule | undefined
      if (typeof mo.idempotency_level === "string") {
        idempotency = mo.idempotency_level
        delete mo.idempotency_level
      }
      if (isPlainObject(mo[HTTP_RULE])) {
        http = normalizeHttp(mo[HTTP_RULE])
        delete mo[HTTP_RULE]
      }
      const ma = this.annotate("method", m, mo)
      docKeywords(entry, ma)
      entry.request = { schema: { $ref: this.refOf(m.input) }, ...(m.clientStreaming ? { stream: true } : {}) }
      entry.response = { schema: { $ref: this.refOf(m.output) }, ...(m.serverStreaming ? { stream: true } : {}) }
      if (idempotency !== undefined && idempotency !== "IDEMPOTENCY_UNKNOWN") entry.idempotency = idempotency
      if (http) entry.http = http
      if (Object.keys(ma.options).length) entry.options = ma.options
      if (ma.conflicts.length) entry["x-annotation-conflicts"] = ma.conflicts
      methods[m.name] = entry as unknown as ProtoApiMethod
      this.annotationIssues(ma, `method ${m.name}`, file, mp, m)
      this.mapLocs(mp, m.locs, {
        request: "request",
        response: "response",
        "request/stream": "request/stream",
        "response/stream": "response/stream",
      })
      if (entry.idempotency) this.map(`${mp}/idempotency`, m.optionLocs.idempotency_level)
      if (entry.http) this.map(`${mp}/http`, m.optionLocs[HTTP_RULE])
      if (entry.deprecation) this.map(`${mp}/deprecation`, m.optionLocs.deprecated)
      this.mapAnnotations(mp, m, ma)
      this.mapOptions(mp, m, entry.options as object | undefined)
      this.flush(m, mp, file, m.locs[""])
    }
    out.methods = methods
    if (Object.keys(ann.options).length) out.options = ann.options
    this.finish(out, ann, `service ${s.fqn}`, file, pointer, s)
    return out as unknown as ProtoApiService
  }

  // ---- extensions -------------------------------------------------------------------------------------------------

  private lowerExtension(x: MField, file: MFile, chain: OptionTree[], scope: string): ProtoApiExtension {
    this.currentFile = file
    const pointer = extensionPointer(extensionFqn(x, scope))
    const field = this.lowerField(x, file, chain, scope, pointer, undefined, true)
    const extendee = x.extendee?.resolved ?? x.extendee?.unresolvedKey ?? x.extendee?.name.replace(/^\./, "") ?? ""
    const out: Record<string, unknown> = { ...field, title: field.title ?? x.name, extendee }
    if (this.useFiles) out.file = file.path
    return orderKeys(out) as unknown as ProtoApiExtension
  }

  // ---- files ------------------------------------------------------------------------------------------------------

  private lowerFile(f: MFile): ProtoApiFile {
    const pointer = filePointer(f.path)
    const out: Record<string, unknown> = {}
    // U3: a bundled file that is not an entry is marked; IN-13: its header is its licence text, not documentation
    const marked = f.bundled && !this.entry.has(f.path)
    const header = marked ? undefined : normalizeComment(f.header)
    if (header) out.description = header
    if (!f.syntaxUnknown) out.syntax = f.syntax
    if (f.package) out.package = f.package
    if (f.imports.length) out.imports = f.imports.map((i) => i.path)
    const flags: Record<string, string> = {}
    for (const i of f.imports) if (i.flag) flags[i.path] = i.flag
    if (Object.keys(flags).length) out.importFlags = flags
    const options = withoutFeatureKeys(this.opts(f, "file", f, f.package))
    if (Object.keys(options).length) out.options = options
    if (marked) out.bundled = true
    this.mapLocs(pointer, f.locs, { syntax: "syntax", package: "package" })
    f.imports.forEach((imp, i) => this.map(`${pointer}/imports/${i}`, imp.loc))
    this.mapOptions(pointer, f, out.options as object | undefined)
    this.flush(f, pointer, f, f.locs[""])
    return out as unknown as ProtoApiFile
  }

  // ---- document ---------------------------------------------------------------------------------------------------

  run(): LowerOutput {
    this.orderFiles()
    this.computeEmission()
    const messages: Record<string, ProtoApiMessage> = {}
    const enums: Record<string, ProtoApiEnum> = {}
    const extensions: Record<string, ProtoApiExtension> = {}
    const services: Record<string, ProtoApiService> = {}
    const files: Record<string, ProtoApiFile> = {}
    const usedFiles = new Set<string>()
    const enumQueue: { e: MEnum; chain: OptionTree[] }[] = []
    const extQueue: { x: MField; file: MFile; chain: OptionTree[]; scope: string }[] = []

    for (const file of this.orderedFiles) {
      const emitAll = this.full(file)
      const fileOpts = this.opts(file, "file", file, file.package)
      const walk = (m: MMessage, chain: OptionTree[]) => {
        const mo = this.opts(m, "message", file, parentScope(m.fqn))
        const inner = [...chain, mo]
        if (this.emittedMessages.has(m.fqn) && !(m.fqn in messages)) {
          messages[m.fqn] = this.lowerMessage(m, chain)
          usedFiles.add(file.path)
        }
        for (const e of m.enums) enumQueue.push({ e, chain: inner })
        for (const x of m.extensions) if (emitAll) extQueue.push({ x, file, chain: inner, scope: m.fqn })
        for (const n of m.nested) walk(n, inner)
      }
      const fileEnums = file.enums.map((e) => ({ e, chain: [fileOpts] }))
      const fileExts = emitAll ? file.extensions.map((x) => ({ x, file, chain: [fileOpts], scope: file.package })) : []
      const before = enumQueue.length
      const beforeX = extQueue.length
      for (const m of file.messages) walk(m, [fileOpts])
      enumQueue.splice(before, 0, ...fileEnums)
      extQueue.splice(beforeX, 0, ...fileExts)
      if (emitAll) {
        for (const s of file.services) {
          if (!(s.fqn in services)) services[s.fqn] = this.lowerService(s)
          usedFiles.add(file.path)
        }
      }
      for (const { e, chain } of enumQueue.splice(0)) {
        if (this.emittedEnums.has(e.fqn) && !(e.fqn in enums)) {
          enums[e.fqn] = this.lowerEnum(e, chain)
          usedFiles.add(file.path)
        }
      }
      for (const { x, file: xf, chain, scope } of extQueue.splice(0)) {
        const fqn = x.fqn ?? x.name
        if (fqn in extensions) continue
        extensions[fqn] = this.lowerExtension(x, xf, chain, scope)
        usedFiles.add(xf.path)
      }
    }
    // duplicate component names reported by the symbol table
    for (const d of this.input.symbols.duplicates) {
      const file = d.second.file
      if (!file || file.bundled) continue
      const pointer =
        d.second.kind === "enum"
          ? enumPointer(d.fqn)
          : d.second.kind === "service"
            ? servicePointer(d.fqn)
            : messagePointer(d.fqn)
      const node = d.second.node as { locs?: Locs } | undefined
      this.issue(
        "duplicate-name",
        `${d.fqn} is declared more than once (${d.first.file?.path ?? "?"}, ${file.path})`,
        file,
        pointer,
        node?.locs?.[""],
      )
    }
    if (this.useFiles) {
      for (const file of this.orderedFiles) {
        if (this.full(file) || usedFiles.has(file.path)) files[file.path] = this.lowerFile(file)
      }
    } else {
      for (const file of this.orderedFiles) this.flush(file, filePointer(file.path), file, file.locs[""])
    }
    const document: ProtoApiDocument = { protoapi: "0.1" }
    if (this.useFiles && Object.keys(files).length) document.files = files
    if (Object.keys(services).length) document.services = services
    const components: NonNullable<ProtoApiDocument["components"]> = {}
    if (Object.keys(messages).length) components.messages = messages
    if (Object.keys(enums).length) components.enums = enums
    if (Object.keys(extensions).length) components.extensions = extensions
    if (Object.keys(components).length) document.components = components
    return { document, sourceMap: Object.fromEntries(this.sourceMap) }
  }
}

/** google.api.HttpRule -> { method, path, body?, responseBody?, additionalBindings? } (D16) */
export const normalizeHttp = (rule: Record<string, unknown>): ProtoApiHttpRule => {
  const out: Record<string, unknown> = {}
  for (const m of ["get", "put", "post", "delete", "patch"]) {
    if (typeof rule[m] === "string") {
      out.method = m.toUpperCase()
      out.path = rule[m]
      break
    }
  }
  if (!out.method && isPlainObject(rule.custom)) {
    out.method = String(rule.custom.kind ?? "")
    out.path = String(rule.custom.path ?? "")
  }
  if (!out.method) {
    out.method = ""
    out.path = ""
  }
  if (typeof rule.body === "string" && rule.body) out.body = rule.body
  if (typeof rule.response_body === "string" && rule.response_body) out.responseBody = rule.response_body
  if (Array.isArray(rule.additional_bindings) && rule.additional_bindings.length)
    out.additionalBindings = rule.additional_bindings
      .filter(isPlainObject)
      .map((r) => normalizeHttp(r as Record<string, unknown>))
  return out as unknown as ProtoApiHttpRule
}
