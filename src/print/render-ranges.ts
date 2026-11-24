// `reserved` statements of messages and enums, and the `extensions` ranges of a message with their options and declarations.

import type { ProtoApiMessage } from "../types.ts"
import { FIELD_NUMBER_MAX, INT32_MAX, MESSAGE_SET_NUMBER_MAX } from "../common/limits.ts"
import { isPlainObject } from "../common/objects.ts"
import type { FilePrinter } from "./file-printer.ts"
import { quote } from "./literals.ts"
import { aggregate, optionAssignments } from "./option-values.ts"

type Obj = Record<string, unknown>

export const printReserved = (p: FilePrinter, depth: number, r: unknown, isEnum: boolean) => {
  if (!isPlainObject(r)) return
  const max = isEnum ? INT32_MAX : FIELD_NUMBER_MAX
  const numbers = Array.isArray(r.numbers) ? (r.numbers as [number, number][]) : []
  if (numbers.length)
    p.out.emit(
      depth,
      `reserved ${numbers.map(([a, b]) => (a === b ? `${a}` : b === max ? `${a} to max` : `${a} to ${b}`)).join(", ")};`,
    )
  const names = Array.isArray(r.names) ? (r.names as string[]) : []
  if (names.length) p.out.emit(depth, `reserved ${names.map((n) => (p.editions ? n : quote(n))).join(", ")};`)
}

export const printExtensionRanges = (p: FilePrinter, depth: number, m: ProtoApiMessage) => {
  const oracle = p.ctx.oracle
  const decls = isPlainObject(m.options)
    ? (m.options.extension_declarations as Record<string, unknown[]> | undefined)
    : undefined
  // extensionOptions (F-1): each range with options is printed on its own, the rest of a merged interval around it
  const rangeOpts = [...(Array.isArray(m.extensionOptions) ? m.extensionOptions : [])].sort(
    (x, y) => x.range[0] - y.range[0],
  )
  const messageSet = isPlainObject(m.options) && m.options.message_set_wire_format === true
  const printRange = (a: number, b: number, opts: string[]) => {
    const max = b === FIELD_NUMBER_MAX || (messageSet && b === MESSAGE_SET_NUMBER_MAX)
    const range = a === b ? `${a}` : max ? `${a} to max` : `${a} to ${b}`
    p.out.emit(depth, `extensions ${range}${opts.length ? ` [${opts.join(", ")}]` : ""};`)
  }
  const rangeOptions = (o: unknown) => optionAssignments(oracle, p.imports, o as Obj, "extensionRange")
  for (const [a, b] of Array.isArray(m.extensions) ? m.extensions : []) {
    const d = decls?.[`${a}-${b}`]
    const inside = rangeOpts.filter((e) => e.range[0] >= a && e.range[1] <= b)
    if (d) {
      const own = inside.find((e) => e.range[0] === a && e.range[1] === b)
      printRange(a, b, [
        ...(Array.isArray(d) ? d : []).map(
          (x) => `declaration = ${aggregate(oracle, x as Obj, "google.protobuf.ExtensionRangeOptions.Declaration")}`,
        ),
        ...(own ? rangeOptions(own.options) : []),
      ])
      continue
    }
    let next = a
    for (const e of inside) {
      if (e.range[0] > next) printRange(next, e.range[0] - 1, [])
      printRange(e.range[0], e.range[1], rangeOptions(e.options))
      next = e.range[1] + 1
    }
    if (next <= b) printRange(next, b, [])
  }
}
