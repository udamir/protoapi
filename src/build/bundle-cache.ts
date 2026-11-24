// Bundled definitions: lookup by import path (the `bundle` option first) and the parsed bundled files, shared
// between builds and reset before each reuse.

import type { MField, MFile, MOptionHolder } from "../model/index.ts"
import { DEFAULT_TAB_WIDTH, textToModel } from "../frontend/text/convert.ts"

/** Parsed bundled files, shared between builds (bundled files only reference bundled files). */
const bundleCache = new Map<string, { text: string; file: MFile; tabWidth: number }>()

/** The model children a cached file is reset through (holders all of them). */
const CHILDREN = [
  "messages",
  "enums",
  "extensions",
  "services",
  "fields",
  "oneofs",
  "extensionRanges",
  "nested",
  "values",
  "methods",
]

/** Reset the per-build state of a cached model: link results, typed options, pending issues. */
const resetFile = (holder: MOptionHolder): void => {
  holder.pending = undefined
  holder.options = {}
  holder.optionLocs = {}
  const n = holder as unknown as Record<string, unknown>
  // type references of fields (also map values), extendees and method types
  for (const t of [n.type, (n.map as MField["map"])?.value, n.extendee, n.input, n.output] as Record<string, unknown>[])
    if (t && t.kind !== "scalar") t.resolved = t.unresolvedKey = undefined
  for (const k of CHILDREN) (n[k] as MOptionHolder[] | undefined)?.forEach(resetFile)
}

/** The model of a bundled file, parsed once per text and tab width (its parse issues are not reported). */
export const bundledFile = (path: string, text: string, tabWidth = DEFAULT_TAB_WIDTH): MFile => {
  const cached = bundleCache.get(path)
  if (cached && cached.text === text && cached.tabWidth === tabWidth) {
    resetFile(cached.file)
    return cached.file
  }
  // the parse issues of a bundled file are not reported
  const file = textToModel(path, text, [], true, { tabWidth })
  bundleCache.set(path, { text, file, tabWidth })
  return file
}

export type Bundle = Readonly<Record<string, string>>

/** Bundled text by import path: `override` (the `bundle` option) first, then the bundle the builders were made with. */
export type BundleLookup = (path: string, override?: Record<string, string>) => string | undefined

export const bundleLookup =
  (bundle: Bundle): BundleLookup =>
  (path, override) => {
    if (override && path in override) return override[path]
    return Object.prototype.hasOwnProperty.call(bundle, path) ? bundle[path] : undefined
  }
