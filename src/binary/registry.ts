// The @bufbuild/protobuf registry of a binary set, built per file from the set plus the bundled definitions: a file that cannot be loaded loses only its own definitions, and the loss is reported.

import type { MFile } from "../model/index.ts"
import { SymbolTable } from "../symbols.ts"
import { linkAll } from "../resolve.ts"
import { OptionsContext } from "../lower/context.ts"
import { EDITION_NUMBERS, editionNameOfNumber, knownSyntaxOfEdition } from "../common/editions.ts"
import { ImportClosure } from "../build/closure.ts"
import { convertFile } from "../frontend/descriptor/convert.ts"
import { modelToDescriptorJson } from "./descriptor-json.ts"
import {
  type Any,
  type BinaryContext,
  type FileProto,
  type MessageProto,
  VERSION_HINT,
  editionLabel,
} from "./bufbuild.ts"

const definesExtensions = (fd: FileProto): boolean => {
  const inMessage = (m: MessageProto): boolean =>
    (m.extension?.length ?? 0) > 0 || (m.nestedType ?? []).some((n) => inMessage(n))
  return (fd.extension?.length ?? 0) > 0 || (fd.messageType ?? []).some((m) => inMessage(m))
}

export const buildRegistry = (
  pb: Any,
  wkt: Any,
  files: FileProto[],
  ctx: BinaryContext,
  maxEdition: number,
  rawEdition: Map<FileProto, number>,
): Any => {
  const byName = new Map<string, FileProto>(files.map((f) => [f.name, f]))
  const bundled = bundledProtos(pb, wkt, files, ctx)
  const descs = new Map<string, Any | null>()
  const reasons = new Map<string, string>()
  const inSet = new Set(byName.keys())
  const fail = (name: string, proto: FileProto, reason: string, always: boolean) => {
    reasons.set(name, reason)
    if (inSet.has(name) && (always || definesExtensions(proto)))
      ctx.issues.push({
        code: "unsupported",
        message: `the definitions in ${name} cannot be loaded into the @bufbuild/protobuf registry (${reason}); options that use them are not decoded`,
        file: name,
      })
  }
  const visit = (name: string): Any | undefined => {
    if (descs.has(name)) return descs.get(name) ?? undefined
    descs.set(name, null)
    const proto = byName.get(name) ?? bundled.get(name)
    if (!proto) {
      reasons.set(name, "neither in the set nor in the bundle")
      return undefined
    }
    for (const dep of proto.dependency ?? []) visit(dep)
    const edition: number = rawEdition.get(proto) ?? proto.edition
    if (proto.syntax === "editions" && edition > maxEdition && edition !== EDITION_NUMBERS.EDITION_UNSTABLE) {
      const known = knownSyntaxOfEdition(editionNameOfNumber(edition)) !== undefined
      fail(
        name,
        proto,
        `${editionLabel(edition)} is newer than the installed @bufbuild/protobuf supports (up to ${editionLabel(maxEdition)})${known ? `; ${VERSION_HINT}` : ""}`,
        true,
      )
      return undefined
    }
    const missing = (proto.dependency ?? []).find((d: string) => !descs.get(d))
    if (missing) {
      fail(name, proto, `import ${missing} is not available: ${reasons.get(missing) ?? "it cannot be loaded"}`, false)
      return undefined
    }
    try {
      const reg = pb.createFileRegistry(proto, (dep: string) => descs.get(dep) ?? undefined)
      const desc = reg.getFile(name)
      descs.set(name, desc ?? null)
      return desc
    } catch (e) {
      fail(name, proto, (e as Error).message, true)
      return undefined
    }
  }
  for (const f of files) visit(f.name)
  const loaded = [...descs.values()].filter((d) => d)
  return typeof pb.createRegistry === "function" ? pb.createRegistry(...loaded) : pb.createFileRegistry(...loaded)
}

/** FileDescriptorProto messages for bundled files the set imports but does not contain (transitively). */
const bundledProtos = (pb: Any, wkt: Any, files: FileProto[], ctx: BinaryContext): Map<string, FileProto> => {
  const out = new Map<string, FileProto>()
  const byName = new Map(files.map((f) => [f.name as string, f]))
  const wanted = new Set<string>()
  const models = new Map<string, MFile>()
  const texts = new Map<string, string>()
  const deps: string[] = files.flatMap((f) => (f.dependency ?? []) as string[]).filter((d) => !byName.has(d))
  if (!deps.length || !wkt.FileDescriptorProtoSchema || typeof pb.fromJson !== "function") return out
  for (const d of deps) wanted.add(d)
  // the closure of the wanted bundled files, with the set's version of a file the set has (so that names resolve, and its descriptor.proto gives the edition defaults)
  const closure = new ImportClosure(deps)
  for (let path = closure.next(); path !== undefined; path = closure.next()) {
    const own = byName.get(path)
    const text = own ? undefined : ctx.bundleText(path)
    if (!own && text === undefined) continue
    const model = own
      ? convertFile(pb.toJson(wkt.FileDescriptorProtoSchema, own), [])
      : ctx.bundledFile(path, text as string)
    models.set(path, model)
    if (text !== undefined) texts.set(path, text)
    for (const imp of model.imports) {
      if (!byName.has(imp.path)) wanted.add(imp.path)
      closure.add(imp.path)
    }
  }
  if (!models.size) return out
  const symbols = new SymbolTable([...models.values()])
  // the edition defaults of the descriptor.proto among them (`BuildOptions.bundle` may replace it) decide the symbol visibility, as in a build
  const options = new OptionsContext(symbols, texts)
  linkAll([...models.values()], symbols, () => options.featureTable())
  for (const path of wanted) {
    const model = models.get(path)
    if (!model) continue
    try {
      out.set(path, pb.fromJson(wkt.FileDescriptorProtoSchema, modelToDescriptorJson(model)))
    } catch {
      // not representable: the file stays unavailable and its importers report it
    }
  }
  return out
}
