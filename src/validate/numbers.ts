// Number checks: the reserved and extension ranges of messages and enums (empty, out of range, overlapping), names reserved twice, field numbers inside extension ranges, and extension numbers against their extendee.

import type { BuildIssueCode, Location } from "../types.ts"
import type { MEnum, MField, MFile, MMessage } from "../model.ts"
import { FIELD_NUMBER_MAX, MESSAGE_SET_NUMBER_MAX } from "../common/limits.ts"
import { extensionPointer, parentScope } from "../common/names.ts"
import type { ValidateContext } from "./context.ts"

export interface Range {
  start: number
  end: number
  loc?: Location
}

/** Pairs of overlapping ranges (each later range against the furthest-reaching earlier one), O(n log n). */
const overlaps = (ranges: Range[]): [Range, Range][] => {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: [Range, Range][] = []
  let reach: Range | undefined
  for (const r of sorted) {
    if (reach && r.start <= reach.end) out.push([reach, r])
    if (!reach || r.end > reach.end) reach = r
  }
  return out
}

export const fmtRange = (r: Range) => (r.start === r.end ? `${r.start}` : `${r.start} to ${r.end}`)

const valid = (r: Range) => r.start <= r.end

/** The reserved ranges of a message or enum as written, with their locations. */
export const reservedRangesOf = (el: MMessage | MEnum): Range[] =>
  el.reservedRanges.map((r, i) => ({ start: r[0], end: r[1], loc: el.reservedLocs?.ranges[i] }))

/** The extension ranges of a message as written, with the location of the range (else of its statement). */
export const extensionRangesOf = (m: MMessage): Range[] =>
  m.extensionRanges.map((r) => ({ start: r.start, end: r.end, loc: r.rangeLoc ?? r.loc }))

/** A range whose start is after its end is empty; with `max`, a range must also lie in 1..max. */
const checkBounds = (cx: ValidateContext, file: MFile, pointer: string, r: Range, what: string, max?: number) => {
  if (r.start > r.end)
    cx.issue(
      "invalid-number",
      `${what} ${r.start} to ${r.end} is empty (the start is after the end)`,
      file,
      pointer,
      r.loc,
    )
  else if (max !== undefined && (r.start < 1 || r.end > max))
    cx.issue(
      "invalid-number",
      `${what} ${fmtRange(r)} is out of the field number range 1 to ${max}`,
      file,
      pointer,
      r.loc,
    )
}

/** Overlapping (non-empty) ranges of one kind. */
const checkOverlaps = (
  cx: ValidateContext,
  file: MFile,
  pointer: string,
  ranges: Range[],
  code: BuildIssueCode,
  what: string,
) => {
  for (const [a, b] of overlaps(ranges.filter(valid)))
    cx.issue(code, `${what} ${fmtRange(b)} overlaps ${what} ${fmtRange(a)}`, file, pointer, b.loc)
}

const checkReservedNames = (
  cx: ValidateContext,
  names: string[],
  locs: (Location | undefined)[] | undefined,
  file: MFile,
  pointer: string,
) => {
  const seen = new Set<string>()
  names.forEach((n, i) => {
    if (seen.has(n)) cx.issue("reserved-conflict", `the name ${n} is reserved more than once`, file, pointer, locs?.[i])
    seen.add(n)
  })
}

/** Reserved and extension ranges of a message (buf: "empty reserved range", "overlapping field number ranges",
 *  "field number out of range", "message field name reserved more than once"). */
export const checkMessageNumbers = (
  cx: ValidateContext,
  m: MMessage,
  file: MFile,
  mp: string,
  messageSet: boolean,
  extRanges: Range[],
) => {
  const max = messageSet ? MESSAGE_SET_NUMBER_MAX : FIELD_NUMBER_MAX
  const reserved = reservedRangesOf(m)
  for (const r of reserved) checkBounds(cx, file, `${mp}/reserved`, r, "reserved range", max)
  for (const r of extRanges) checkBounds(cx, file, `${mp}/extensions`, r, "extension range", max)
  checkOverlaps(cx, file, `${mp}/reserved`, reserved, "reserved-conflict", "reserved range")
  checkOverlaps(cx, file, `${mp}/extensions`, extRanges, "duplicate-number", "extension range")
  for (const e of extRanges.filter(valid)) {
    const r = reserved.find((x) => valid(x) && x.start <= e.end && e.start <= x.end)
    if (r)
      cx.issue(
        "reserved-conflict",
        `extension range ${fmtRange(e)} overlaps reserved range ${fmtRange(r)}`,
        file,
        `${mp}/extensions`,
        e.loc,
      )
  }
  checkReservedNames(cx, m.reservedNames, m.reservedLocs?.names, file, `${mp}/reserved`)
}

/** Reserved ranges and names of an enum: empty or overlapping ranges, names reserved more than once. */
export const checkEnumReserved = (cx: ValidateContext, e: MEnum, file: MFile, ep: string, reserved: Range[]) => {
  for (const r of reserved) checkBounds(cx, file, `${ep}/reserved`, r, "reserved range")
  checkOverlaps(cx, file, `${ep}/reserved`, reserved, "reserved-conflict", "reserved range")
  checkReservedNames(cx, e.reservedNames, e.reservedLocs?.names, file, `${ep}/reserved`)
}

/** A field number inside one of the message's extension ranges. */
export const checkFieldInExtensionRange = (
  cx: ValidateContext,
  f: MField,
  file: MFile,
  fp: string,
  extRanges: Range[],
) => {
  const inRange = extRanges.length ? extRanges.find((r) => f.number >= r.start && f.number <= r.end) : undefined
  if (inRange)
    cx.issue(
      "invalid-number",
      `field ${f.name} = ${f.number} uses a number of the extension range ${fmtRange(inRange)}`,
      file,
      fp,
      f.locs.number ?? f.locs[""],
    )
}

/** Extension numbers against the extendee's ranges and against each other (per extendee, across files). */
export const checkExtensionNumbers = (cx: ValidateContext, files: MFile[]) => {
  const validated = new Set(files.map((f) => f.path))
  for (const [extendee, list] of cx.symbols.extensionsByExtendee) {
    const target = cx.symbols.message(extendee)
    const used = new Map<number, MField>()
    for (const x of list) {
      const entry = x.fqn ? cx.symbols.extensionByName.get(x.fqn) : undefined
      const file = entry?.file
      const check = !!file && validated.has(file.path)
      const xp = extensionPointer(x.fqn ?? x.name)
      const prev = used.get(x.number)
      if (prev && check && file)
        cx.issue(
          "duplicate-number",
          `extension number ${x.number} of ${extendee} is used by ${prev.fqn ?? prev.name} and ${x.fqn ?? x.name}`,
          file,
          xp,
          x.locs.number ?? x.locs[""],
        )
      else if (!prev) used.set(x.number, x)
      if (check && file && target) {
        const setMax = cx.opts(target, "message", target.file, parentScope(target.fqn)).message_set_wire_format === true
        const inRange = target.extensionRanges.some((r) => {
          const end = r.toMax && setMax ? MESSAGE_SET_NUMBER_MAX : r.end
          return x.number >= r.start && x.number <= end
        })
        if (!inRange)
          cx.issue(
            "invalid-number",
            `extension ${x.fqn ?? x.name} = ${x.number} is outside the extension ranges of ${extendee}`,
            file,
            xp,
            x.locs.number ?? x.locs[""],
          )
      }
    }
  }
}
