// Lowering (design §7): model -> ProtoApiDocument + source map + issues. Shared by both producers.

import type {
  ProtoApiDocument,
  ProtoApiEnum,
  ProtoApiExtension,
  ProtoApiFile,
  ProtoApiMessage,
  ProtoApiService,
} from "../types.ts"
import type { Locs, MEnum, MField, MMessage, OptionTree } from "../model/index.ts"
import { tagCollisions } from "../conventions/tags.ts"
import { enumPointer, filePointer, messagePointer, parentScope, servicePointer } from "../common/names.ts"
import { LowerContext, type LowerInput, type LowerOutput, type OptionsContext } from "./context.ts"
import { Emission } from "./emission.ts"
import { lowerMessage } from "./message.ts"
import { lowerEnum } from "./enum.ts"
import { lowerService } from "./service.ts"
import { lowerExtension } from "./extension.ts"
import { lowerFile } from "./file.ts"

export type { LowerInput, LowerOutput, OptionsContext } from "./context.ts"

/** Duplicate component names reported by the symbol table (outside the bundle). */
const reportDuplicates = (cx: LowerContext) => {
  for (const d of cx.input.symbols.duplicates) {
    const file = d.second.file
    if (!file || file.bundled) continue
    const pointer =
      d.second.kind === "enum"
        ? enumPointer(d.fqn)
        : d.second.kind === "service"
          ? servicePointer(d.fqn)
          : messagePointer(d.fqn)
    const node = d.second.node as { locs?: Locs } | undefined
    cx.issue(
      "duplicate-name",
      `${d.fqn} is declared more than once (${d.first.file?.path ?? "?"}, ${file.path})`,
      file,
      pointer,
      node?.locs?.[""],
    )
  }
}

export class Lowering {
  private readonly cx: LowerContext

  constructor(input: LowerInput) {
    this.cx = new LowerContext(input)
    // A-14: a tag rename that takes another tag's name
    if (this.cx.mode === "all")
      for (const message of tagCollisions(input.options.tags)) input.issues.push({ code: "invalid-tag", message })
  }

  /** The typed options and edition defaults of this build (the validator reads them again). */
  get optionsContext(): OptionsContext {
    return this.cx
  }

  run(): LowerOutput {
    const cx = this.cx
    const emission = new Emission(cx)
    const messages: Record<string, ProtoApiMessage> = {}
    const enums: Record<string, ProtoApiEnum> = {}
    const extensions: Record<string, ProtoApiExtension> = {}
    const services: Record<string, ProtoApiService> = {}
    const files: Record<string, ProtoApiFile> = {}
    const usedFiles = new Set<string>()

    for (const file of emission.files) {
      const emitAll = emission.full(file)
      const fileOpts = cx.opts(file, "file", file, file.package)
      // a file's own enums and extensions come before those of its messages
      const enumQueue: { e: MEnum; chain: OptionTree[] }[] = file.enums.map((e) => ({ e, chain: [fileOpts] }))
      const extQueue: { x: MField; chain: OptionTree[]; scope: string }[] = emitAll
        ? file.extensions.map((x) => ({ x, chain: [fileOpts], scope: file.package }))
        : []
      const walk = (m: MMessage, chain: OptionTree[]) => {
        const mo = cx.opts(m, "message", file, parentScope(m.fqn))
        const inner = [...chain, mo]
        if (emission.messages.has(m.fqn) && !(m.fqn in messages)) {
          messages[m.fqn] = lowerMessage(cx, m, chain)
          usedFiles.add(file.path)
        }
        for (const e of m.enums) enumQueue.push({ e, chain: inner })
        for (const x of m.extensions) if (emitAll) extQueue.push({ x, chain: inner, scope: m.fqn })
        for (const n of m.nested) walk(n, inner)
      }
      for (const m of file.messages) walk(m, [fileOpts])
      if (emitAll) {
        for (const s of file.services) {
          if (!(s.fqn in services)) services[s.fqn] = lowerService(cx, s)
          usedFiles.add(file.path)
        }
      }
      for (const { e, chain } of enumQueue) {
        if (emission.enums.has(e.fqn) && !(e.fqn in enums)) {
          enums[e.fqn] = lowerEnum(cx, e, chain)
          usedFiles.add(file.path)
        }
      }
      for (const { x, chain, scope } of extQueue) {
        const fqn = x.fqn ?? x.name
        if (fqn in extensions) continue
        extensions[fqn] = lowerExtension(cx, x, file, chain, scope)
        usedFiles.add(file.path)
      }
    }
    reportDuplicates(cx)
    if (cx.useFiles) {
      for (const file of emission.files) {
        if (emission.full(file) || usedFiles.has(file.path)) files[file.path] = lowerFile(cx, file)
      }
    } else {
      for (const file of emission.files) cx.flush(file, filePointer(file.path), file, file.locs[""])
    }
    const document: ProtoApiDocument = { protoapi: "0.1" }
    if (cx.useFiles && Object.keys(files).length) document.files = files
    if (Object.keys(services).length) document.services = services
    const components: NonNullable<ProtoApiDocument["components"]> = {}
    if (Object.keys(messages).length) components.messages = messages
    if (Object.keys(enums).length) components.enums = enums
    if (Object.keys(extensions).length) components.extensions = extensions
    if (Object.keys(components).length) document.components = components
    return { document, sourceMap: cx.sourceMap.toSourceMap() }
  }
}
