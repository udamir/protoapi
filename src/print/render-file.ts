// One printed file: the declarations (top-level messages with file-level extend blocks, enums, services), then the header (description, syntax, package, written and added imports, file options).

import { getKey, isPlainObject } from "../common/objects.ts"
import type { FilePrinter } from "./file-printer.ts"
import { quote } from "./literals.ts"
import { optionAssignments } from "./option-values.ts"
import { fileText } from "./writer.ts"
import { printScope } from "./render-message.ts"
import { printEnum } from "./render-enum.ts"
import { printService } from "./render-service.ts"

type Obj = Record<string, unknown>

/** The whole file. */
export const renderFile = (p: FilePrinter): string => {
  const { doc, oracle, indent } = p.ctx
  const { file, path, syntax } = p
  // declarations: top-level messages (and wrappers) with file-level extend blocks in order, enums, services
  printScope(p, 0, file.package ?? "", p.layout.topLevel())
  for (const [fqn] of Object.entries(doc.components?.enums ?? {})) {
    if (!p.layout.has(fqn) || p.layout.parentMessage(fqn) !== undefined) continue
    printEnum(p, 0, fqn)
  }
  for (const [fqn, s] of Object.entries(doc.services ?? {})) {
    if (!p.layout.has(fqn) || !isPlainObject(s)) continue
    printService(p, fqn, s)
  }
  const body = p.out.take()
  // file options last (they may need imports too)
  const fileOpts = optionAssignments(oracle, p.imports, file.options as Obj | undefined, "file")
  const header: string[] = []
  if (typeof file.description === "string" && file.description) {
    for (const l of file.description.split("\n")) header.push(l ? `// ${l}` : "//")
    header.push("")
  }
  header.push(syntax === "proto2" || syntax === "proto3" ? `syntax = "${syntax}";` : `edition = ${quote(syntax)};`)
  if (file.package) header.push(`package ${file.package};`)
  const written = [...(file.imports ?? [])]
  for (const i of p.imports.added) if (i !== path && !written.includes(i)) written.push(i)
  const flagOf = (i: string) => (p.imports.upgraded.has(i) ? undefined : getKey(file.importFlags, i))
  // `import option` comes after the other imports, so added and upgraded imports print before the option imports
  const imports = [...written.filter((i) => flagOf(i) !== "option"), ...written.filter((i) => flagOf(i) === "option")]
  if (imports.length) header.push("")
  for (const i of imports) {
    const flag = flagOf(i)
    header.push(`import ${flag ? `${flag} ` : ""}${quote(i)};`)
  }
  if (fileOpts.length) header.push("")
  for (const l of fileOpts) header.push(`option ${l};`)
  header.push("")
  return fileText(header, body, indent)
}
