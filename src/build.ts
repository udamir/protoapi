// Builders (design §4.3): .proto text -> ProtoApi, FileDescriptorSet -> ProtoApi. The loading of each producer is
// here; argument checks, the bundle cache, the import closure walk and the shared pipeline are in src/build/.

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
import type { MFile } from "./model/index.ts"
import { textToModel } from "./frontend/text/convert.ts"
import { convertFile } from "./frontend/descriptor/convert.ts"
import { normalizePath } from "./paths.ts"
import { type BufbuildModules, decodeWithBufbuild, loadBufbuild } from "./binary.ts"
import { filePointer } from "./common/names.ts"
import { isPlainObjectNotBytes } from "./common/objects.ts"
import { type Settings, checkOptions, checkStrings, fail, normalizeSources, settingsOf } from "./build/arguments.ts"
import { type Bundle, bundleLookup, bundledFile } from "./build/bundle-cache.ts"
import { ImportClosure } from "./build/closure.ts"
import { DESCRIPTOR_PROTO, type Loaded, finish } from "./build/pipeline.ts"

/** The `missing-import` message of a file that is not found (`what`: the entry or import as written in the message). */
const notFound = (what: string, reason?: string) => (reason ? `${what} not found: ${reason}` : `${what} not found`)

const missingImport = (file: MFile, index: number, path: string, issues: BuildIssue[], reason?: string) => {
  issues.push({
    code: "missing-import",
    message: notFound(`import "${path}"`, reason),
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
    settings: Settings,
    entry: string[],
    prefetched?: Map<string, Prefetched>,
    failures?: Map<string, string>,
  ): BuildResult => {
    const issues: BuildIssue[] = []
    const { tabWidth } = settings
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
    const closure = new ImportClosure(entry)
    const missing = new Set<string>()
    for (let path = closure.next(); path !== undefined; path = closure.next()) {
      const t = resolveText(path)
      if (!t) {
        issues.push({
          code: "missing-import",
          message: notFound(`entry file "${path}"`, failures?.get(path)),
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
        if (closure.has(imp.path)) return
        if (resolveText(imp.path) === undefined) {
          missingImport(file, i, imp.path, issues, failures?.get(imp.path))
          missing.add(imp.path)
          closure.skip(imp.path)
          return
        }
        closure.add(imp.path)
      })
    }
    return finish(bundleText, loaded, entry, options, settings, issues, src.get(DESCRIPTOR_PROTO))
  }

  const buildFromProto = (sources: ProtoSources, options: TextBuildOptions = {}): BuildResult => {
    checkStrings("buildFromProto", "sources", sources)
    checkOptions("buildFromProto", options)
    const src = normalizeSources(sources)
    return buildText(src, options, settingsOf(options), (options.entry ?? [...src.keys()]).map(normalizePath))
  }

  const buildFromProtoAsync = (
    sources: ProtoSources,
    options: Omit<TextBuildOptions, "loader"> & { loader?: AsyncProtoLoader } = {},
  ): Promise<BuildResult> => {
    // argument checks throw synchronously: a programming error, not a failed build
    checkStrings("buildFromProtoAsync", "sources", sources)
    checkOptions("buildFromProtoAsync", options)
    return buildAsync(sources, options, settingsOf(options))
  }

  const buildAsync = async (
    sources: ProtoSources,
    options: Omit<TextBuildOptions, "loader"> & { loader?: AsyncProtoLoader },
    settings: Settings,
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
      const { tabWidth } = settings
      const closure = new ImportClosure(entry)
      for (let path = closure.next(); path !== undefined; path = closure.next()) {
        const known = src.get(path) ?? bundleText(path, options.bundle)
        if (known !== undefined) {
          // sources and bundled files: only their imports are needed here
          if (src.has(path)) {
            const issues: BuildIssue[] = []
            const file = textToModel(path, known, issues, false, { tabWidth })
            prefetched.set(path, { text: known, file, issues })
            for (const i of file.imports) closure.add(i.path)
          } else for (const i of bundledFile(path, known, tabWidth).imports) closure.add(i.path)
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
        for (const i of file.imports) closure.add(i.path)
      }
    }
    // sources were parsed above; the build takes their models from `prefetched` (same text)
    return buildText(src, { ...options, loader: undefined }, settings, entry, prefetched, failures)
  }

  const buildFromDescriptorSet = (set: FileDescriptorSetJson, options: DescriptorBuildOptions = {}): BuildResult => {
    if (!isPlainObjectNotBytes(set) || !Array.isArray((set as { file?: unknown }).file))
      fail("buildFromDescriptorSet", "the FileDescriptorSet (an object with a `file` array)")
    checkOptions("buildFromDescriptorSet", options)
    return buildDescriptorSet(set, options, settingsOf(options))
  }

  const buildDescriptorSet = (
    set: FileDescriptorSetJson,
    options: DescriptorBuildOptions,
    settings: Settings,
  ): BuildResult => {
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
    const closure = new ImportClosure(
      loaded.files.flatMap((f) => f.imports.map((i) => i.path)),
      loaded.byPath.keys(),
    )
    for (let path = closure.next(); path !== undefined; path = closure.next()) {
      const text = bundleText(path, options.bundle)
      if (text === undefined) continue
      const f = bundledFile(path, text)
      loaded.files.push(f)
      loaded.byPath.set(f.path, f)
      loaded.sources.set(f.path, text)
      for (const i of f.imports) closure.add(i.path)
    }
    const entry = (options.entry ?? loaded.files.filter((f) => !f.isImport && !f.bundled).map((f) => f.path)).map(
      normalizePath,
    )
    // U3: a set does not record where a file came from; a file whose path is a key of the bundle in effect counts as resolved from the bundle, as the text producer resolves it when no source overrides that path
    for (const f of loaded.files) if (bundleText(f.path, options.bundle) !== undefined) f.bundled = true
    return finish(bundleText, loaded, entry, options, settings, issues)
  }

  const buildFromDescriptorSetBinary = (
    bytes: Uint8Array,
    options: DescriptorBuildOptions & { decoder?: DescriptorDecoder } = {},
  ): Promise<BuildResult> => {
    if (!(bytes instanceof Uint8Array)) fail("buildFromDescriptorSetBinary", "the set (a Uint8Array)")
    checkOptions("buildFromDescriptorSetBinary", options)
    return buildBinary(bytes, options, settingsOf(options))
  }

  const buildBinary = async (
    bytes: Uint8Array,
    options: DescriptorBuildOptions & { decoder?: DescriptorDecoder },
    settings: Settings,
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
    const result = buildDescriptorSet(set, options, settings)
    return decodeIssues.length ? { ...result, issues: [...decodeIssues, ...result.issues] } : result
  }

  return { buildFromProto, buildFromProtoAsync, buildFromDescriptorSet, buildFromDescriptorSetBinary }
}
