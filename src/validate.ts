// Definition checks of the text producer (validation decision D-E): what buf rejects in a well-formed file. Runs
// after the lowering on the files the build validates (non-bundled `.proto` sources), reusing the lowering's typed
// options and edition defaults. Never throws and never changes the document: every finding is a `BuildIssue`.
// The syntactic rules (labels, groups, statement order, keywords per edition) are checked in text.ts.

import type { BuildIssue, BuildIssueCode, Location } from "./types.ts"
import type { MEnum, MField, MFile, MMessage, MOptionHolder, MService, OptionTree } from "./model.ts"
import { type SymbolTable, defaultVisibility } from "./symbols.ts"
import type { Lowering } from "./lower.ts"
import { OPTIONS_MESSAGE, type OptionsKind, optionNameSegments } from "./options.ts"
import { type ResolvedFeatures, resolveFeatures } from "./features.ts"
import { defaultJsonName } from "./values/json-name.ts"
import { ptr } from "./paths.ts"
import { EDITION_NUMBERS, editionNumber, isEditions } from "./common/editions.ts"
import { FIELD_NUMBER_MAX, INT32_MAX, INT32_MIN, MESSAGE_SET_NUMBER_MAX } from "./common/limits.ts"
import {
  enumPointer,
  extensionFqn,
  extensionPointer,
  filePointer,
  mapEntryName,
  messagePointer,
  parentScope,
  qualify,
  servicePointer,
  syntaxName,
} from "./common/names.ts"
import { isPlainObject } from "./common/objects.ts"

const TARGET: Record<OptionsKind, string> = {
  file: "TARGET_TYPE_FILE",
  extensionRange: "TARGET_TYPE_EXTENSION_RANGE",
  message: "TARGET_TYPE_MESSAGE",
  field: "TARGET_TYPE_FIELD",
  oneof: "TARGET_TYPE_ONEOF",
  enum: "TARGET_TYPE_ENUM",
  enumValue: "TARGET_TYPE_ENUM_ENTRY",
  service: "TARGET_TYPE_SERVICE",
  method: "TARGET_TYPE_METHOD",
}
const KIND_NAME: Record<OptionsKind, string> = {
  file: "a file",
  extensionRange: "an extension range",
  message: "a message",
  field: "a field",
  oneof: "a oneof",
  enum: "an enum",
  enumValue: "an enum value",
  service: "a service",
  method: "a method",
}
const OPTIONS_MESSAGES = new Set(Object.values(OPTIONS_MESSAGE))

// ---- naming styles (edition 2024 enforce_naming_style STYLE2024 / STYLE2026, as buf checks them) -------------------
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/
const PASCAL = /^[A-Z][A-Za-z0-9]*$/
const SCREAMING = /^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*$/

/** protoc's `PrefixRemover::MaybeRemove`: `value` without the enum name prefix (case and underscores ignored). */
const removePrefix = (prefix: string, value: string): string => {
  let i = 0
  let j = 0
  for (; i < value.length && j < prefix.length; i++) {
    if (value[i] === "_") continue
    if (value[i].toLowerCase() !== prefix[j++]) return value
  }
  if (j < prefix.length) return value
  while (i < value.length && value[i] === "_") i++
  return i === value.length ? value : value.slice(i)
}

/** protoc's `EnumValueToPascalCase` of the value without its prefix (`CheckEnumValueUniqueness`). */
const enumValueKey = (enumName: string, value: string): string => {
  const stripped = removePrefix(enumName.replace(/_/g, "").toLowerCase(), value)
  let out = ""
  let upper = true
  for (const ch of stripped) {
    if (ch === "_") upper = true
    else {
      out += upper ? ch.toUpperCase() : ch.toLowerCase()
      upper = false
    }
  }
  return out
}

interface Range {
  start: number
  end: number
  loc?: Location
}

/** Pairs of overlapping ranges (each later range against the furthest-reaching earlier one), O(n log n). */
const overlaps = (ranges: Range[]): [Range, Range][] => {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: [Range, Range][] = []
  let reach: Range | undefined
  for (const r of sorted) {
    if (reach && r.start <= reach.end) out.push([reach, r])
    if (!reach || r.end > reach.end) reach = r
  }
  return out
}

const fmtRange = (r: Range) => (r.start === r.end ? `${r.start}` : `${r.start} to ${r.end}`)

/** `EDITION_2024` -> `edition 2024`, `EDITION_PROTO3` -> `proto3` */
const editionLabel = (edition: string) =>
  /^EDITION_PROTO[23]$/.test(edition) ? edition.slice(8).toLowerCase() : edition.replace(/^EDITION_/, "edition ")

export interface ValidateInput {
  files: MFile[]
  symbols: SymbolTable
  lowering: Lowering
  sources: Map<string, string>
  issues: BuildIssue[]
}

interface DefinitionInfo {
  targets?: string[]
  introduced?: string
  removed?: string
  removalError?: string
}

