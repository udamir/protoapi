// Option checks driven by the option definitions: each option and feature an element sets against the `targets` and `feature_support` of its definition; features also against the syntax and their known values.

import type { Location } from "../types.ts"
import type { MField, MFile, MOptionHolder, OptionTree } from "../model/index.ts"
import { OPTIONS_MESSAGE, type OptionsKind } from "../options/kinds.ts"
import { optionNameSegments } from "../frontend/text/nodes.ts"
import { ptr } from "../paths.ts"
import { EDITION_NUMBERS, editionNumber, isEditions } from "../common/editions.ts"
import { parentScope, syntaxName } from "../common/names.ts"
import { isPlainObject } from "../common/objects.ts"
import type { ValidateContext } from "./context.ts"

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

/** `EDITION_2024` -> `edition 2024`, `EDITION_PROTO3` -> `proto3` */
const editionLabel = (edition: string) =>
  /^EDITION_PROTO[23]$/.test(edition) ? edition.slice(8).toLowerCase() : edition.replace(/^EDITION_/, "edition ")

interface DefinitionInfo {
  targets?: string[]
  introduced?: string
  removed?: string
  removalError?: string
}

/** The `feature_support` of a definition's typed options into `info`; `removal_error` only when `withRemovalError`. */
const readSupport = (o: OptionTree, info: DefinitionInfo, withRemovalError: boolean) => {
  if (!isPlainObject(o.feature_support)) return
  const s = o.feature_support
  if (typeof s.edition_introduced === "string") info.introduced = s.edition_introduced
  if (typeof s.edition_removed === "string") info.removed = s.edition_removed
  if (withRemovalError && typeof s.removal_error === "string") info.removalError = s.removal_error
}

/** The option checks of one validation, with the definitions it read cached. */
export class OptionChecks {
  private readonly definitions = new Map<object, DefinitionInfo>()
  private readonly cx: ValidateContext

  constructor(cx: ValidateContext) {
    this.cx = cx
  }

  /** `targets` and `feature_support` of an option or feature field definition (its own typed options). */
  private definition(def: MField, scope: string): DefinitionInfo {
    const cached = this.definitions.get(def)
    if (cached) return cached
    const file = this.fileOf(def, scope)
    const info: DefinitionInfo = {}
    if (file) {
      const o = this.cx.opts(def, "field", file, scope)
      if (Array.isArray(o.targets)) info.targets = o.targets.filter((t): t is string => typeof t === "string")
      readSupport(o, info, true)
    }
    this.definitions.set(def, info)
    return info
  }

  private fileOf(def: MField, scope: string): MFile | undefined {
    if (def.fqn) return this.cx.symbols.extensionByName.get(def.fqn)?.file
    return this.cx.symbols.message(scope)?.file
  }

