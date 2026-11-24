// The emission set of a lowering: the files in import order, which files are emitted in full (`BuildOptions.imports`) and the messages and enums they reach.

import type { MField, MFile, MMessage, MTypeRef } from "../model.ts"
import type { LowerContext } from "./context.ts"

export class Emission {
  /** the build's files reachable from the entries (sorted), each after the files it imports */
  readonly files: MFile[] = []
  /** fqns of the messages emitted: those of the files emitted in full and those their fields, extensions and methods reach */
  readonly messages = new Set<string>()
  readonly enums = new Set<string>()
  private readonly cx: LowerContext

  constructor(cx: LowerContext) {
    this.cx = cx
    this.orderFiles()
    this.computeEmission()
  }

  /** The file's declarations are emitted in full (`BuildOptions.imports`): entries, user files in "user", all in "all". */
  full(file: MFile): boolean {
    const mode = this.cx.input.imports
    return mode === "all" || this.cx.entry.has(file.path) || (mode === "user" && !file.bundled)
  }

  private orderFiles() {
    const byPath = this.cx.input.symbols.files
    const visited = new Set<string>()
    const visit = (path: string) => {
      if (visited.has(path)) return
      visited.add(path)
      const f = byPath.get(path)
      if (!f) return
      for (const imp of f.imports) visit(imp.path)
      this.files.push(f)
    }
    for (const e of [...this.cx.input.entry].sort()) visit(e)
  }

  private computeEmission() {
    const symbols = this.cx.input.symbols
    const queue: string[] = []
    const addMsg = (m: MMessage) => {
      if (m.mapEntry || this.messages.has(m.fqn)) return
      this.messages.add(m.fqn)
      queue.push(m.fqn)
    }
    const addRef = (t: MTypeRef | undefined) => {
      if (t?.kind !== "named" || !t.resolved) return
      if (t.resolved.kind === "enum") this.enums.add(t.resolved.fqn)
      else {
        const m = symbols.message(t.resolved.fqn)
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
      for (const e of m.enums) this.enums.add(e.fqn)
      for (const x of m.extensions) fieldRefs(x)
    }
    for (const f of this.files) {
      if (!this.full(f)) continue
      for (const m of f.messages) walk(m)
      for (const e of f.enums) this.enums.add(e.fqn)
      for (const x of f.extensions) fieldRefs(x)
      for (const s of f.services) {
        for (const m of s.methods) {
          addRef(m.input)
          addRef(m.output)
        }
      }
    }
    while (queue.length) {
      const m = symbols.message(queue.pop() as string)
      if (!m) continue
      for (const f of m.fields) fieldRefs(f)
    }
  }
}
