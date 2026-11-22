/**
 * Offset → line / column conversion (not from pbkit; replaces pbkit's linear `offsetToColRow`).
 *
 * - Offsets are JavaScript string indices, which is what every AST node's `start` / `end` holds.
 * - Lines and columns are zero-based. Columns count UTF-16 code units (editors, LSP and protoc's
 *   `SourceCodeInfo` spans use the same unit for BMP text; a character outside the BMP counts as two).
 * - Lines are split on `\n` only. A `\r` (from CRLF line endings) is an ordinary column character at the end of
 *   its line: in `"a\r\nb"`, offset 1 (`\r`) is line 0 column 1 and offset 3 (`b`) is line 1 column 0.
 * - Offsets are clamped to `[0, text.length]`; `text.length` (end of input) is a valid position.
 *
 * With `tabWidth` (the text producer's columns, validation decision D-A), columns are counted the way buf records
 * them in `SourceCodeInfo`: a tab advances to the next multiple of `tabWidth`; `\r`, `\f`, `\v` and a byte order mark
 * at the start of the text have no width (so a CR-only file is one line, as in buf).
 */

export interface Position {
  /** Zero-based line number. */
  line: number
  /** Zero-based column in UTF-16 code units. */
  column: number
}

export interface LineIndex {
  /** Number of lines (a text without `\n` has one line). */
  readonly lineCount: number
  toPosition(offset: number): Position
}

export interface LineIndexOptions {
  /** Expand tabs to this width and give `\r`, `\f`, `\v` and a leading BOM no width (buf's columns). */
  tabWidth?: number
}

/** Characters whose column width is not one UTF-16 unit in buf's counting: tab, `\v`, `\f`, `\r`, BOM. */
const SPECIAL = /[\t\v\f\r﻿]/g

export function createLineIndex(text: string, options: LineIndexOptions = {}): LineIndex {
  const starts: number[] = [0]
  let i = text.indexOf("\n")
  while (i !== -1) {
    starts.push(i + 1)
    i = text.indexOf("\n", i + 1)
  }
  const length = text.length
  const tabWidth = options.tabWidth
  /** per line: offset of its first special character, or -1 (filled lazily; undefined = not computed yet) */
  const firstSpecial: (number | undefined)[] = tabWidth === undefined ? [] : new Array(starts.length)
  // the last expanded position: consecutive lookups on one long line continue from it instead of rescanning
  let lastLine = -1
  let lastOffset = 0
  let lastColumn = 0

  const lineEnd = (line: number) => (line + 1 < starts.length ? starts[line + 1] - 1 : length)

  // offsets of every special character, ascending (usually none)
  const specials: number[] = []
  if (tabWidth !== undefined) {
    SPECIAL.lastIndex = 0
    for (let m = SPECIAL.exec(text); m; m = SPECIAL.exec(text)) specials.push(m.index)
  }

  const special = (line: number): number => {
    let f = firstSpecial[line]
    if (f === undefined) {
      // first special offset >= the line start
      const start = starts[line]
      let lo = 0
      let hi = specials.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (specials[mid] < start) lo = mid + 1
        else hi = mid
      }
      f = lo < specials.length && specials[lo] < lineEnd(line) ? specials[lo] : -1
      firstSpecial[line] = f
    }
    return f
  }

  const width = tabWidth ?? 1
  const advance = (column: number, from: number, to: number): number => {
    for (let k = from; k < to; k++) {
      const c = text.charCodeAt(k)
      if (c === 9) column += width - (column % width)
      else if (c === 11 || c === 12 || c === 13 || (c === 0xfeff && k === 0)) {
        // no width
      } else column++
    }
    return column
  }
  /** columns at every CHECKPOINT-th offset of long special lines, so a lookup never scans more than that */
  const CHECKPOINT = 256
  const checkpoints = new Map<number, number[]>()

  const expanded = (line: number, o: number): number => {
    let from = starts[line]
    let column = 0
    if (line === lastLine && o >= lastOffset && o - lastOffset < CHECKPOINT) {
      from = lastOffset
      column = lastColumn
    } else if (o - from >= CHECKPOINT) {
      let marks = checkpoints.get(line)
      if (!marks) {
        marks = [0]
        const end = lineEnd(line)
        let col = 0
        for (let k = from; k + CHECKPOINT <= end; k += CHECKPOINT) marks.push((col = advance(col, k, k + CHECKPOINT)))
        checkpoints.set(line, marks)
      }
      const m = Math.min(Math.floor((o - from) / CHECKPOINT), marks.length - 1)
      column = marks[m]
      from += m * CHECKPOINT
    }
    column = advance(column, from, o)
    lastLine = line
    lastOffset = o
    lastColumn = column
    return column
  }

  return {
    lineCount: starts.length,
    toPosition(offset: number): Position {
      const o = offset < 0 ? 0 : offset > length ? length : offset
      // binary search: last line start <= o
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1
        if (starts[mid] <= o) lo = mid
        else hi = mid - 1
      }
      if (specials.length) {
        const f = special(lo)
        if (f !== -1 && o > f) return { line: lo, column: expanded(lo, o) }
      }
      return { line: lo, column: o - starts[lo] }
    },
  }
}
