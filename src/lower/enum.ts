// Lowering of an enum: its values (with the duplicate name check), reserved numbers and names, `closed` and `jsonFormat`.

import type { ProtoApiEnum } from "../types.ts"
import type { MEnum, OptionTree } from "../model/index.ts"
import { resolveFeatures, withoutFeatureKeys } from "../features.ts"
import { ptr } from "../paths.ts"
import { enumPointer, parentScope } from "../common/names.ts"
import { hasKey, setKey } from "../common/objects.ts"
import type { LowerContext } from "./context.ts"
import {
  DEPRECATED,
  declarationOptions,
  docKeywords,
  finish,
  head,
  reservedOf,
  writeJsonFormat,
  writeReserved,
} from "./emit.ts"

/** An enum; `chain` holds the option trees of the enclosing scopes, file first. */
export const lowerEnum = (cx: LowerContext, e: MEnum, chain: OptionTree[]): ProtoApiEnum => {
  const file = e.file
  const pointer = enumPointer(e.fqn)
  const scope = parentScope(e.fqn)
  const options = { ...cx.opts(e, "enum", file, scope) }
  const features = resolveFeatures(cx.defaults(file.syntax), file.syntax, [...chain, options])
  const ann = cx.annotate("enum", e, withoutFeatureKeys(options, ["enum_type"]))
  const out = head(cx, e.name, file, ann)
  out.type = "string"
  const values: Record<string, unknown> = {}
  for (const v of e.values) {
    const vp = `${pointer}/values/${ptr(v.name)}`
    if (hasKey(values, v.name)) {
      cx.issue("duplicate-name", `enum value ${v.name} is used more than once in ${e.fqn}`, file, vp, v.locs[""])
      continue
    }
    const vo = cx.opts(v, "enumValue", file, scope)
    const va = cx.annotate("enumValue", v, withoutFeatureKeys(vo))
    const entry: Record<string, unknown> = {}
    docKeywords(entry, va)
    entry.number = v.number
    if (Object.keys(va.options).length) entry.options = va.options
    setKey(values, v.name, entry)
    finish(cx, entry, va, `enum value ${v.name}`, file, vp, v, { keys: { number: "number" }, keywords: DEPRECATED })
  }
  out.values = values
  writeReserved(cx, out, pointer, e, reservedOf(e))
  if (features.enum_type === "CLOSED") out.closed = true
  writeJsonFormat(cx, out, pointer, features, options, e)
  declarationOptions(out, ann, e.visibility)
  finish(cx, out, ann, `enum ${e.fqn}`, file, pointer, e, { keywords: DEPRECATED })
  return out as unknown as ProtoApiEnum
}
