// Symbol table and protoc's name lookup (design §5.3, `DescriptorBuilder::LookupSymbol` + `FindSymbol`).

import type { MEnum, MField, MFile, MMessage, MService } from "./model/index.ts"
import { defaultVisibility } from "./features.ts"
import { qualify } from "./common/names.ts"

export type SymbolKind =
  | "package"
  | "message"
  | "enum"
  | "service"
  | "extension"
  | "field"
  | "enumValue"
  | "method"
  | "oneof"

export interface SymbolEntry {
  kind: SymbolKind
  fqn: string
  file?: MFile
  node?: MMessage | MEnum | MService | MField
  /** edition 2024+: visible only within its own file (explicit `local`, or the file's default symbol visibility) */
  local?: boolean
  /** packages: the files that declare this package or one of its sub-packages */
  files?: Set<string>
}

const AGGREGATE = new Set<SymbolKind>(["package", "message", "enum", "service"])
const TYPE = new Set<SymbolKind>(["message", "enum"])

export interface Duplicate {
  fqn: string
  first: SymbolEntry
  second: SymbolEntry
}

/** Where a name is looked up from: the referring file, and whether the reference is an option name or value (types
 *  and extensions of `import option` files are visible there only, validation decision 18). */
export interface LookupFrom {
  file: MFile
  options?: boolean
}

export interface LookupResult {
  /** the symbol the name resolves to */
  found?: SymbolEntry
  /** the first symbol skipped because it is not visible from the referring file (for the issue message) */
  hidden?: SymbolEntry
  /** the first symbol skipped because it is of the wrong kind (for the issue message) */
  wrongKind?: SymbolEntry
}

/** A message or enum visible only within its own file: its `export` / `local` keyword, else the file default. */
const isLocal = (explicit: "export" | "local" | undefined, nested: boolean, defaults: string): boolean => {
  if (explicit) return explicit === "local"
  if (defaults === "EXPORT_TOP_LEVEL") return nested
  return defaults === "LOCAL_ALL" || defaults === "STRICT"
}

export class SymbolTable {
  readonly symbols = new Map<string, SymbolEntry>()
  /** top-level enums by package (their values are members of the package scope) */
  private readonly topEnums = new Map<string, MEnum[]>()
  /** scope fqn -> member name -> entry (see `member`) */
  private readonly memberIndex = new Map<string, Map<string, SymbolEntry>>()
  readonly duplicates: Duplicate[] = []
  readonly files = new Map<string, MFile>()
  /** extendee fqn -> extension fields */
  readonly extensionsByExtendee = new Map<string, MField[]>()
  /** extension fqn -> field */
  readonly extensionByName = new Map<string, { field: MField; fqn: string; file: MFile; scope: string }>()
  private visibleCache = new Map<string, Set<string>>()
  private optionCache = new Map<string, Set<string>>()

  constructor(files: MFile[]) {
    for (const file of files) this.addFile(file)
  }

  private add(entry: SymbolEntry) {
    const prev = this.symbols.get(entry.fqn)
    if (prev) {
      if (prev.kind === "package" && entry.kind === "package") {
        for (const f of entry.files ?? []) prev.files?.add(f)
        return
      }
      this.duplicates.push({ fqn: entry.fqn, first: prev, second: entry })
      return
    }
    this.symbols.set(entry.fqn, entry)
  }

  private addFile(file: MFile) {
    if (this.files.has(file.path)) return
    this.files.set(file.path, file)
    if (file.package) {
      const parts = file.package.split(".")
      for (let i = 1; i <= parts.length; i++)
        this.add({ kind: "package", fqn: parts.slice(0, i).join("."), files: new Set([file.path]) })
    }
    const scope = file.package
    const defaults = defaultVisibility(file)
    for (const m of file.messages) this.addMessage(m, file, defaults, false)
    for (const e of file.enums) this.addEnum(e, file, defaults, false)
    for (const x of file.extensions) this.addExtension(x, scope, file)
    for (const s of file.services) {
      this.add({ kind: "service", fqn: s.fqn, file, node: s })
    }
    if (file.enums.length) {
      let list = this.topEnums.get(scope)
      if (!list) this.topEnums.set(scope, (list = []))
      list.push(...file.enums)
    }
  }

