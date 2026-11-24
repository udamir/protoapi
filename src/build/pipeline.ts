// The build pipeline after loading, shared by both producers: symbols -> link -> lower -> validate.

import type { BuildIssue, BuildOptions, BuildResult } from "../types.ts"
import type { MFile } from "../model/index.ts"
import { SymbolTable } from "../symbols.ts"
import { linkAll } from "../resolve.ts"
import { Lowering } from "../lower/index.ts"
import { validateFiles } from "../validate/index.ts"
import { textToModel } from "../frontend/text/convert.ts"
import type { Settings } from "./arguments.ts"
import { type BundleLookup, bundledFile } from "./bundle-cache.ts"

export const DESCRIPTOR_PROTO = "google/protobuf/descriptor.proto"

/** The files of a build, loaded by a producer. */
export interface Loaded {
  files: MFile[]
  byPath: Map<string, MFile>
  sources: Map<string, string>
}

export const finish = (
  bundleText: BundleLookup,
  loaded: Loaded,
  entry: string[],
  options: BuildOptions,
  settings: Settings,
  issues: BuildIssue[],
  /** text producer: a descriptor.proto among the sources wins over the bundle (design §5.2), even when not imported */
  own?: string,
): BuildResult => {
  const { files, byPath } = loaded
  const { tabWidth } = settings
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
    imports: settings.imports,
    sources: loaded.sources,
    issues,
  })
  const { document, sourceMap } = lowering.run()
  // D-E: definition checks of the text producer (files flagged `validate`: the non-bundled sources)
  validateFiles({ files, symbols, optionsContext: lowering.optionsContext, sources: loaded.sources, issues })
  return { document, sourceMap: options.sourceMap === false ? {} : sourceMap, issues }
}
