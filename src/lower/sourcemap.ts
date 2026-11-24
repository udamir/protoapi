// The source map of a lowering: JSON Pointer -> Location entries, first location wins, and the entries of one element.

import type { Location, SourceMap } from "../types.ts"
import type { Locs, MComments, MExtensionRange, MMessage, MOptionHolder } from "../model/index.ts"
import type { AnnotationResult, CommentLine } from "../conventions/types.ts"
import { OPENAPIV2_OPERATION, OPENAPIV2_SCHEMA } from "../conventions/keys.ts"
import { ptr } from "../paths.ts"
import { getKey } from "../common/objects.ts"

/** An element with options, a location and comments: what `mapElement` and `mapAnnotations` write entries for. */
export type MappedElement = MOptionHolder & { locs: Locs; comments: MComments }

/** What an element adds to its entries besides its own location, its annotations and its options (see `mapElement`). */
export interface ElementEntries {
  /** document sub-pointer -> key of the element's `locs` (`number: "number"`) */
  keys?: Record<string, string>
  /** keyword -> the option of the element that writes it (`deprecation: "deprecated"`), for the keywords the element has */
  keywords?: Record<string, string>
  /** entries after the annotation layer's, as [sub-pointer, location] (a field's resolved features) */
  resolved?: [string, Location | undefined][]
  /** the holder whose option statements keyword origins of `json_schema.required` point at (default: the element) */
  outer?: MOptionHolder
}

/**
 * Location of a comment line of an element (spec §5: keyword entries from comment tags point at the tag line), computed from the element's span and its leading comment text alone, so that both producers give the same span: the `//` lines of a leading comment end on the line above the element and start at its column. Block comments (text without a final newline) and trailing comments give no entry.
 */
export const commentLineLoc = (
  element: Location | undefined,
  leading: string | undefined,
  line: CommentLine | undefined,
): Location | undefined => {
  if (!element || !leading || !line || line.trailing || !leading.endsWith("\n")) return undefined
  const want = line.text.trim()
  if (!want) return undefined
  const raw = leading.slice(0, -1).split("\n")
  const k = raw.findIndex((l) => l.trim().replace(/[ \t\v\f]+/g, " ") === want)
  if (k < 0) return undefined
  const lineNo = element.start.line - raw.length + k
  if (lineNo < 0) return undefined
  const column = element.start.column
  return {
    file: element.file,
    start: { line: lineNo, column },
    end: { line: lineNo, column: column + 2 + raw[k].length },
  }
}

/** The written range (index into `ranges`) that starts the merged interval `[a, b]`: the lowest start inside it. */
const rangeIn = (ranges: [number, number][], a: number, b: number): number => {
  let best = -1
  ranges.forEach(([x, y], i) => {
    if (x >= a && y <= b && (best < 0 || x < ranges[best][0])) best = i
  })
  return best
}

/**
 * The source map being written. FIRST WINS: `map()` keeps the first location given for a pointer and ignores later ones, so where two sources can locate the same pointer (the `deprecated` option and a `@Deprecated` tag both giving `deprecation`, say) the call made first takes precedence; the call order is also the order of the entries in the result. Disabled (`BuildOptions.sourceMap: false`), every call is a no-op.
 */
export class SourceMapWriter {
  private readonly entries = new Map<string, Location>()
  readonly enabled: boolean

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  map(pointer: string, loc: Location | undefined) {
    if (this.enabled && loc && !this.entries.has(pointer)) this.entries.set(pointer, loc)
  }

  mapLocs(pointer: string, locs: Locs, keys: Record<string, string>) {
    if (!this.enabled) return
    this.map(pointer, locs[""])
    for (const sub in keys) {
      const loc = locs[keys[sub]]
      if (loc) this.map(`${pointer}/${sub}`, loc)
    }
  }

  mapOptions(pointer: string, holder: MOptionHolder, written: object | undefined) {
    if (!this.enabled || !written) return
    for (const key of Object.keys(written)) {
      const loc = getKey(holder.optionLocs, key)
      if (loc) this.map(`${pointer}/options/${ptr(key)}`, loc)
    }
  }

  /**
   * Keyword-level entries of the annotation layer (spec §5): a keyword lifted from an option points at the option statement, one from a comment tag or an AIP prefix at the comment line; `deprecation` likewise.
   */
  mapAnnotations(pointer: string, holder: MappedElement, ann: AnnotationResult, outer: MOptionHolder = holder) {
    if (!this.enabled) return
    const line = (c: CommentLine | undefined) => commentLineLoc(holder.locs[""], holder.comments.leading, c)
    for (const o of ann.origins) {
      const base = o.target ? `${pointer}/${o.target}` : pointer
      // `json_schema.required` of the message: the message's option statement
      const at = o.option === OPENAPIV2_SCHEMA ? outer : holder
      this.map(`${base}/${ptr(o.keyword)}`, o.option ? at.optionLocs[o.option] : line(o.comment))
    }
    const d = ann.deprecationOrigin
    if (ann.deprecation && d)
      this.map(
        `${pointer}/deprecation`,
        d.source === "option"
          ? holder.optionLocs.deprecated
          : d.source === "openapiv2"
            ? holder.optionLocs[OPENAPIV2_OPERATION]
            : line(d.comment),
      )
  }

  /**
   * The entries of one element, in precedence order: the element itself and its parts (`keys`), the keywords written from one of its options (`keywords`), the annotation layer's keyword origins, the `resolved` entries, then `options/*` for the options `out` writes. Called once per element, after `out` is complete.
   */
  mapElement(
    pointer: string,
    el: MappedElement,
    ann: AnnotationResult,
    out: Record<string, unknown>,
    entries: ElementEntries,
  ) {
    this.mapLocs(pointer, el.locs, entries.keys ?? {})
    const keywords = entries.keywords ?? {}
    for (const keyword in keywords)
      if (out[keyword]) this.map(`${pointer}/${keyword}`, el.optionLocs[keywords[keyword]])
    this.mapAnnotations(pointer, el, ann, entries.outer)
    for (const [sub, loc] of entries.resolved ?? []) this.map(`${pointer}/${sub}`, loc)
    this.mapOptions(pointer, el, out.options as object | undefined)
  }

  /** Reserved numbers and names, one entry per document index (spec §5): the written range that starts the merged interval, the first occurrence of the name. */
  mapReserved(
    pointer: string,
    el: { reservedRanges: [number, number][]; reservedNames: string[]; reservedLocs?: MMessage["reservedLocs"] },
    numbers: [number, number][],
    names: string[],
  ) {
    if (!this.enabled || !el.reservedLocs) return
    numbers.forEach(([a, b], i) =>
      this.map(`${pointer}/reserved/numbers/${i}`, el.reservedLocs?.ranges[rangeIn(el.reservedRanges, a, b)]),
    )
    names.forEach((n, i) =>
      this.map(`${pointer}/reserved/names/${i}`, el.reservedLocs?.names[el.reservedNames.indexOf(n)]),
    )
  }

  /** Extension ranges, one entry per document interval (spec §5): the written range that starts it. */
  mapExtensionRanges(pointer: string, ranges: MExtensionRange[], intervals: [number, number][]) {
    if (!this.enabled) return
    const written = ranges.map((r): [number, number] => [r.start, r.end])
    intervals.forEach(([a, b], i) => this.map(`${pointer}/extensions/${i}`, ranges[rangeIn(written, a, b)]?.rangeLoc))
  }

  toSourceMap(): SourceMap {
    return Object.fromEntries(this.entries)
  }
}
