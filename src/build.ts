// Builders (design §4.3): .proto text -> ProtoApi, FileDescriptorSet -> ProtoApi.

import type {
  AsyncProtoLoader,
  BuildIssue,
  BuildResult,
  DescriptorBuildOptions,
  DescriptorDecoder,
  FileDescriptorSetJson,
  ProtoSources,
  TextBuildOptions,
} from "./types.ts"
import type { MField, MFile, MOptionHolder } from "./model.ts"
import { SymbolTable } from "./symbols.ts"
import { linkAll } from "./resolve.ts"
import { Lowering } from "./lower/index.ts"
import { DEFAULT_TAB_WIDTH, textToModel } from "./text.ts"
import { convertFile } from "./descriptor.ts"
import { normalizePath } from "./paths.ts"
import { type BufbuildModules, decodeWithBufbuild, loadBufbuild } from "./binary.ts"
import { validateFiles } from "./validate/index.ts"
import { filePointer } from "./common/names.ts"
import { isPlainObjectNotBytes } from "./common/objects.ts"

const DESCRIPTOR_PROTO = "google/protobuf/descriptor.proto"

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

const bundledFile = (path: string, text: string, tabWidth = DEFAULT_TAB_WIDTH): MFile => {
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

type Bundle = Readonly<Record<string, string>>

const bundleLookup =
  (bundle: Bundle) =>
  (path: string, override?: Record<string, string>): string | undefined => {
    if (override && path in override) return override[path]
    return Object.prototype.hasOwnProperty.call(bundle, path) ? bundle[path] : undefined
  }

interface Loaded {
  files: MFile[]
  byPath: Map<string, MFile>
  sources: Map<string, string>
}

const finish = (
  bundleText: ReturnType<typeof bundleLookup>,
  loaded: Loaded,
  entry: string[],
  options: TextBuildOptions | DescriptorBuildOptions,
  issues: BuildIssue[],
  /** text producer: a descriptor.proto among the sources wins over the bundle (design §5.2), even when not imported */
  own?: string,
): BuildResult => {
  const { files, byPath } = loaded
  const tabWidth = (options as TextBuildOptions).tabWidth
  // built-in option definitions (and the edition feature defaults) are always available
  if (!byPath.has(DESCRIPTOR_PROTO)) {
    const text = own ?? bundleText(DESCRIPTOR_PROTO, options.bundle)
    if (text !== undefined) {
      const f =
        own !== undefined
          ? textToModel(DESCRIPTOR_PROTO, own, [], false, { tabWidth })
          : bundledFile(DESCRIPTOR_PROTO, text, tabWidth)
      files.push(f)
      byPath.set(f.path, f)
      loaded.sources.set(f.path, text)
    }
  }
  const symbols = new SymbolTable(files)
  linkAll(files, symbols)
  const lowering = new Lowering({
    files,
    entry,
    symbols,
    options,
    imports:
      options.imports ??
      (options.includeImports === undefined ? "user" : options.includeImports ? "all" : "referenced"),
    sources: loaded.sources,
    issues,
  })
  const { document, sourceMap } = lowering.run()
  // D-E: definition checks of the text producer (files flagged `validate`: the non-bundled sources)
  validateFiles({ files, symbols, optionsContext: lowering.optionsContext, sources: loaded.sources, issues })
  return { document, sourceMap: options.sourceMap === false ? {} : sourceMap, issues }
}

const missingImport = (file: MFile, index: number, path: string, issues: BuildIssue[], reason?: string) => {
  issues.push({
    code: "missing-import",
    message: reason ? `import "${path}" not found: ${reason}` : `import "${path}" not found`,
    file: file.path,
    location: file.imports[index]?.loc,
    pointer: `${filePointer(file.path)}/imports/${index}`,
  })
}

/** A file parsed ahead of the build (async prefetch): its text, model and parse issues. */
interface Prefetched {
  text: string
  file: MFile
  issues: BuildIssue[]
}

const normalizeSources = (sources: ProtoSources): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(sources)) out.set(normalizePath(k), v)
  return out
}

// ---- argument checks (validation decision 15): wrong argument types are programming errors and throw a TypeError;
// bad input content never throws (it gives issues) -------------------------------------------------------------------

const fail = (fn: string, what: string): never => {
  throw new TypeError(`${fn}: ${what} has the wrong type`)
}