  private addMessage(m: MMessage, file: MFile, defaults: string, nested: boolean) {
    this.add({ kind: "message", fqn: m.fqn, file, node: m, local: isLocal(m.visibility, nested, defaults) })
    for (const n of m.nested) this.addMessage(n, file, defaults, true)
    for (const e of m.enums) this.addEnum(e, file, defaults, true)
    for (const x of m.extensions) this.addExtension(x, m.fqn, file)
  }

  private addEnum(e: MEnum, file: MFile, defaults: string, nested: boolean) {
    this.add({ kind: "enum", fqn: e.fqn, file, node: e, local: isLocal(e.visibility, nested, defaults) })
  }

  /**
   * Fields, oneofs, enum values (siblings of their enum, C++ scoping) and methods of a scope. protoc's type and
   * extension lookups skip them and continue outward, so they are not in `symbols`; only `any` lookups (option names,
   * where protoc and buf take the first symbol of any kind) see them. Indexed per scope on first use.
   */
  member(fqn: string): SymbolEntry | undefined {
    const dot = fqn.lastIndexOf(".")
    const scope = dot < 0 ? "" : fqn.slice(0, dot)
    let index = this.memberIndex.get(scope)
    if (!index) {
      index = new Map()
      const add = (kind: SymbolKind, name: string, file: MFile | undefined) => {
        if (!index?.has(name)) index?.set(name, { kind, fqn: qualify(scope, name), file })
      }
      const owner = scope ? this.symbols.get(scope) : undefined
      if (owner?.kind === "message") {
        const m = owner.node as MMessage
        for (const f of m.fields) add("field", f.name, m.file)
        for (const o of m.oneofs) add("oneof", o.name, m.file)
        for (const e of m.enums) for (const v of e.values) add("enumValue", v.name, m.file)
      } else if (owner?.kind === "service") {
        const s = owner.node as MService
        for (const m of s.methods) add("method", m.name, s.file)
      } else if (!owner || owner.kind === "package") {
        for (const e of this.topEnums.get(scope) ?? []) for (const v of e.values) add("enumValue", v.name, e.file)
      }
      this.memberIndex.set(scope, index)
    }
    return index.get(dot < 0 ? fqn : fqn.slice(dot + 1))
  }

  private addExtension(x: MField, scope: string, file: MFile) {
    const fqn = qualify(scope, x.name)
    x.fqn = fqn
    this.add({ kind: "extension", fqn, file, node: x })
    this.extensionByName.set(fqn, { field: x, fqn, file, scope })
  }

  /** Register an extension under its resolved extendee (after extendee resolution). */
  indexExtension(x: MField, extendee: string) {
    let list = this.extensionsByExtendee.get(extendee)
    if (!list) this.extensionsByExtendee.set(extendee, (list = []))
    list.push(x)
  }

  get(fqn: string): SymbolEntry | undefined {
    return this.symbols.get(fqn)
  }

  message(fqn: string): MMessage | undefined {
    const s = this.symbols.get(fqn)
    return s?.kind === "message" ? (s.node as MMessage) : undefined
  }

  enum(fqn: string): MEnum | undefined {
    const s = this.symbols.get(fqn)
    return s?.kind === "enum" ? (s.node as MEnum) : undefined
  }

  /** Files whose public imports `path` re-exports, transitively, added to `out`. */
  private addPublic(path: string, out: Set<string>) {
    const f = this.files.get(path)
    if (!f) return
    for (const imp of f.imports) {
      if (imp.flag === "public" && !out.has(imp.path)) {
        out.add(imp.path)
        this.addPublic(imp.path, out)
      }
    }
  }

  /**
   * Files whose symbols `file` may reference (protoc's `dependencies_`): itself, its imports and the public imports
   * of those, transitively. `import option` files (and their public imports) count only for option names and
   * values (`options`).
   */
  visibleFiles(file: MFile, options = false): Set<string> {
    const cache = options ? this.optionCache : this.visibleCache
    const cached = cache.get(file.path)
    if (cached) return cached
    const out = new Set<string>([file.path])
    for (const imp of file.imports) {
      if (imp.flag === "option" && !options) continue
      out.add(imp.path)
      this.addPublic(imp.path, out)
    }
    cache.set(file.path, out)
    return out
  }

