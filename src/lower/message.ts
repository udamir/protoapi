// Lowering of a message: its fields (with the duplicate and reserved checks of a message), oneofs, reserved numbers and names, extension ranges and their options.

import type { ProtoApiField, ProtoApiMessage } from "../types.ts"
import type { MExtensionRange, MMessage, OptionTree } from "../model.ts"
import { resolveFeatures, withoutFeatureKeys } from "../features.ts"
import { defaultJsonName } from "../values/json-name.ts"
import { ptr } from "../paths.ts"
import { MESSAGE_SET_NUMBER_MAX } from "../common/limits.ts"
import { messagePointer, parentScope } from "../common/names.ts"
import type { LowerContext } from "./context.ts"
import {
  DEPRECATED,
  type Reserved,
  declarationOptions,
  docKeywords,
  finish,
  head,
  mergeRanges,
  reservedOf,
  writeJsonFormat,
  writeReserved,
} from "./emit.ts"
import { lowerField } from "./field.ts"

/** Field names by field name and by JSON name (a field name wins), for `openapiv2_schema.json_schema.required`. */
const fieldNames = (m: MMessage): Map<string, string> => {
  const byName = new Map<string, string>()
  for (const f of m.fields) byName.set(f.name, f.name)
  for (const f of m.fields) {
    const json = f.jsonName ?? defaultJsonName(f.name)
    if (!byName.has(json)) byName.set(json, f.name)
  }
  return byName
}

/** `properties`: the fields, with the duplicate name and number checks and the reserved number and name check. */
const lowerProperties = (
  cx: LowerContext,
  m: MMessage,
  inner: OptionTree[],
  pointer: string,
  schemaRequired: Set<string>,
  reserved: Reserved,
): Record<string, ProtoApiField> => {
  const file = m.file
  const properties: Record<string, ProtoApiField> = {}
  const seenNumbers = new Map<number, string>()
  for (const f of m.fields) {
    const fp = `${pointer}/properties/${ptr(f.name)}`
    if (f.name in properties) {
      cx.issue("duplicate-name", `field name ${f.name} is used more than once in ${m.fqn}`, file, fp, f.locs[""])
      continue
    }
    const oneof = f.oneof ? m.oneofs.find((o) => o.name === f.oneof) : undefined
    properties[f.name] = lowerField(
      cx,
      f,
      file,
      inner,
      m.fqn,
      fp,
      oneof,
      false,
      schemaRequired.has(f.name) ? m : undefined,
    )
    if (seenNumbers.has(f.number))
      cx.issue(
        "duplicate-number",
        `field number ${f.number} is used by ${seenNumbers.get(f.number)} and ${f.name}`,
        file,
        fp,
        f.locs.number ?? f.locs[""],
      )
    else seenNumbers.set(f.number, f.name)
    if (reserved.numbers.some(([a, b]) => f.number >= a && f.number <= b) || reserved.names.includes(f.name))
      cx.issue(
        "reserved-conflict",
        `field ${f.name} = ${f.number} uses a reserved number or name`,
        file,
        fp,
        f.locs[""],
      )
  }
  return properties
}

/** `oneofs`: the documentation, options and annotation conflicts of each oneof. */
const lowerOneofs = (cx: LowerContext, m: MMessage, pointer: string): Record<string, Record<string, unknown>> => {
  const file = m.file
  const oneofs: Record<string, Record<string, unknown>> = {}
  for (const o of m.oneofs) {
    const op = `${pointer}/oneofs/${ptr(o.name)}`
    const oo = cx.opts(o, "oneof", file, parentScope(m.fqn))
    const oa = cx.annotate("oneof", o, withoutFeatureKeys(oo))
    const entry: Record<string, unknown> = {}
    // A-4: a `@Deprecated` tag or `Deprecated:` line on a oneof (OneofOptions has no `deprecated`)
    docKeywords(entry, oa)
    if (Object.keys(oa.options).length) entry.options = oa.options
    oneofs[o.name] = entry
    finish(cx, entry, oa, `oneof ${o.name}`, file, op, o, {})
  }
  return oneofs
}

