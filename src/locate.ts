// Source map lookups (design §9).

import type { JsonPointer, Location, SourceMap } from "./types.ts"
import { ptr } from "./paths.ts"

const toPointer = (path: (string | number)[]): JsonPointer => (path.length ? `#/${path.map(ptr).join("/")}` : "#")

const parentPointer = (p: JsonPointer): JsonPointer | undefined => {
  const i = p.lastIndexOf("/")
  return i <= 1 ? undefined : p.slice(0, i)
}

/** Wrong argument types are a TypeError (decision 15). */
const check = (fn: string, ok: unknown) => {
  if (!ok) throw new TypeError(`${fn}: wrong argument types`)
}
const isMap = (map: unknown): map is SourceMap => !!map && typeof map === "object" && !Array.isArray(map)

const own = (map: SourceMap, p: JsonPointer): Location | undefined =>
  Object.prototype.hasOwnProperty.call(map, p) ? map[p] : undefined

/** Location of `pointer` or of its nearest ancestor that has one. */
export const locatePointer = (pointer: JsonPointer, map: SourceMap): Location | undefined => {
  check("locatePointer", typeof pointer === "string" && isMap(map))
  let p: JsonPointer | undefined = pointer.startsWith("#")
    ? pointer
    : `#${pointer.startsWith("/") ? "" : "/"}${pointer}`
  while (p) {
    const loc = own(map, p)
    if (loc) return loc
    p = parentPointer(p)
  }
  return undefined
}

export interface LocatableDiff {
  action: string
  /** api-smart-diff 2.0 `Diff.path`: the keys of the before document; for `rename`, the path of the container */
  path: (string | number)[]
  before?: unknown
  after?: unknown
  /** api-smart-diff 2.0 `Diff.origin`: declaration paths when they differ from `path` (inside `$ref` targets) */
  origin?: { before: (string | number)[]; after: (string | number)[] }
}

const isKey = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number"

const exact = (path: (string | number)[], map: SourceMap): Location | undefined => own(map, toPointer(path))

/**
 * Resolve a diff to a location (design §9, validation L-1, L-2, L-4):
 *
 * - `remove` -> the before map; `add`, `replace`, `rename` -> the after map (the before map when the after map has no
 *   entry on the path, e.g. below a renamed ancestor, whose before key `path` holds); `origin` replaces `path`.
 * - `rename` (api-smart-diff 2.0: `path` is the container, `before` / `after` the old and new key) -> the entry at
 *   `[...path, after]` in the after map, `[...path, before]` in the before map as the fallback.
 * - an index into `reserved.numbers`, `reserved.names`, `extensions` -> the written range / name (one entry per
 *   index), else the first `reserved` / `extensions` statement.
 * - a `$ref` leaf -> the field's `type` entry (also under `items` / `additionalProperties`), a method's
 *   `request` / `response` type name.
 * - otherwise the nearest ancestor with an entry.
 */
export const locateDiff = (diff: LocatableDiff, beforeMap: SourceMap, afterMap: SourceMap): Location | undefined => {
  check(
    "locateDiff",
    diff && typeof diff === "object" && Array.isArray(diff.path) && isMap(beforeMap) && isMap(afterMap),
  )
  const removed = diff.action === "remove"
  const origin =
    diff.origin && Array.isArray(diff.origin.before) && Array.isArray(diff.origin.after) ? diff.origin : undefined
  const base = [...((removed ? origin?.before : origin?.after) ?? diff.path)]
  if (diff.action === "rename" && isKey(diff.after)) {
    const after = exact([...base, diff.after], afterMap)
    if (after) return after
    if (isKey(diff.before)) {
      const before = exact([...(origin?.before ?? diff.path), diff.before], beforeMap)
      if (before) return before
    }
    return locatePointer(toPointer(base), afterMap) ?? locatePointer(toPointer(base), beforeMap)
  }
  const map = removed ? beforeMap : afterMap
  const hit = special(base, map)
  if (hit) return hit
  return locatePointer(toPointer(base), map) ?? (removed ? undefined : locatePointer(toPointer(base), beforeMap))
}

/** The rules of §9 that look up another pointer than the path's nearest ancestor. */
const special = (path: (string | number)[], map: SourceMap): Location | undefined => {
  const n = path.length
  const last = path[n - 1]
  const prev = path[n - 2]
  // reserved / extensions intervals, also an index into an interval (`…/reserved/numbers/1/0`)
  for (let i = n - 1; i >= 2; i--) {
    if (typeof path[i] !== "number") continue
    const at = path[i - 1]
    const ranges = (at === "numbers" || at === "names") && path[i - 2] === "reserved"
    const extensions = at === "extensions" && path[i - 2] !== "properties"
    if (!ranges && !extensions) continue
    const loc = exact(path.slice(0, i + 1), map) ?? exact(path.slice(0, ranges ? i - 1 : i), map)
    if (loc) return loc
    break
  }
  if (last === "$ref") {
    // `…/<f>/$ref`, `…/<f>/items/$ref`, `…/<f>/additionalProperties/$ref` -> `…/<f>/type`
    const owner = prev === "items" || prev === "additionalProperties" ? path.slice(0, -2) : path.slice(0, -1)
    const loc = exact([...owner, "type"], map)
    if (loc) return loc
    // `…/methods/<m>/request/schema/$ref` -> `…/methods/<m>/request`
    if (prev === "schema") {
      const m = exact(path.slice(0, -2), map)
      if (m) return m
    }
  }
  return undefined
}