  /** Is `entry` visible from `from` (protoc's `FindSymbol` with enforced dependencies, plus edition 2024 `local`)?
   *  A package is visible when the referring file or one of its visible files declares it or a sub-package. */
  isVisible(entry: SymbolEntry, from: LookupFrom): boolean {
    const visible = this.visibleFiles(from.file, from.options)
    if (entry.kind === "package") {
      for (const f of entry.files ?? []) if (visible.has(f)) return true
      return false
    }
    if (!entry.file) return true
    if (entry.local && entry.file.path !== from.file.path) return false
    return visible.has(entry.file.path)
  }

  /**
   * protoc's lookup: a name starting with `.` is fully qualified; otherwise the first component is looked up from
   * the innermost scope outward and the remaining components must resolve inside the first match (no backtracking).
   * `scope` is the fully qualified name of the scope the reference appears in (message, service or package).
   * Symbols outside the referring file's import closure (or `local` to another file) are not found, and the search
   * continues outward (C-1). In `type` mode a single-component name skips symbols that are not types, in `extension`
   * mode those that are not extensions; `any` takes the first symbol found.
   */
  lookup(name: string, scope: string, mode: "type" | "extension" | "any", from?: LookupFrom): LookupResult {
    const result: LookupResult = {}
    const find = (fqn: string): SymbolEntry | undefined => {
      const entry = this.symbols.get(fqn) ?? (mode === "any" ? this.member(fqn) : undefined)
      if (!entry) return undefined
      if (from && !this.isVisible(entry, from)) {
        result.hidden ??= entry
        return undefined
      }
      return entry
    }
    if (name.startsWith(".")) {
      result.found = find(name.slice(1))
      return result
    }
    const dot = name.indexOf(".")
    const first = dot < 0 ? name : name.slice(0, dot)
    let current = scope
    while (true) {
      const found = find(qualify(current, first))
      if (!found && dot >= 0 && (!result.hidden || result.hidden.kind === "package")) {
        // a hidden first component (e.g. a package declared only by a file that is not imported): name the symbol the
        // whole name would have resolved to in the issue message
        const whole = this.symbols.get(qualify(current, name))
        if (whole && from && !this.isVisible(whole, from)) result.hidden = whole
      }
      if (found) {
        if (dot >= 0) {
          if (AGGREGATE.has(found.kind)) {
            result.found = find(qualify(current, name))
            return result
          }
          // not an aggregate: keep searching outward
        } else if (mode === "type" && !TYPE.has(found.kind)) result.wrongKind ??= found
        else if (mode === "extension" && found.kind !== "extension") result.wrongKind ??= found
        else {
          result.found = found
          return result
        }
      }
      if (!current) return result
      const i = current.lastIndexOf(".")
      current = i < 0 ? "" : current.slice(0, i)
    }
  }

  /** Why `entry` is not visible from `from`, for issue messages. */
  hiddenReason(entry: SymbolEntry, from: LookupFrom): string {
    const kind =
      entry.kind === "enum" ? "an enum type" : entry.kind === "message" ? "a message type" : `a ${entry.kind}`
    if (entry.local && entry.file && entry.file.path !== from.file.path)
      return `${entry.fqn} is ${kind} that is not exported from ${entry.file.path}`
    if (!from.options && entry.file && this.visibleFiles(from.file, true).has(entry.file.path))
      return `${entry.fqn} is defined in ${entry.file.path}, which is only imported for use in options`
    return `${entry.fqn} is defined in ${entry.file?.path ?? "a file"}, which is not imported`
  }
}

/** The kind of a symbol as written in issue messages. */
export const kindName = (kind: SymbolKind): string => (kind === "enumValue" ? "enum value" : kind)

/** Best-effort key for an unresolved name (design §5.3): dotted names as written without the leading dot, simple
 *  names qualified with the current package. */
export const unresolvedKey = (name: string, pkg: string): string => {
  if (name.startsWith(".")) return name.slice(1)
  if (name.includes(".")) return name
  return qualify(pkg, name)
}