/** An object of strings (sources, `bundle`, `tags` with `false` allowed). */
const checkStrings = (fn: string, name: string, v: unknown, allowFalse = false) => {
  if (!isPlainObjectNotBytes(v) || Object.values(v).some((x) => typeof x !== "string" && !(allowFalse && x === false)))
    fail(fn, name)
}

/** Option checks: [name, test] (decision 15). */
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

const checkOptions = (fn: string, options: unknown) => {
  if (options === undefined) return
  if (!isPlainObjectNotBytes(options)) fail(fn, "options")
  const o = options as Record<string, unknown>
  for (const [k, ok] of OPTION_CHECKS) if (o[k] !== undefined && !ok(o[k])) fail(fn, `options.${k}`)
  // decision 15: the deprecated alias may repeat `imports`, never contradict it
  if (o.imports && o.includeImports !== undefined && (o.includeImports ? "all" : "referenced") !== o.imports)
    throw new TypeError(`${fn}: options.imports conflicts with options.includeImports`)
  if (o.tags !== undefined) checkStrings(fn, "options.tags", o.tags, true)
  if (o.bundle !== undefined) checkStrings(fn, "options.bundle", o.bundle)
}

export interface Builders {
  /** Build a ProtoApi document from `.proto` sources (import path -> text). */
  buildFromProto(sources: ProtoSources, options?: TextBuildOptions): BuildResult
  /** Like `buildFromProto`, with an asynchronous loader for imports not found in `sources` or the bundle. */
  buildFromProtoAsync(
    sources: ProtoSources,
    options?: Omit<TextBuildOptions, "loader"> & { loader?: AsyncProtoLoader },
  ): Promise<BuildResult>
  /** Build a ProtoApi document from the ProtoJSON form of a FileDescriptorSet (e.g. `buf build -o image.json`). */
  buildFromDescriptorSet(set: FileDescriptorSetJson, options?: DescriptorBuildOptions): BuildResult
  /** Build from a binary FileDescriptorSet; decodes with `decoder`, else with the optional `@bufbuild/protobuf`. */
  buildFromDescriptorSetBinary(
    bytes: Uint8Array,
    options?: DescriptorBuildOptions & { decoder?: DescriptorDecoder },
  ): Promise<BuildResult>
}

