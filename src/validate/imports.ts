// Import checks of the validated files: self-imports, duplicate imports and import cycles.

import type { MFile } from "../model/index.ts"
import { filePointer } from "../common/names.ts"
import type { ValidateContext } from "./context.ts"

/** Self-imports, duplicate imports and import cycles (buf: "detected cyclic import", "file imported multiple times"). */
export const checkImports = (cx: ValidateContext, files: MFile[]) => {
  const validated = new Set(files.map((f) => f.path))
  for (const f of files) {
    const seen = new Set<string>()
    f.imports.forEach((imp, i) => {
      const pointer = `${filePointer(f.path)}/imports/${i}`
      if (imp.path === f.path) cx.issue("invalid-definition", `${f.path} imports itself`, f, pointer, imp.loc)
      else if (seen.has(imp.path))
        cx.issue("invalid-definition", `"${imp.path}" is imported more than once`, f, pointer, imp.loc)
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
    const f = cx.symbols.files.get(path)
    f?.imports.forEach((imp, i) => {
      if (imp.path === path) return
      const s = state.get(imp.path)
      if (s === 1) {
        const key = `${path}#${i}`
        if (validated.has(path) && f && !reported.has(key)) {
          reported.add(key)
          const cycle = [...stack.slice(stack.indexOf(imp.path)), imp.path].join(" -> ")
          cx.issue("invalid-definition", `import cycle: ${cycle}`, f, `${filePointer(path)}/imports/${i}`, imp.loc)
        }
      } else if (s === undefined && cx.symbols.files.has(imp.path)) visit(imp.path)
    })
    stack.pop()
    state.set(path, 2)
  }
  for (const f of files) if (!state.has(f.path)) visit(f.path)
}