  /** `feature_support` of an enum value definition (feature values introduced or removed in an edition). */
  private valueSupport(enumFqn: string, value: string): DefinitionInfo | undefined {
    const e = this.cx.symbols.enum(enumFqn)
    const v = e?.values.find((x) => x.name === value)
    if (!e || !v) return undefined
    const cached = this.definitions.get(v)
    if (cached) return cached
    const o = this.cx.opts(v, "enumValue", e.file, parentScope(e.fqn))
    const info: DefinitionInfo = {}
    readSupport(o, info, false)
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
      this.cx.issue(
        "invalid-definition",
        `\`${name}\` is not supported in ${syntaxName(file.syntax)}: it was introduced in ${editionLabel(info.introduced as string)}`,
        file,
        pointer,
        loc,
      )
    else if (removed !== undefined && edition >= removed)
      this.cx.issue(
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
    const source = this.cx.sources.get(file.path) ?? ""
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
  check(holder: MOptionHolder, kind: OptionsKind, file: MFile, scope: string, pointer: string) {
    if (!holder.raw.length) return
    const options = this.cx.opts(holder, kind, file, scope)
    const keys = Object.keys(holder.optionLocs)
    const def = this.cx.symbols.message(OPTIONS_MESSAGE[kind])
    if (!def) return
    let locs: Map<string, Location> | undefined
    const locOf = (path: string, top: string) =>
      (locs ??= this.statementLocs(holder, file)).get(path) ?? holder.optionLocs[top]
    for (const key of keys) {
      const field = def.fields.find((f) => f.name === key) ?? this.extensionField(key, def.fqn)
      if (!field) continue
      const at = `${pointer}/options/${ptr(key)}`
      const loc = holder.optionLocs[key]
      const info = this.definition(field, field.fqn ? (this.cx.symbols.extensionByName.get(key)?.scope ?? "") : def.fqn)
      if (info.targets?.length && !info.targets.includes(TARGET[kind]))
        this.cx.issue("invalid-option", `option \`${key}\` cannot be set on ${KIND_NAME[kind]}`, file, at, loc)
      this.support(key, info, file, at, loc)
      if (key === "ctype" && editionNumber(file.syntax) >= EDITION_NUMBERS.EDITION_2024)
        this.cx.issue(
          "invalid-definition",
          `\`ctype\` is not supported in ${syntaxName(file.syntax)}; use features.(pb.cpp).string_type`,
          file,
          at,
          loc,
        )
      if (key === "packed" && isEditions(file.syntax))
        this.cx.issue(
          "invalid-option",
          `\`packed\` is not supported in ${syntaxName(file.syntax)}; use features.repeated_field_encoding`,
          file,
          at,
          loc,
        )
      if (key !== "features") continue
      if (!isEditions(file.syntax)) {
        this.cx.issue("invalid-definition", `features cannot be set in ${file.syntax}`, file, at, loc)
        continue
      }
      const features = options.features
      if (isPlainObject(features))
        this.featureTree(features, "google.protobuf.FeatureSet", "features", kind, file, at, (p) => locOf(p, key))
    }
  }

  private extensionField(fqn: string, extendee: string): MField | undefined {
    const e = this.cx.symbols.extensionByName.get(fqn)
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
    const def = this.cx.symbols.message(defFqn)
    if (!def) return
    for (const [key, value] of Object.entries(tree)) {
      const field = def.fields.find((f) => f.name === key) ?? this.extensionField(key, def.fqn)
      if (!field) continue
      const here = `${path}.${key}`
      const loc = locOf(here)
      const scope = field.fqn ? (this.cx.symbols.extensionByName.get(key)?.scope ?? "") : def.fqn
      const info = this.definition(field, scope)
      if (info.targets?.length && !info.targets.includes(TARGET[kind]))
        this.cx.issue("invalid-option", `feature \`${key}\` cannot be set on ${KIND_NAME[kind]}`, file, pointer, loc)
      this.support(key, info, file, pointer, loc)
      const t = field.type
      if (t.kind === "named" && t.resolved?.kind === "message" && isPlainObject(value)) {
        this.featureTree(value, t.resolved.fqn, here, kind, file, pointer, locOf)
        continue
      }
      if (t.kind === "named" && t.resolved?.kind === "enum" && typeof value === "string") {
        const e = this.cx.symbols.enum(t.resolved.fqn)
        if (e?.values.find((v) => v.name === value)?.number === 0)
          this.cx.issue(
            "invalid-option",
            `feature \`${key}\` must be set to a known value, not ${value}`,
            file,
            pointer,
            loc,
          )
        else this.support(`${key} = ${value}`, this.valueSupport(t.resolved.fqn, value), file, pointer, loc)
        if (key === "field_presence" && value === "LEGACY_REQUIRED" && kind === "file")
          this.cx.issue(
            "invalid-option",
            "features.field_presence = LEGACY_REQUIRED cannot be set at the file level",
            file,
            pointer,
            loc,
          )
      }
    }
  }
}