export const validateFiles = (input: ValidateInput) => new Validator(input).run()

class Validator {
  private readonly symbols: SymbolTable
  private readonly L: Lowering
  private readonly definitions = new Map<object, DefinitionInfo>()
  private readonly closedCache = new Map<string, boolean>()
  /** package -> enum value name -> enum fqn, across the validated files */
  private readonly packageValues = new Map<string, Map<string, string>>()

  private readonly input: ValidateInput

  constructor(input: ValidateInput) {
    this.input = input
    this.symbols = input.symbols
    this.L = input.lowering
  }

  private issue(code: BuildIssueCode, message: string, file: MFile, pointer: string, location?: Location) {
    this.input.issues.push({ code, message, file: file.path, pointer, location })
  }

  run() {
    const files = this.input.files.filter((f) => f.validate && f.parsed)
    if (!files.length) return
    this.imports(files)
    for (const f of files) this.file(f)
    this.extensionNumbers(files)
  }

  // ---- features ----------------------------------------------------------------------------------------------------

  private features(file: MFile, chain: OptionTree[]): ResolvedFeatures {
    return resolveFeatures(this.L.defaults(file.syntax), file.syntax, chain)
  }

  /** Is the enum `fqn` closed (proto2, or editions enum_type CLOSED resolved along its scopes)? */
  private isClosed(fqn: string): boolean {
    const cached = this.closedCache.get(fqn)
    if (cached !== undefined) return cached
    const e = this.symbols.enum(fqn)
    let closed = false
    if (e) {
      const file = e.file
      if (file.syntax === "proto2") closed = true
      else if (isEditions(file.syntax)) {
        const chain: OptionTree[] = []
        for (let scope = parentScope(fqn); scope; scope = parentScope(scope)) {
          const m = this.symbols.message(scope)
          if (!m || m.file !== file) break
          chain.unshift(this.L.opts(m, "message", file, parentScope(m.fqn)))
        }
        chain.unshift(this.L.opts(file, "file", file, file.package))
        chain.push(this.L.opts(e, "enum", file, parentScope(fqn)))
        closed = this.features(file, chain).enum_type === "CLOSED"
      }
    }
    this.closedCache.set(fqn, closed)
    return closed
  }

  // ---- options: targets, edition support, feature values (generic, from the option definitions) --------------------

  /** `targets` and `feature_support` of an option or feature field definition (its own typed options). */
  private definition(def: MField, scope: string): DefinitionInfo {
    const cached = this.definitions.get(def)
    if (cached) return cached
    const file = this.fileOf(def, scope)
    const info: DefinitionInfo = {}
    if (file) {
      const o = this.L.opts(def, "field", file, scope)
      if (Array.isArray(o.targets)) info.targets = o.targets.filter((t): t is string => typeof t === "string")
      if (isPlainObject(o.feature_support)) {
        const s = o.feature_support
        if (typeof s.edition_introduced === "string") info.introduced = s.edition_introduced
        if (typeof s.edition_removed === "string") info.removed = s.edition_removed
        if (typeof s.removal_error === "string") info.removalError = s.removal_error
      }
    }
    this.definitions.set(def, info)
    return info
  }

  private fileOf(def: MField, scope: string): MFile | undefined {
    if (def.fqn) return this.symbols.extensionByName.get(def.fqn)?.file
    return this.symbols.message(scope)?.file
  }

  /** `feature_support` of an enum value definition (feature values introduced or removed in an edition). */
  private valueSupport(enumFqn: string, value: string): DefinitionInfo | undefined {
    const e = this.symbols.enum(enumFqn)
    const v = e?.values.find((x) => x.name === value)
    if (!e || !v) return undefined
    const cached = this.definitions.get(v)
    if (cached) return cached
    const o = this.L.opts(v, "enumValue", e.file, parentScope(e.fqn))
    const info: DefinitionInfo = {}
    if (isPlainObject(o.feature_support)) {
      const s = o.feature_support
      if (typeof s.edition_introduced === "string") info.introduced = s.edition_introduced
      if (typeof s.edition_removed === "string") info.removed = s.edition_removed
    }
    this.definitions.set(v, info)
    return info
  }

  /** Edition window of a definition: `invalid-definition` when the file's edition is before / after it. */
  private support(
    name: string,
    info: DefinitionInfo | undefined,
    file: MFile,
    pointer: string,
    loc: Location | undefined,
  ) {
    if (!info) return
    const edition = editionNumber(file.syntax)
    const introduced = info.introduced ? EDITION_NUMBERS[info.introduced] : undefined
    const removed = info.removed ? EDITION_NUMBERS[info.removed] : undefined
    if (introduced !== undefined && edition < introduced)
      this.issue(
        "invalid-definition",
        `\`${name}\` is not supported in ${syntaxName(file.syntax)}: it was introduced in ${editionLabel(info.introduced as string)}`,
        file,
        pointer,
        loc,
      )
    else if (removed !== undefined && edition >= removed)
      this.issue(
        "invalid-definition",
        `\`${name}\` is not supported in ${syntaxName(file.syntax)}: it was removed in ${editionLabel(info.removed as string)}${
          info.removalError ? ` (${info.removalError})` : ""
        }`,
        file,
        pointer,
        loc,
      )
  }

