// Lowering of a file entry of `files`: description, syntax, package, imports and their flags, options, `bundled`.

import type { ProtoApiFile } from "../types.ts"
import type { MFile } from "../model/index.ts"
import { withoutFeatureKeys } from "../features.ts"
import { normalizeComment } from "../comments.ts"
import { filePointer } from "../common/names.ts"
import { setKey } from "../common/objects.ts"
import type { LowerContext } from "./context.ts"

export const lowerFile = (cx: LowerContext, f: MFile): ProtoApiFile => {
  const pointer = filePointer(f.path)
  const out: Record<string, unknown> = {}
  // a bundled file that is not an entry is marked (spec §4.1); its header is its licence text, not documentation
  const marked = f.bundled && !cx.entry.has(f.path)
  const header = marked ? undefined : normalizeComment(f.header)
  if (header) out.description = header
  if (!f.syntaxUnknown) out.syntax = f.syntax
  if (f.package) out.package = f.package
  if (f.imports.length) out.imports = f.imports.map((i) => i.path)
  const flags: Record<string, string> = {}
  for (const i of f.imports) if (i.flag) setKey(flags, i.path, i.flag)
  if (Object.keys(flags).length) out.importFlags = flags
  const options = withoutFeatureKeys(cx.opts(f, "file", f, f.package))
  if (Object.keys(options).length) out.options = options
  if (marked) out.bundled = true
  cx.sourceMap.mapLocs(pointer, f.locs, { syntax: "syntax", package: "package" })
  f.imports.forEach((imp, i) => cx.sourceMap.map(`${pointer}/imports/${i}`, imp.loc))
  cx.sourceMap.mapOptions(pointer, f, out.options as object | undefined)
  cx.flush(f, pointer, f, f.locs[""])
  return out as unknown as ProtoApiFile
}
