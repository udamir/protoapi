// Printer (spec §6): ProtoApiDocument -> .proto text, one text per file. The guarantee is on the document: build(print(build(x))) equals build(x) except for x-annotation-conflicts and description whitespace.
//
// Lifted keywords are printed back as the convention option they can come from when the file's written imports (and their public re-exports) make that option available, in the precedence order of spec §3.8; otherwise as a comment tag or an AIP prefix. Resolved features (packed, utf8Validation, jsonFormat) and inherited editions features are printed in the spelling of the file's syntax.

import type { PrintOptions, ProtoApiDocument, ProtoApiFile } from "../types.ts"
import { tagSpelling } from "../conventions/tags.ts"
import { isPlainObject, setKey } from "../common/objects.ts"
import { Oracle } from "./oracle.ts"
import { type Placement, placeWithFiles, placeWithoutFiles } from "./layout.ts"
import { symbolNames } from "./names.ts"
import { FilePrinter, type PrintContext } from "./file-printer.ts"
import { renderFile } from "./render-file.ts"

/** A printer whose option-value types come from the given bundle (`protoapi` injects the bundled definitions). */
export const createPrinter =
  (bundle: Readonly<Record<string, string>>) =>
  /** Print a document back to `.proto` files (path -> text); files marked `bundled` are not printed. */
  (doc: ProtoApiDocument, options: PrintOptions = {}): Record<string, string> => {
    if (!isPlainObject(doc) || !isPlainObject(options)) throw new TypeError("printProto: wrong argument types")
    return printWith(doc, options, bundle)
  }

const printWith = (
  doc: ProtoApiDocument,
  options: PrintOptions,
  bundle: Readonly<Record<string, string>>,
): Record<string, string> => {
  const indent = typeof options.indent === "string" ? options.indent : "  "
  const tag = tagSpelling(options.tags)
  const oracle = new Oracle(doc, bundle, isPlainObject(options.sources) ? options.sources : undefined)
  const fileName = typeof options.fileName === "string" && options.fileName ? options.fileName : "protoapi.proto"
  const docFiles = isPlainObject(doc.files) ? (doc.files as Record<string, ProtoApiFile>) : undefined
  const { placement, files }: Placement =
    docFiles && Object.keys(docFiles).length ? placeWithFiles(doc, docFiles) : placeWithoutFiles(doc, fileName, bundle)
  const names = symbolNames(doc, oracle, files)
  const ctx: PrintContext = {
    doc,
    oracle,
    indent,
    tag,
    names,
    members: symbolNames(doc, oracle, files, true),
    placement,
    files,
  }
  const out: Record<string, string> = {}
  // files marked `bundled` are not printed: a rebuild resolves them from the bundle
  for (const [path, f] of Object.entries(files))
    if (!f.bundled) setKey(out, path, renderFile(new FilePrinter(ctx, path, f)))
  return out
}