  /** Locations of the text option statements of a holder by the dotted path they set (`features.field_presence`). */
  private statementLocs(holder: MOptionHolder, file: MFile): Map<string, Location> {
    const out = new Map<string, Location>()
    const source = this.input.sources.get(file.path) ?? ""
    for (const raw of holder.raw) {
      if (raw.kind !== "text" || !raw.loc) continue
      const segs = optionNameSegments(raw.name, (n) => source.slice(n.start, n.end))
      const path = segs.map((s) => s.name.replace(/^\./, "")).join(".")
      if (!out.has(path)) out.set(path, raw.loc)
    }
    return out
  }

  /**
   * The options a holder sets: each built-in option or extension is checked against its definition's `targets` and
   * `feature_support`; `features.*` (and language features such as `features.(pb.cpp).*`) also against the syntax
   * (features exist only in editions), their own targets and support window, and known values.
   */
  private options(holder: MOptionHolder, kind: OptionsKind, file: MFile, scope: string, pointer: string) {
    if (!holder.raw.length) return
    const options = this.L.opts(holder, kind, file, scope)
    const keys = Object.keys(holder.optionLocs)
    const def = this.symbols.message(OPTIONS_MESSAGE[kind])
    if (!def) return
    let locs: Map<string, Location> | undefined
    const locOf = (path: string, top: string) =>
      (locs ??= this.statementLocs(holder, file)).get(path) ?? holder.optionLocs[top]
    for (const key of keys) {
      const field = def.fields.find((f) => f.name === key) ?? this.extensionField(key, def.fqn)
      if (!field) continue
      const at = `${pointer}/options/${ptr(key)}`
      const loc = holder.optionLocs[key]
      const info = this.definition(field, field.fqn ? (this.symbols.extensionByName.get(key)?.scope ?? "") : def.fqn)
      if (info.targets?.length && !info.targets.includes(TARGET[kind]))
        this.issue("invalid-option", `option \`${key}\` cannot be set on ${KIND_NAME[kind]}`, file, at, loc)
      this.support(key, info, file, at, loc)
      if (key === "ctype" && editionNumber(file.syntax) >= EDITION_NUMBERS.EDITION_2024)
        this.issue(
          "invalid-definition",
          `\`ctype\` is not supported in ${syntaxName(file.syntax)}; use features.(pb.cpp).string_type`,
          file,
          at,
          loc,
        )
      if (key === "packed" && isEditions(file.syntax))
        this.issue(
          "invalid-option",
          `\`packed\` is not supported in ${syntaxName(file.syntax)}; use features.repeated_field_encoding`,
          file,
          at,
          loc,
        )
      if (key !== "features") continue
      if (!isEditions(file.syntax)) {
        this.issue("invalid-definition", `features cannot be set in ${file.syntax}`, file, at, loc)
        continue
      }
      const features = options.features
      if (isPlainObject(features))
        this.featureTree(features, "google.protobuf.FeatureSet", "features", kind, file, at, (p) => locOf(p, key))
    }
  }

  private extensionField(fqn: string, extendee: string): MField | undefined {
    const e = this.symbols.extensionByName.get(fqn)
    return e && e.field.extendee?.resolved === extendee ? e.field : undefined
  }

  private featureTree(
    tree: Record<string, unknown>,
    defFqn: string,
    path: string,
    kind: OptionsKind,
    file: MFile,
    pointer: string,
    locOf: (path: string) => Location | undefined,
  ) {
    const def = this.symbols.message(defFqn)
    if (!def) return
    for (const [key, value] of Object.entries(tree)) {
      const field = def.fields.find((f) => f.name === key) ?? this.extensionField(key, def.fqn)
      if (!field) continue
      const here = `${path}.${key}`
      const loc = locOf(here)
      const scope = field.fqn ? (this.symbols.extensionByName.get(key)?.scope ?? "") : def.fqn
      const info = this.definition(field, scope)
      if (info.targets?.length && !info.targets.includes(TARGET[kind]))
        this.issue("invalid-option", `feature \`${key}\` cannot be set on ${KIND_NAME[kind]}`, file, pointer, loc)
      this.support(key, info, file, pointer, loc)
      const t = field.type
      if (t.kind === "named" && t.resolved?.kind === "message" && isPlainObject(value)) {
        this.featureTree(value, t.resolved.fqn, here, kind, file, pointer, locOf)
        continue
      }
      if (t.kind === "named" && t.resolved?.kind === "enum" && typeof value === "string") {
        const e = this.symbols.enum(t.resolved.fqn)
        if (e?.values.find((v) => v.name === value)?.number === 0)
          this.issue(
            "invalid-option",
            `feature \`${key}\` must be set to a known value, not ${value}`,
            file,
            pointer,
            loc,
          )
        else this.support(`${key} = ${value}`, this.valueSupport(t.resolved.fqn, value), file, pointer, loc)
        if (key === "field_presence" && value === "LEGACY_REQUIRED" && kind === "file")
          this.issue(
            "invalid-option",
            "features.field_presence = LEGACY_REQUIRED cannot be set at the file level",
            file,
            pointer,
            loc,
          )
      }
    }
  }

