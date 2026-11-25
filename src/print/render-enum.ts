// Enum declarations: comment, options, editions features, values with their options, reserved values and names.

import type { ProtoApiEnum } from "../types.ts"
import { lastSegment } from "../common/names.ts"
import { getKey, isPlainObject } from "../common/objects.ts"
import type { FilePrinter } from "./file-printer.ts"
import { elementComment } from "./comments.ts"
import { optionAssignments, withDeprecated } from "./option-values.ts"
import { enumTypeOption, jsonFormatOption } from "./feature-spelling.ts"
import { printReserved } from "./render-ranges.ts"

export const printEnum = (p: FilePrinter, depth: number, fqn: string) => {
  const { doc, oracle, tag } = p.ctx
  const out = p.out
  const e: ProtoApiEnum | undefined = getKey(doc.components?.enums, fqn)
  if (!e) return
  const name = lastSegment(fqn)
  out.comment(depth, elementComment(tag, e, name))
  const vis = isPlainObject(e.options) ? e.options.visibility : undefined
  out.emit(depth, `${vis ? `${vis} ` : ""}enum ${name} {`)
  for (const line of optionAssignments(oracle, p.imports, withDeprecated(e), "enum"))
    out.emit(depth + 1, `option ${line};`)
  if (p.editions) {
    const jsonFormat = jsonFormatOption(p.features, e.jsonFormat, false)
    if (jsonFormat) out.emit(depth + 1, jsonFormat)
    const enumType = enumTypeOption(p.features, e.closed)
    if (enumType) out.emit(depth + 1, enumType)
  }
  for (const [vn, v] of Object.entries(isPlainObject(e.values) ? e.values : {})) {
    const opts = optionAssignments(oracle, p.imports, withDeprecated(v), "enumValue")
    out.comment(depth + 1, elementComment(tag, v, undefined))
    out.emit(depth + 1, `${vn} = ${v.number}${opts.length ? ` [${opts.join(", ")}]` : ""};`)
  }
  printReserved(p, depth + 1, e.reserved, true)
  out.emit(depth, "}")
}
