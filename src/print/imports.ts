// What one printed file may use: the files its written imports (and their public re-exports) make visible, and the imports the printer adds for types and options that are not visible yet.

import type { ProtoApiFile } from "../types.ts"
import type { Oracle } from "./oracle.ts"

/** The visibility of declarations in one printed file. Type references and option references share this one set: every written import counts, whatever its flag (`import option` included), plus the public imports reachable from them. */
export class ImportTracker {
  /** imports added for declarations the written imports do not make visible, in the order they were needed */
  readonly added: string[] = []
  private readonly visible: Set<string>
  private readonly oracle: Oracle

  constructor(oracle: Oracle, files: Record<string, ProtoApiFile>, path: string, file: ProtoApiFile) {
    this.oracle = oracle
    this.visible = new Set<string>([path])
    const visit = (p: string) => {
      const f = files[p]
      const pub = f ? (f.imports ?? []).filter((i) => f.importFlags?.[i] === "public") : oracle.publicImports(p)
      for (const i of pub) {
        if (this.visible.has(i)) continue
        this.visible.add(i)
        visit(i)
      }
    }
    for (const i of file.imports ?? []) {
      this.visible.add(i)
      visit(i)
    }
  }

  /** Whether the declarations of `path` are visible to the file (written or added imports). */
  sees(path: string): boolean {
    return this.visible.has(path)
  }

  /** Make `path` available to this file: nothing when a written import already does, else an added import. */
  need(path: string | undefined): void {
    if (!path || this.visible.has(path)) return
    this.visible.add(path)
    this.added.push(path)
    for (const p of this.oracle.publicImports(path)) this.visible.add(p)
  }

  /** Whether the file that declares option `optionKey` is visible (the option can be printed without a new import). */
  available(optionKey: string): boolean {
    const f = this.oracle.extensionFile(optionKey)
    return !!f && this.visible.has(f)
  }
}