  // ---- files -------------------------------------------------------------------------------------------------------

  /** Self-imports, duplicate imports and import cycles (buf: "detected cyclic import", "file imported multiple times"). */
  private imports(files: MFile[]) {
    const validated = new Set(files.map((f) => f.path))
    for (const f of files) {
      const seen = new Set<string>()
      f.imports.forEach((imp, i) => {
        const pointer = `${filePointer(f.path)}/imports/${i}`
        if (imp.path === f.path) this.issue("invalid-definition", `${f.path} imports itself`, f, pointer, imp.loc)
        else if (seen.has(imp.path))
          this.issue("invalid-definition", `"${imp.path}" is imported more than once`, f, pointer, imp.loc)
        seen.add(imp.path)
      })
    }
    // cycles: depth-first from each validated file; an import of a file still on the stack closes a cycle
    const state = new Map<string, 1 | 2>()
    const stack: string[] = []
    const reported = new Set<string>()
    const visit = (path: string) => {
      state.set(path, 1)
      stack.push(path)
      const f = this.symbols.files.get(path)
      f?.imports.forEach((imp, i) => {
        if (imp.path === path) return
        const s = state.get(imp.path)
        if (s === 1) {
          const key = `${path}#${i}`
          if (validated.has(path) && f && !reported.has(key)) {
            reported.add(key)
            const cycle = [...stack.slice(stack.indexOf(imp.path)), imp.path].join(" -> ")
            this.issue("invalid-definition", `import cycle: ${cycle}`, f, `${filePointer(path)}/imports/${i}`, imp.loc)
          }
        } else if (s === undefined && this.symbols.files.has(imp.path)) visit(imp.path)
      })
      stack.pop()
      state.set(path, 2)
    }
    for (const f of files) if (!state.has(f.path)) visit(f.path)
  }

  private file(f: MFile) {
    const fp = filePointer(f.path)
    const fileOpts = this.L.opts(f, "file", f, f.package)
    this.options(f, "file", f, f.package, fp)
    const features = this.features(f, [fileOpts])
    if (this.styled(features) && f.package && !f.package.split(".").every((p) => SNAKE.test(p)))
      this.issue(
        "invalid-definition",
        `package name ${f.package} should be lower_snake_case`,
        f,
        `${fp}/package`,
        f.locs.package,
      )
    const strict = isEditions(f.syntax) && defaultVisibility(f) === "STRICT"
    for (const m of f.messages) this.message(m, f, [fileOpts], strict, false)
    for (const e of f.enums) this.enumeration(e, f, [fileOpts], strict, undefined)
    for (const x of f.extensions) this.extension(x, f, [fileOpts], f.package)
    for (const s of f.services) this.service(s, f, [fileOpts])
    this.valueScope(f.enums, f.package, f)
  }

  private styled(features: ResolvedFeatures): boolean {
    const s = features.enforce_naming_style
    return s === "STYLE2024" || s === "STYLE2026"
  }

  private style(
    ok: boolean,
    what: string,
    name: string,
    expected: string,
    file: MFile,
    pointer: string,
    loc: Location | undefined,
  ) {
    if (!ok) this.issue("invalid-definition", `${what} name ${name} should be ${expected}`, file, pointer, loc)
  }

  // ---- messages ----------------------------------------------------------------------------------------------------

