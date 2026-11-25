// Number ranges and reserved names of the .proto text front end: `extensions` / `reserved` ranges and the `reserved`
// statements of messages and enums.

import type { Location } from "../../types.ts"
import type { MEnum, MMessage } from "../../model/index.ts"
import type { FieldNames, Ranges, Reserved } from "../../parser/index.ts"
import { decodeStringLiteral } from "../../values/literals.ts"
import { type Ctx, intOf, span, src } from "./context.ts"
import { checkReservedName } from "./rules.ts"

/** Ranges of a `reserved` / `extensions` statement, each with its own location. */
export interface ParsedRange {
  start: number
  end: number
  toMax: boolean
  loc?: Location
}

export const ranges = (ctx: Ctx, rangesNode: Ranges, max: number): ParsedRange[] => {
  const out: ParsedRange[] = []
  for (const r of rangesNode?.rangeOrCommas ?? []) {
    if (r.type !== "range") continue
    const start = intOf(ctx, r.rangeStart)
    let end = start
    let toMax = false
    if (r.rangeEnd) {
      toMax = r.rangeEnd.type === "max" || src(ctx, r.rangeEnd).trim() === "max"
      end = toMax ? max : intOf(ctx, r.rangeEnd)
    }
    out.push({ start, end, toMax, loc: span(ctx, r) })
  }
  return out
}

/** Reserved names of a `reserved` statement, each checked against the syntax's spelling (`checkReservedName`). */
const reservedNames = (ctx: Ctx, namesNode: FieldNames, pointer: string): { name: string; loc?: Location }[] => {
  const out: { name: string; loc?: Location }[] = []
  for (const x of namesNode.strLitOrCommas) {
    if (x.type === "comma") continue
    const quoted = x.type === "str-lit"
    const name = quoted ? decodeStringLiteral(src(ctx, x)) : src(ctx, x).trim()
    const loc = span(ctx, x)
    checkReservedName(ctx, name, quoted, loc, pointer)
    out.push({ name, loc })
  }
  return out
}

/** A `reserved` statement of a message or enum; `toMax` collects the indexes of `N to max` ranges. */
export const convertReserved = (
  ctx: Ctx,
  holder: MMessage | MEnum,
  st: Reserved,
  max: number,
  pointer: string,
  toMax: number[],
) => {
  const isRanges = st.reserved?.type === "ranges"
  if (isRanges)
    for (const range of ranges(ctx, st.reserved as Ranges, max)) {
      if (range.toMax) toMax.push(holder.reservedRanges.length)
      holder.reservedRanges.push([range.start, range.end])
      holder.reservedLocs?.ranges.push(range.loc)
    }
  else
    for (const r of reservedNames(ctx, st.reserved as FieldNames, `${pointer}/reserved`)) {
      holder.reservedNames.push(r.name)
      holder.reservedLocs?.names.push(r.loc)
    }
  const key = isRanges ? "reserved" : "reservedNames"
  if (!holder.locs[key]) {
    const l = span(ctx, st)
    if (l) holder.locs[key] = l
  }
}
