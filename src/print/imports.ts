// What one printed file may use: the files its written imports (and their public re-exports) make visible, and the imports the printer adds for types and options that are not visible yet.

import type { ProtoApiFile } from "../types.ts"
import type { Oracle } from "./oracle.ts"
import { getKey } from "../common/objects.ts"

/** The visibility of declarations in one printed file, as protoc's `dependencies_` (see `SymbolTable.visibleFiles`): type references see the written imports except `import option` ones, option names and values see every written import; each with the public imports reachable from them. */
export class ImportTracker {
  /** imports added for declarations the written imports do not make visible, in the order they were needed */
  readonly added: string[] = []
  /** written `import option` files a type reference needs: they print as plain imports (buf rejects a file imported twice, so the flag is dropped instead of adding an import) */
  readonly upgraded = new Set<string>()
  /** files visible to type references */
  private readonly types: Set<string>
  /** files visible to option names and values */
  private readonly options: Set<string>
  private readonly oracle: Oracle
  private readonly files: Record<string, ProtoApiFile>
  private readonly optionImports: Set<string>

  constructor(oracle: Oracle, files: Record<string, ProtoApiFile>, path: string, file: ProtoApiFile) {
    this.oracle = oracle
    this.files = files
    this.types = new Set<string>([path])
    this.options = new Set<string>([path])
    this.optionImports = new Set((file.imports ?? []).filter((i) => getKey(file.importFlags, i) === "option"))
    for (const i of file.imports ?? []) {
      if (!this.optionImports.has(i)) this.reach(i, this.types)
      this.reach(i, this.options)
    }
  }

  /** Add `path` and the public imports reachable from it to `set`. */
  private reach(path: string, set: Set<string>): void {
    if (set.has(path)) return
    set.add(path)
    const f = getKey(this.files, path)
    const pub = f
      ? (f.imports ?? []).filter((i) => getKey(f.importFlags, i) === "public")
      : this.oracle.publicImports(path)
    for (const i of pub) this.reach(i, set)
  }

  /** Whether option definitions of `path` are visible to the file (written or added imports). */
  sees(path: string): boolean {
    return this.options.has(path)
  }

  /** Make the types of `path` available to this file: nothing when a written import already does, else the written `import option` of it loses its flag, else an added import. */
  needType(path: string | undefined): void {
    if (!path || this.types.has(path)) return
    if (this.optionImports.has(path)) this.upgraded.add(path)
    else this.added.push(path)
    this.reach(path, this.types)
    this.reach(path, this.options)
  }

  /** Make the options declared in `path` available to this file: nothing when a written import (`import option` included) already does, else an added import. */
  need(path: string | undefined): void {
    if (!path || this.options.has(path)) return
    this.added.push(path)
    this.reach(path, this.types)
    this.reach(path, this.options)
  }

  /** Whether the file that declares option `optionKey` is visible (the option can be printed without a new import). */
  available(optionKey: string): boolean {
    const f = this.oracle.extensionFile(optionKey)
    return !!f && this.options.has(f)
  }
}