  private message(m: MMessage, file: MFile, chain: OptionTree[], strict: boolean, nested: boolean) {
    const mp = messagePointer(m.fqn)
    const mo = this.L.opts(m, "message", file, parentScope(m.fqn))
    this.options(m, "message", file, parentScope(m.fqn), mp)
    const inner = [...chain, mo]
    const features = this.features(file, inner)
    if (this.styled(features)) this.style(PASCAL.test(m.name), "message", m.name, "PascalCase", file, mp, m.locs.name)
    if (strict && nested && m.visibility === "export")
      this.issue(
        "invalid-definition",
        `nested message ${m.fqn} cannot be exported (default_symbol_visibility STRICT)`,
        file,
        `${mp}/options/visibility`,
        m.locs.name ?? m.locs[""],
      )
    const messageSet = mo.message_set_wire_format === true
    const editions = isEditions(file.syntax)
    // the types and extensions declared in the message scope (C++ scoping: fields and oneofs share it)
    const scoped = new Map<string, string>()
    for (const n of m.nested) scoped.set(n.name, `message ${n.fqn}`)
    for (const e of m.enums) scoped.set(e.name, `enum ${e.fqn}`)
    for (const x of m.extensions) scoped.set(x.name, `extension ${m.fqn}.${x.name}`)
    // fields
    const extRanges: Range[] = m.extensionRanges.map((r) => ({ start: r.start, end: r.end, loc: r.rangeLoc ?? r.loc }))
    for (const f of m.fields) {
      const fp = `${mp}/properties/${ptr(f.name)}`
      const fo = this.L.opts(f, "field", file, m.fqn)
      this.options(f, "field", file, m.fqn, fp)
      let ff = features
      if (editions) {
        const oneof = f.oneof ? m.oneofs.find((o) => o.name === f.oneof) : undefined
        const oo = oneof ? this.L.opts(oneof, "oneof", file, parentScope(m.fqn)) : undefined
        ff = this.features(file, oo ? [...inner, oo, fo] : [...inner, fo])
        if (this.styled(ff)) this.style(SNAKE.test(f.name), "field", f.name, "snake_case", file, fp, f.locs.name)
      }
      this.closedEnum(f, file, ff, fp, false)
      const inRange = extRanges.length ? extRanges.find((r) => f.number >= r.start && f.number <= r.end) : undefined
      if (inRange)
        this.issue(
          "invalid-number",
          `field ${f.name} = ${f.number} uses a number of the extension range ${fmtRange(inRange)}`,
          file,
          fp,
          f.locs.number ?? f.locs[""],
        )
      if (!scoped.size) continue
      const clash = scoped.get(f.name)
      const ownGroup = f.group && f.type.kind === "named" && clash === `message ${f.type.resolved?.fqn}`
      if (clash && !ownGroup)
        this.issue("duplicate-name", `field ${f.name} has the name of ${clash}`, file, fp, f.locs.name ?? f.locs[""])
      const entry = f.map ? scoped.get(mapEntryName(f.name)) : undefined
      if (entry)
        this.issue(
          "duplicate-name",
          `map field ${f.name} needs the entry message name ${mapEntryName(f.name)}, which ${entry} uses`,
          file,
          fp,
          f.locs[""],
        )
    }
    for (const o of m.oneofs) {
      const op = `${mp}/oneofs/${ptr(o.name)}`
      this.options(o, "oneof", file, parentScope(m.fqn), op)
      const oo = this.L.opts(o, "oneof", file, parentScope(m.fqn))
      if (editions && this.styled(this.features(file, [...inner, oo])))
        this.style(SNAKE.test(o.name), "oneof", o.name, "snake_case", file, op, o.locs.name)
      const field = m.fields.find((f) => f.name === o.name)
      const clash = field ? `field ${field.name}` : scoped.get(o.name)
      if (clash)
        this.issue("duplicate-name", `oneof ${o.name} has the name of ${clash}`, file, op, o.locs.name ?? o.locs[""])
    }
    this.jsonNames(m, file, features, mp)
    this.messageNumbers(m, file, mp, messageSet, extRanges)
    for (const r of m.extensionRanges) this.options(r, "extensionRange", file, parentScope(m.fqn), `${mp}/extensions`)
    for (const n of m.nested) this.message(n, file, inner, strict, true)
    for (const e of m.enums) this.enumeration(e, file, inner, strict, m)
    for (const x of m.extensions) this.extension(x, file, inner, m.fqn)
    this.valueScope(m.enums, m.fqn, file, m)
  }

  /** JSON name clashes (buf: "message fields have the same JSON name"); two default names may clash only under
   *  json_format LEGACY_BEST_EFFORT (proto2). */
  private jsonNames(m: MMessage, file: MFile, features: ResolvedFeatures, mp: string) {
    const legacy = features.json_format === "LEGACY_BEST_EFFORT"
    const seen = new Map<string, { field: MField; custom: boolean }>()
    for (const f of m.fields) {
      const custom = f.jsonName !== undefined
      const json = custom ? (f.jsonName as string) : defaultJsonName(f.name)
      const prev = seen.get(json)
      if (!prev) {
        seen.set(json, { field: f, custom })
        continue
      }
      if (prev.field.name === f.name || (legacy && !custom && !prev.custom)) continue
      this.issue(
        "duplicate-name",
        `the JSON name "${json}" of field ${f.name} is also the JSON name of field ${prev.field.name}`,
        file,
        `${mp}/properties/${ptr(f.name)}`,
        f.locs.jsonName ?? f.locs.name ?? f.locs[""],
      )
    }
  }

