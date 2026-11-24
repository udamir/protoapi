// Arguments of the public builders: type checks (wrong argument types are programming errors and throw a TypeError; bad input content never throws, it gives issues) and the options normalised once, up front.

import type { BuildOptions, ImportsMode, ProtoSources } from "../types.ts"
import { normalizePath } from "../paths.ts"
import { isPlainObjectNotBytes } from "../common/objects.ts"
import { DEFAULT_TAB_WIDTH } from "../frontend/text/convert.ts"

export const fail = (fn: string, what: string): never => {
  throw new TypeError(`${fn}: ${what} has the wrong type`)
}

/** An object of strings (sources, `bundle`, `tags` with `false` allowed). */
export const checkStrings = (fn: string, name: string, v: unknown, allowFalse = false) => {
  if (!isPlainObjectNotBytes(v) || Object.values(v).some((x) => typeof x !== "string" && !(allowFalse && x === false)))
    fail(fn, name)
}

/** Option checks: [name, test]; a failed test is a TypeError. */
const OPTION_CHECKS: [string, (v: unknown) => boolean][] = [
  ["entry", (v) => Array.isArray(v) && v.every((e) => typeof e === "string")],
  ["imports", (v) => ["user", "referenced", "all"].includes(v as string)],
  ["includeImports", (v) => typeof v === "boolean"],
  ["sourceMap", (v) => typeof v === "boolean"],
  ["files", (v) => typeof v === "boolean"],
  ["annotations", (v) => ["all", "options", "none"].includes(v as string)],
  ["tabWidth", (v) => Number.isInteger(v) && (v as number) > 0],
  ["loader", (v) => typeof v === "function"],
  ["decoder", (v) => typeof v === "function"],
]

export const checkOptions = (fn: string, options: unknown) => {
  if (options === undefined) return
  if (!isPlainObjectNotBytes(options)) fail(fn, "options")
  const o = options as Record<string, unknown>
  for (const [k, ok] of OPTION_CHECKS) if (o[k] !== undefined && !ok(o[k])) fail(fn, `options.${k}`)
  // the deprecated alias may repeat `imports`, never contradict it
  if (o.imports && o.includeImports !== undefined && (o.includeImports ? "all" : "referenced") !== o.imports)
    throw new TypeError(`${fn}: options.imports conflicts with options.includeImports`)
  if (o.tags !== undefined) checkStrings(fn, "options.tags", o.tags, true)
  if (o.bundle !== undefined) checkStrings(fn, "options.bundle", o.bundle)
}

/** The options the build pipeline reads beyond `BuildOptions` as given, resolved once after the checks. */
export interface Settings {
  /** emission mode, the deprecated `includeImports` alias resolved */
  imports: ImportsMode
  /** tab stop of the text producer's columns (`tabWidth`, default 4) */
  tabWidth: number
}

export const settingsOf = (options: BuildOptions): Settings => ({
  imports:
    options.imports ?? (options.includeImports === undefined ? "user" : options.includeImports ? "all" : "referenced"),
  tabWidth: options.tabWidth ?? DEFAULT_TAB_WIDTH,
})

/** Sources by normalised import path. */
export const normalizeSources = (sources: ProtoSources): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(sources)) out.set(normalizePath(k), v)
  return out
}
