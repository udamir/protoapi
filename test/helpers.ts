// Test helpers: fixture loading, both producers, structural diff.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { buildFromDescriptorSet, buildFromProto, printProto } from "../src"
import { normalizePath } from "../src/paths"
import type {
  BuildIssue,
  BuildOptions,
  BuildResult,
  FileDescriptorSetJson,
  ImportsMode,
  PrintOptions,
  ProtoApiDocument,
} from "../src"

export const ROOT = join(import.meta.dir, "..")
export const FIXTURES = join(ROOT, "test", "fixtures")
export const IMAGES = join(ROOT, "test", "images")

const walk = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".proto") ? [p] : []
    })

/** All fixture sets (directories with .proto files directly inside), relative to test/fixtures. */
export const fixtureSets = (base = FIXTURES): string[] => {
  const entries = readdirSync(base).sort()
  if (entries.some((e) => e.endsWith(".proto") || e === "SOURCE.md"))
    return [relative(FIXTURES, base).split("\\").join("/")]
  return entries.filter((e) => statSync(join(base, e)).isDirectory()).flatMap((e) => fixtureSets(join(base, e)))
}

export const loadSources = (set: string): Record<string, string> => {
  const dir = join(FIXTURES, set)
  const out: Record<string, string> = {}
  for (const f of walk(dir)) out[relative(dir, f).split("\\").join("/")] = readFileSync(f, "utf8")
  return out
}

export const loadImage = (set: string): FileDescriptorSetJson =>
  JSON.parse(readFileSync(join(IMAGES, `${set}.json`), "utf8"))

export const buildBoth = (set: string, options: BuildOptions = {}): { text: BuildResult; descriptor: BuildResult } => {
  const sources = loadSources(set)
  const text = buildFromProto(sources, options)
  const descriptor = buildFromDescriptorSet(loadImage(set), options)
  return { text, descriptor }
}

/** First differences between two JSON values, as `path: a !== b` lines. */
export const jsonDiff = (a: unknown, b: unknown, path = "", out: string[] = [], limit = 40): string[] => {
  if (out.length >= limit) return out
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    for (const k of new Set([...ka, ...kb]))
      jsonDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`, out, limit)
    if (!out.length && ka.join() !== kb.join()) out.push(`${path}: key order ${ka.join(",")} !== ${kb.join(",")}`)
    return out
  }
  out.push(`${path}: ${JSON.stringify(a)?.slice(0, 200)} !== ${JSON.stringify(b)?.slice(0, 200)}`)
  return out
}

/** The document without `x-annotation-conflicts` (a conflict has one source after printing, design §10). */
export const withoutConflicts = (d: ProtoApiDocument): ProtoApiDocument =>
  JSON.parse(JSON.stringify(d, (k, v) => (k === "x-annotation-conflicts" ? undefined : v)))

export interface RoundTrip {
  first: BuildResult
  second: BuildResult
  /** everything printProto returned */
  printed: Record<string, string>
  /** the printed files the second build reads (see `roundTrip`) */
  used: Record<string, string>
  /** structural differences of the two documents (x-annotation-conflicts removed) */
  diff: string[]
  /** issues of the second build that the first did not have (annotation-conflict issues follow the conflicts) */
  newIssues: BuildIssue[]
}

/** The emission modes of `BuildOptions.imports`; the round trip and its buf check run in each. */
export const IMPORT_MODES = ["user", "referenced", "all"] as const

/** The emission mode of build options (`imports`, else the deprecated `includeImports`, else the default "user"). */
export const modeOf = (o: BuildOptions): ImportsMode =>
  o.imports ?? (o.includeImports === undefined ? "user" : o.includeImports ? "all" : "referenced")

/** `options` in emission mode `mode` (the `includeImports` alias removed). */
export const inMode = (options: BuildOptions, mode: ImportsMode): BuildOptions => {
  const { includeImports: _, ...rest } = options
  return { ...rest, imports: mode }
}

/** PB-7: build(print(build(x))) against build(x). The print options follow the build options: `tags: false` for `annotations: "options"` / `"none"` builds, the build's `tags` map otherwise (decision 13). What the second build reads depends on the emission mode (design §10): with `imports: "user"` (the default) the printed files alone, since every user file is complete and the files marked `bundled` (not printed) resolve from the bundle; with `"all"` every printed file over the original sources; with `"referenced"` the printed entry files over the original sources, because the document holds only the referenced declarations of imported files, so their printed text is partial by construction, and the build's sources type the option values (`PrintOptions.sources`). Documents without `files` are rebuilt from the printed files alone. */
export const roundTrip = (
  sources: Record<string, string>,
  options: BuildOptions = {},
  print: PrintOptions = {},
): RoundTrip => {
  const opts: BuildOptions = { ...options, sourceMap: false }
  const mode = modeOf(options)
  const first = buildFromProto(sources, opts)
  const entry = (options.entry ?? Object.keys(sources)).map(normalizePath)
  const printed = printProto(first.document, {
    tags: options.annotations === "options" || options.annotations === "none" ? false : options.tags ?? true,
    ...(mode === "user" ? {} : { sources }),
    ...print,
  })
  let used: Record<string, string>
  let second: BuildResult
  if (options.files === false) {
    used = printed
    second = buildFromProto(printed, { ...opts, entry: undefined })
  } else if (mode === "user") {
    used = printed
    second = buildFromProto(printed, { ...opts, entry })
  } else {
    used = {}
    for (const [k, v] of Object.entries(printed)) if (mode === "all" || entry.includes(k)) used[k] = v
    second = buildFromProto({ ...sources, ...used }, { ...opts, entry })
  }
  const diff = jsonDiff(withoutConflicts(first.document), withoutConflicts(second.document), "", [], 12)
  const seen = new Set(first.issues.map((i) => `${i.code}: ${i.message}`))
  const newIssues = second.issues.filter(
    (i) => !seen.has(`${i.code}: ${i.message}`) && i.code !== "annotation-conflict",
  )
  return { first, second, printed, used, diff, newIssues }
}