  /** Reserved and extension ranges of a message (buf: "empty reserved range", "overlapping field number ranges",
   *  "field number out of range", "message field name reserved more than once"). */
  private messageNumbers(m: MMessage, file: MFile, mp: string, messageSet: boolean, extRanges: Range[]) {
    const max = messageSet ? MESSAGE_SET_NUMBER_MAX : FIELD_NUMBER_MAX
    const reserved: Range[] = m.reservedRanges.map((r, i) => ({
      start: r[0],
      end: r[1],
      loc: m.reservedLocs?.ranges[i],
    }))
    const bounds = (r: Range, what: string, pointer: string) => {
      if (r.start > r.end)
        this.issue(
          "invalid-number",
          `${what} ${r.start} to ${r.end} is empty (the start is after the end)`,
          file,
          pointer,
          r.loc,
        )
      else if (r.start < 1 || r.end > max)
        this.issue(
          "invalid-number",
          `${what} ${fmtRange(r)} is out of the field number range 1 to ${max}`,
          file,
          pointer,
          r.loc,
        )
    }
    for (const r of reserved) bounds(r, "reserved range", `${mp}/reserved`)
    for (const r of extRanges) bounds(r, "extension range", `${mp}/extensions`)
    const valid = (r: Range) => r.start <= r.end
    for (const [a, b] of overlaps(reserved.filter(valid)))
      this.issue(
        "reserved-conflict",
        `reserved range ${fmtRange(b)} overlaps reserved range ${fmtRange(a)}`,
        file,
        `${mp}/reserved`,
        b.loc,
      )
    for (const [a, b] of overlaps(extRanges.filter(valid)))
      this.issue(
        "duplicate-number",
        `extension range ${fmtRange(b)} overlaps extension range ${fmtRange(a)}`,
        file,
        `${mp}/extensions`,
        b.loc,
      )
    for (const e of extRanges.filter(valid)) {
      const r = reserved.find((x) => valid(x) && x.start <= e.end && e.start <= x.end)
      if (r)
        this.issue(
          "reserved-conflict",
          `extension range ${fmtRange(e)} overlaps reserved range ${fmtRange(r)}`,
          file,
          `${mp}/extensions`,
          e.loc,
        )
    }
    this.reservedNames(m.reservedNames, m.reservedLocs?.names, file, `${mp}/reserved`)
  }

  private reservedNames(names: string[], locs: (Location | undefined)[] | undefined, file: MFile, pointer: string) {
    const seen = new Set<string>()
    names.forEach((n, i) => {
      if (seen.has(n))
        this.issue("reserved-conflict", `the name ${n} is reserved more than once`, file, pointer, locs?.[i])
      seen.add(n)
    })
  }

  /** A closed enum cannot be the type of a proto3 field, nor of an editions field with implicit presence. */
  private closedEnum(f: MField, file: MFile, features: ResolvedFeatures, fp: string, extension: boolean) {
    const t = f.map ? f.map.value : f.type
    if (t.kind !== "named" || t.resolved?.kind !== "enum" || !this.isClosed(t.resolved.fqn)) return
    if (file.syntax === "proto3")
      this.issue(
        "invalid-definition",
        `closed enum ${t.resolved.fqn} cannot be used in a proto3 message (field ${f.name})`,
        file,
        fp,
        f.locs.type ?? f.locs[""],
      )
    else if (
      isEditions(file.syntax) &&
      !extension &&
      !f.repeated &&
      !f.map &&
      !f.oneof &&
      features.field_presence === "IMPLICIT"
    )
      this.issue(
        "invalid-definition",
        `closed enum ${t.resolved.fqn} cannot be used in field ${f.name}, which has implicit presence`,
        file,
        fp,
        f.locs.type ?? f.locs[""],
      )
  }

  // ---- extensions --------------------------------------------------------------------------------------------------

  private extension(x: MField, file: MFile, chain: OptionTree[], scope: string) {
    const xp = extensionPointer(extensionFqn(x, scope))
    const xo = this.L.opts(x, "field", file, scope)
    this.options(x, "field", file, scope, xp)
    const features = this.features(file, [...chain, xo])
    if (this.styled(features)) this.style(SNAKE.test(x.name), "extension", x.name, "snake_case", file, xp, x.locs.name)
    this.closedEnum(x, file, features, xp, true)
    const extendee = x.extendee?.resolved
    if (file.syntax === "proto3" && extendee && !OPTIONS_MESSAGES.has(extendee))
      this.issue(
        "invalid-definition",
        `extensions in proto3 are only allowed for custom options; ${extendee} is not a google.protobuf options message`,
        file,
        xp,
        x.locs.extendee ?? x.locs[""],
      )
  }