/**
 * Extension ranges: ranges carrying declarations are kept apart; other range options -> extensionOptions (F-1). Writes `extensions` and `extensionOptions` with their source map entries and pending issues, and returns the declarations by range (`"start-end"`).
 */
const lowerExtensionRanges = (
  cx: LowerContext,
  m: MMessage,
  out: Record<string, unknown>,
  pointer: string,
  messageSet: boolean,
): Record<string, unknown> => {
  const file = m.file
  const plain: [number, number][] = []
  const declarations: Record<string, unknown> = {}
  const rangeOptions: { range: [number, number]; options: OptionTree; holder: MExtensionRange }[] = []
  const rangesWithout: MExtensionRange[] = []
  for (const r of m.extensionRanges) {
    // protoc: `max` in a message set is 2147483646 instead of 536870911
    if (r.toMax && messageSet) r.end = MESSAGE_SET_NUMBER_MAX
    const ro = cx.opts(r, "extensionRange", file, parentScope(m.fqn))
    if (ro.declaration !== undefined) declarations[`${r.start}-${r.end}`] = ro.declaration
    const other = withoutFeatureKeys(ro)
    delete other.declaration
    if (Object.keys(other).length) rangeOptions.push({ range: [r.start, r.end], options: other, holder: r })
    else rangesWithout.push(r)
    plain.push([r.start, r.end])
  }
  if (plain.length) {
    const declared = new Set(Object.keys(declarations))
    const merged = mergeRanges(plain.filter(([a, b]) => !declared.has(`${a}-${b}`)))
    const kept = plain.filter(([a, b]) => declared.has(`${a}-${b}`))
    const extensions = [...merged, ...kept].sort((a, b) => a[0] - b[0])
    out.extensions = extensions
    cx.sourceMap.map(`${pointer}/extensions`, m.locs.extensions)
    cx.sourceMap.mapExtensionRanges(pointer, m.extensionRanges, extensions)
  }
  rangeOptions.sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1])
  if (rangeOptions.length) out.extensionOptions = rangeOptions.map((e) => ({ range: e.range, options: e.options }))
  rangeOptions.forEach((e, i) => {
    // the statement of the range and its option statements (validation L-2)
    cx.sourceMap.map(`${pointer}/extensionOptions/${i}`, e.holder.loc)
    cx.sourceMap.mapOptions(`${pointer}/extensionOptions/${i}`, e.holder, e.options)
  })
  rangeOptions.forEach((e, i) => cx.flush(e.holder, `${pointer}/extensionOptions/${i}`, file, e.holder.loc))
  for (const r of rangesWithout) cx.flush(r, `${pointer}/extensions`, file, r.loc)
  return declarations
}

/** A message; `chain` holds the option trees of the enclosing scopes, file first. */
export const lowerMessage = (cx: LowerContext, m: MMessage, chain: OptionTree[]): ProtoApiMessage => {
  const file = m.file
  const pointer = messagePointer(m.fqn)
  const options = { ...cx.opts(m, "message", file, parentScope(m.fqn)) }
  const inner = [...chain, options]
  const features = resolveFeatures(cx.defaults(file.syntax), file.syntax, inner)
  // the message's own annotations first: openapiv2_schema.json_schema.required names fields (A-13)
  const byName = fieldNames(m)
  const ann = cx.annotate("message", m, withoutFeatureKeys(options), { fieldOf: (name) => byName.get(name) })
  const reserved = reservedOf(m)
  const properties = lowerProperties(cx, m, inner, pointer, new Set(ann.requiredFields ?? []), reserved)
  const out = head(cx, m.name, file, ann)
  out.type = "object"
  out.properties = properties
  if (m.oneofs.length) out.oneofs = lowerOneofs(cx, m, pointer)
  writeReserved(cx, out, pointer, m, reserved)
  const declarations = lowerExtensionRanges(cx, m, out, pointer, options.message_set_wire_format === true)
  writeJsonFormat(cx, out, pointer, features, options, m)
  declarationOptions(
    out,
    ann,
    m.visibility,
    Object.keys(declarations).length ? { extension_declarations: declarations } : undefined,
  )
  finish(cx, out, ann, `message ${m.fqn}`, file, pointer, m, { keywords: DEPRECATED })
  return out as unknown as ProtoApiMessage
}