/** The builders over a set of bundled definitions (`protoapi` injects the bundle, `protoapi/core` an empty one). */
export const createBuilders = (
  bundle: Bundle,
  /** internal (tests): how @bufbuild/protobuf is loaded */
  internal: { loadBufbuild?: () => Promise<BufbuildModules> } = {},
): Builders => {
  const bundleText = bundleLookup(bundle)

  /**
   * The text build over normalised sources. `prefetched`: files the async builder already loaded and parsed (they are
   * not parsed again); `failures`: paths whose async load failed, with the reason (reported as `missing-import`).
   */
  const buildText = (
    src: Map<string, string>,
    options: TextBuildOptions,
    entry: string[],
    prefetched?: Map<string, Prefetched>,
    failures?: Map<string, string>,
  ): BuildResult => {
    const issues: BuildIssue[] = []
    const tabWidth = options.tabWidth ?? DEFAULT_TAB_WIDTH
    const loaded: Loaded = { files: [], byPath: new Map(), sources: new Map() }
    const resolved = new Map<string, { text: string; bundled: boolean } | undefined>()
    const resolveText = (path: string): { text: string; bundled: boolean } | undefined => {
      if (resolved.has(path)) return resolved.get(path)
      let out: { text: string; bundled: boolean } | undefined
      const own = src.get(path)
      if (own !== undefined) out = { text: own, bundled: false }
      else {
        const b = bundleText(path, options.bundle)
        if (b !== undefined) out = { text: b, bundled: true }
        else {
          const pre = prefetched?.get(path)
          if (pre) out = { text: pre.text, bundled: false }
          else if (!failures?.has(path)) {
            const l = options.loader?.(path)
            if (typeof l === "string") out = { text: l, bundled: false }
          }
        }
      }
      resolved.set(path, out)
      return out
    }
    const queue = [...entry]
    const seen = new Set<string>()
    const missing = new Set<string>()
    while (queue.length) {
      const path = queue.shift() as string
      if (seen.has(path)) continue
      seen.add(path)
      const t = resolveText(path)
      if (!t) {
        const reason = failures?.get(path)
        issues.push({
          code: "missing-import",
          message: reason ? `entry file "${path}" not found: ${reason}` : `entry file "${path}" not found`,
          file: path,
        })
        continue
      }
      let file: MFile
      const pre = prefetched?.get(path)
      if (t.bundled) file = bundledFile(path, t.text, tabWidth)
      else if (pre && pre.text === t.text) {
        file = pre.file
        issues.push(...pre.issues)
      } else file = textToModel(path, t.text, issues, false, { tabWidth })
      // D-E: the build checks the definitions of every non-bundled file
      if (!t.bundled) file.validate = true
      loaded.files.push(file)
      loaded.byPath.set(file.path, file)
      loaded.sources.set(file.path, t.text)
      file.imports.forEach((imp, i) => {
        // C-17: every import statement of a missing file gets its own issue
        if (missing.has(imp.path)) {
          missingImport(file, i, imp.path, issues, failures?.get(imp.path))
          return
        }
        if (seen.has(imp.path) || queue.includes(imp.path)) return
        if (resolveText(imp.path) === undefined) {
          missingImport(file, i, imp.path, issues, failures?.get(imp.path))
          missing.add(imp.path)
          seen.add(imp.path)
          return
        }
        queue.push(imp.path)
      })
    }
    return finish(bundleText, loaded, entry, options, issues, src.get(DESCRIPTOR_PROTO))
  }

  const buildFromProto = (sources: ProtoSources, options: TextBuildOptions = {}): BuildResult => {
    checkStrings("buildFromProto", "sources", sources)
    checkOptions("buildFromProto", options)
    const src = normalizeSources(sources)
    return buildText(src, options, (options.entry ?? [...src.keys()]).map(normalizePath))
  }

  const buildFromProtoAsync = (
    sources: ProtoSources,
    options: Omit<TextBuildOptions, "loader"> & { loader?: AsyncProtoLoader } = {},
  ): Promise<BuildResult> => {
    // argument checks throw synchronously: a programming error, not a failed build
    checkStrings("buildFromProtoAsync", "sources", sources)
    checkOptions("buildFromProtoAsync", options)
    return buildAsync(sources, options)
  }

  const buildAsync = async (
    sources: ProtoSources,
    options: Omit<TextBuildOptions, "loader"> & { loader?: AsyncProtoLoader },
  ): Promise<BuildResult> => {
    const src = normalizeSources(sources)
    const entry = (options.entry ?? [...src.keys()]).map(normalizePath)
    const loader = options.loader
    const prefetched = new Map<string, Prefetched>()
    const failures = new Map<string, string>()
    if (loader) {
      // C-16: prefetch the import closure with the async loader. Imports are found by parsing each file (the parsed
      // model is reused by the build), so imports anywhere on a line, after comments or split over lines are found.
      // A loader that throws or rejects makes that one import missing; the build never rejects.
      const tabWidth = options.tabWidth ?? DEFAULT_TAB_WIDTH
      const queue = [...entry]
      const seen = new Set<string>()
      while (queue.length) {
        const path = queue.shift() as string
        if (seen.has(path)) continue
        seen.add(path)
        const known = src.get(path) ?? bundleText(path, options.bundle)
        if (known !== undefined) {
          // sources and bundled files: only their imports are needed here
          if (src.has(path)) {
            const issues: BuildIssue[] = []
            const file = textToModel(path, known, issues, false, { tabWidth })
            prefetched.set(path, { text: known, file, issues })
            queue.push(...file.imports.map((i) => i.path))
          } else queue.push(...bundledFile(path, known, tabWidth).imports.map((i) => i.path))
          continue
        }
        let text: unknown
        try {
          text = await loader(path)
        } catch (e) {
          failures.set(path, `the loader failed: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        if (typeof text !== "string") {
          if (text !== undefined) failures.set(path, `the loader returned ${typeof text}, not a string`)
          continue
        }
        const issues: BuildIssue[] = []
        const file = textToModel(path, text, issues, false, { tabWidth })
        prefetched.set(path, { text, file, issues })
        queue.push(...file.imports.map((i) => i.path))
      }
    }
    // sources were parsed above; the build takes their models from `prefetched` (same text)
    return buildText(src, { ...options, loader: undefined }, entry, prefetched, failures)
  }

  const buildFromDescriptorSet = (set: FileDescriptorSetJson, options: DescriptorBuildOptions = {}): BuildResult => {
    if (!isPlainObjectNotBytes(set) || !Array.isArray((set as { file?: unknown }).file))
      fail("buildFromDescriptorSet", "the FileDescriptorSet (an object with a `file` array)")
    checkOptions("buildFromDescriptorSet", options)
    return buildDescriptorSet(set, options)
  }

  const buildDescriptorSet = (set: FileDescriptorSetJson, options: DescriptorBuildOptions): BuildResult => {
    const issues: BuildIssue[] = []
    const loaded: Loaded = { files: [], byPath: new Map(), sources: new Map() }
    for (const fd of Array.isArray(set?.file) ? set.file : []) {
      if (!fd || typeof fd !== "object") continue
      let file: MFile
      try {
        file = convertFile(fd as Record<string, unknown>, issues)
      } catch (e) {
        issues.push({
          code: "unsupported",
          message: `invalid FileDescriptorProto: ${(e as Error).message}`,
          file: String((fd as { name?: unknown }).name ?? ""),
        })
        continue
      }
      if (loaded.byPath.has(file.path)) continue
      loaded.files.push(file)
      loaded.byPath.set(file.path, file)
    }
    // imports missing from the set: bundled definitions fill the gap (option typing, well-known types)
    const queue = loaded.files.flatMap((f) => f.imports.map((i) => i.path))
    while (queue.length) {
      const path = queue.shift() as string
      if (loaded.byPath.has(path)) continue
      const text = bundleText(path, options.bundle)
      if (text === undefined) continue
      const f = bundledFile(path, text)
      loaded.files.push(f)
      loaded.byPath.set(f.path, f)
      loaded.sources.set(f.path, text)
      queue.push(...f.imports.map((i) => i.path))
    }
    const entry = (options.entry ?? loaded.files.filter((f) => !f.isImport && !f.bundled).map((f) => f.path)).map(
      normalizePath,
    )
    // U3: a set does not record where a file came from; a file whose path is a key of the bundle in effect counts as resolved from the bundle, as the text producer resolves it when no source overrides that path
    for (const f of loaded.files) if (bundleText(f.path, options.bundle) !== undefined) f.bundled = true
    return finish(bundleText, loaded, entry, options, issues)
  }

  const buildFromDescriptorSetBinary = (
    bytes: Uint8Array,
    options: DescriptorBuildOptions & { decoder?: DescriptorDecoder } = {},
  ): Promise<BuildResult> => {
    if (!(bytes instanceof Uint8Array)) fail("buildFromDescriptorSetBinary", "the set (a Uint8Array)")
    checkOptions("buildFromDescriptorSetBinary", options)
    return buildBinary(bytes, options)
  }

  const buildBinary = async (
    bytes: Uint8Array,
    options: DescriptorBuildOptions & { decoder?: DescriptorDecoder },
  ): Promise<BuildResult> => {
    let set: FileDescriptorSetJson | undefined
    const decodeIssues: BuildIssue[] = []
    try {
      set = options.decoder
        ? await options.decoder(bytes)
        : await decodeWithBufbuild(
            bytes,
            { bundleText: (path) => bundleText(path, options.bundle), bundledFile, issues: decodeIssues },
            internal.loadBufbuild ?? (() => loadBufbuild()),
          )
    } catch (e) {
      return {
        document: { protoapi: "0.1" },
        sourceMap: {},
        issues: [{ code: "unsupported", message: `cannot decode the FileDescriptorSet: ${(e as Error).message}` }],
      }
    }
    if (!isPlainObjectNotBytes(set) || !Array.isArray((set as { file?: unknown }).file))
      return {
        document: { protoapi: "0.1" },
        sourceMap: {},
        issues: [...decodeIssues, { code: "unsupported", message: "the decoder did not return a FileDescriptorSet" }],
      }
    const result = buildDescriptorSet(set, options)
    return decodeIssues.length ? { ...result, issues: [...decodeIssues, ...result.issues] } : result
  }

  return { buildFromProto, buildFromProtoAsync, buildFromDescriptorSet, buildFromDescriptorSetBinary }
}