  /** Extension numbers against the extendee's ranges and against each other (per extendee, across files). */
  private extensionNumbers(files: MFile[]) {
    const validated = new Set(files.map((f) => f.path))
    for (const [extendee, list] of this.symbols.extensionsByExtendee) {
      const target = this.symbols.message(extendee)
      const used = new Map<number, MField>()
      for (const x of list) {
        const entry = x.fqn ? this.symbols.extensionByName.get(x.fqn) : undefined
        const file = entry?.file
        const check = !!file && validated.has(file.path)
        const xp = extensionPointer(x.fqn ?? x.name)
        const prev = used.get(x.number)
        if (prev && check && file)
          this.issue(
            "duplicate-number",
            `extension number ${x.number} of ${extendee} is used by ${prev.fqn ?? prev.name} and ${x.fqn ?? x.name}`,
            file,
            xp,
            x.locs.number ?? x.locs[""],
          )
        else if (!prev) used.set(x.number, x)
        if (check && file && target) {
          const setMax =
            this.L.opts(target, "message", target.file, parentScope(target.fqn)).message_set_wire_format === true
          const inRange = target.extensionRanges.some((r) => {
            const end = r.toMax && setMax ? MESSAGE_SET_NUMBER_MAX : r.end
            return x.number >= r.start && x.number <= end
          })
          if (!inRange)
            this.issue(
              "invalid-number",
              `extension ${x.fqn ?? x.name} = ${x.number} is outside the extension ranges of ${extendee}`,
              file,
              xp,
              x.locs.number ?? x.locs[""],
            )
        }
      }
    }
  }

  // ---- enums -------------------------------------------------------------------------------------------------------

  private enumeration(e: MEnum, file: MFile, chain: OptionTree[], strict: boolean, parent: MMessage | undefined) {
    const ep = enumPointer(e.fqn)
    const scope = parentScope(e.fqn)
    const eo = this.L.opts(e, "enum", file, scope)
    this.options(e, "enum", file, scope, ep)
    const features = this.features(file, [...chain, eo])
    const styled = this.styled(features)
    if (styled) this.style(PASCAL.test(e.name), "enum", e.name, "PascalCase", file, ep, e.locs.name)
    if (strict && parent && e.visibility === "export") this.strictNestedEnum(e, parent, file, ep)
    if (!e.values.length)
      this.issue("invalid-definition", `enum ${e.fqn} must have at least one value`, file, ep, e.locs[""])
    const open = features.enum_type === "OPEN"
    const first = e.values[0]
    if (open && first && first.number !== 0)
      this.issue(
        "invalid-definition",
        `the first value of open enum ${e.fqn} must be zero (${first.name} = ${first.number})`,
        file,
        `${ep}/values/${ptr(first.name)}`,
        first.locs.number ?? first.locs[""],
      )
    const allowAlias = eo.allow_alias === true
    const numbers = new Map<number, string>()
    let aliased = false
    const reserved: Range[] = e.reservedRanges.map((r, i) => ({
      start: r[0],
      end: r[1],
      loc: e.reservedLocs?.ranges[i],
    }))
    const reservedNames = new Set(e.reservedNames)
    const keys = new Map<string, { name: string; number: number }>()
    const checkKeys = features.json_format !== "LEGACY_BEST_EFFORT"
    for (const v of e.values) {
      const vp = `${ep}/values/${ptr(v.name)}`
      this.options(v, "enumValue", file, scope, vp)
      const vo = this.L.opts(v, "enumValue", file, scope)
      if (this.styled(vo.features ? this.features(file, [...chain, eo, vo]) : features))
        this.style(SCREAMING.test(v.name), "enum value", v.name, "SCREAMING_SNAKE_CASE", file, vp, v.locs.name)
      if (v.number < INT32_MIN || v.number > INT32_MAX)
        this.issue(
          "invalid-number",
          `enum value ${v.name} = ${v.number} is out of the int32 range`,
          file,
          vp,
          v.locs.number,
        )
      const prev = numbers.get(v.number)
      if (prev !== undefined && prev !== v.name) {
        aliased = true
        if (!allowAlias)
          this.issue(
            "duplicate-number",
            `enum value number ${v.number} is used by ${prev} and ${v.name} (set allow_alias to allow aliases)`,
            file,
            vp,
            v.locs.number ?? v.locs[""],
          )
      } else if (prev === undefined) numbers.set(v.number, v.name)
      const r = reserved.find((x) => v.number >= x.start && v.number <= x.end)
      if (r)
        this.issue(
          "reserved-conflict",
          `enum value ${v.name} = ${v.number} uses the reserved range ${fmtRange(r)}`,
          file,
          vp,
          v.locs[""],
        )
      if (reservedNames.has(v.name))
        this.issue("reserved-conflict", `enum value name ${v.name} is reserved`, file, vp, v.locs.name ?? v.locs[""])
      if (checkKeys) {
        const key = enumValueKey(e.name, v.name)
        const k = keys.get(key)
        if (k && k.name !== v.name && k.number !== v.number)
          this.issue(
            "duplicate-name",
            `enum value ${v.name} and ${k.name} have the same name once the ${e.name} prefix is removed and case is ignored`,
            file,
            vp,
            v.locs.name ?? v.locs[""],
          )
        else if (!k) keys.set(key, { name: v.name, number: v.number })
      }
    }
    if (allowAlias && !aliased)
      this.issue(
        "invalid-option",
        `${e.fqn} sets allow_alias, but no two values share a number`,
        file,
        `${ep}/options/allow_alias`,
        e.optionLocs.allow_alias ?? e.locs[""],
      )
    for (const r of reserved) {
      if (r.start > r.end)
        this.issue(
          "invalid-number",
          `reserved range ${r.start} to ${r.end} is empty (the start is after the end)`,
          file,
          `${ep}/reserved`,
          r.loc,
        )
    }
    for (const [a, b] of overlaps(reserved.filter((r) => r.start <= r.end)))
      this.issue(
        "reserved-conflict",
        `reserved range ${fmtRange(b)} overlaps reserved range ${fmtRange(a)}`,
        file,
        `${ep}/reserved`,
        b.loc,
      )
    this.reservedNames(e.reservedNames, e.reservedLocs?.names, file, `${ep}/reserved`)
  }

  /** STRICT: a nested enum may be exported only from a local message that reserves every field number (the
   *  "namespace" pattern `message Ns { export enum E { … } reserved 1 to max; }`). */
  private strictNestedEnum(e: MEnum, parent: MMessage, file: MFile, ep: string) {
    const at = `${ep}/options/visibility`
    const loc = e.locs.name ?? e.locs[""]
    const parentLocal = parent.visibility !== "export"
    if (!parentLocal)
      this.issue(
        "invalid-definition",
        `nested enum ${e.fqn} cannot be exported (default_symbol_visibility STRICT)`,
        file,
        at,
        loc,
      )
    else if (parent.reservedRanges.length > 1)
      this.issue(
        "invalid-definition",
        `nested enum ${e.fqn} can be exported only from a message with exactly one reserved range, 1 to max`,
        file,
        at,
        loc,
      )
    else {
      const [lo, hi] = parent.reservedRanges[0] ?? [0, 0]
      if (lo !== 1 || hi < FIELD_NUMBER_MAX)
        this.issue(
          "invalid-definition",
          `nested enum ${e.fqn} can be exported only from a message that reserves all field numbers (reserved 1 to max)`,
          file,
          at,
          loc,
        )
    }
  }

  /**
   * Enum values are siblings of their enum (C++ scoping): two enums of one scope with a value of the same name, or a
   * value named like a type, extension or service of that scope, clash (buf: "`A` declared multiple times").
   */
  private valueScope(enums: MEnum[], scope: string, file: MFile, members?: MMessage) {
    if (!enums.length) return
    // package scope: values of every file of the package; message scope: the message's own members
    let values = members ? new Map<string, string>() : this.packageValues.get(scope)
    if (!values) this.packageValues.set(scope, (values = new Map()))
    let local: Map<string, string> | undefined
    if (members) {
      local = new Map()
      for (const f of members.fields) local.set(f.name, `field ${members.fqn}.${f.name}`)
      for (const o of members.oneofs) local.set(o.name, `oneof ${members.fqn}.${o.name}`)
    }
    for (const e of enums) {
      const ep = enumPointer(e.fqn)
      for (const v of e.values) {
        const fqn = qualify(scope, v.name)
        const vp = `${ep}/values/${ptr(v.name)}`
        const loc = v.locs.name ?? v.locs[""]
        const other = values.get(v.name)
        if (other && other !== e.fqn)
          this.issue("duplicate-name", `enum value ${fqn} is also a value of enum ${other}`, file, vp, loc)
        else if (!other) values.set(v.name, e.fqn)
        const sym = this.symbols.get(fqn)
        const clash = sym && sym.kind !== "package" ? `${sym.kind} ${sym.fqn}` : local?.get(v.name)
        if (clash) this.issue("duplicate-name", `enum value ${fqn} has the name of ${clash}`, file, vp, loc)
      }
    }
  }

  // ---- services ----------------------------------------------------------------------------------------------------

  private service(s: MService, file: MFile, chain: OptionTree[]) {
    const sp = servicePointer(s.fqn)
    const so = this.L.opts(s, "service", file, s.fqn)
    this.options(s, "service", file, s.fqn, sp)
    const features = this.features(file, [...chain, so])
    if (this.styled(features)) this.style(PASCAL.test(s.name), "service", s.name, "PascalCase", file, sp, s.locs.name)
    for (const m of s.methods) {
      const mp = `${sp}/methods/${ptr(m.name)}`
      const mo = this.L.opts(m, "method", file, s.fqn)
      this.options(m, "method", file, s.fqn, mp)
      if (this.styled(this.features(file, [...chain, so, mo])))
        this.style(PASCAL.test(m.name), "method", m.name, "PascalCase", file, mp, m.locs.name)
    }
  }
}
