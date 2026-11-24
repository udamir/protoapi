// Binary FileDescriptorSet decoding with the optional peer dependency @bufbuild/protobuf (design §6.1, IN-8).
//
// The set is decoded with `FileDescriptorSetSchema`; custom options arrive as unknown fields and are converted by
// `toJson` with a registry. The registry is built per file from the set plus the bundled definitions (validation
// decision 16), so one file that @bufbuild/protobuf cannot load (a future edition, a missing import) only loses its own
// definitions. Every fallback is reported: `unsupported` when a file's definitions cannot be loaded or decoded,
// `unknown-option` when an option field has no definition anywhere. buf's `ImageFile.buf_extension` (field 8042) is
// read from the unknown fields, so `bufExtension.isImport` survives the binary path (C-3).
//
// This file loads the package and decodes; the registry, the model -> FileDescriptorProto serializer and the unknown-field scanning are in src/binary/.

import type { FileDescriptorSetJson } from "./types.ts"
import { EDITION_NUMBERS } from "./common/editions.ts"
import {
  type Any,
  BUFBUILD_MINIMUM,
  type BinaryContext,
  type BufbuildModules,
  type FileProto,
} from "./binary/bufbuild.ts"
import { buildRegistry } from "./binary/registry.ts"
import { checkUnknownFields, scanFileRecords } from "./binary/unknown-fields.ts"

export { BUFBUILD_2026, BUFBUILD_MINIMUM } from "./binary/bufbuild.ts"
export type { BinaryContext, BufbuildModules } from "./binary/bufbuild.ts"
export { readBufExtension } from "./binary/unknown-fields.ts"

/** Load @bufbuild/protobuf with a dynamic import; a missing package is an error with a version hint. */
export const loadBufbuild = async (
  importer: (specifier: string) => Promise<Any> = (specifier) => import(/* @vite-ignore */ specifier),
): Promise<BufbuildModules> => {
  const pkg = "@bufbuild/protobuf"
  let pb: Any
  try {
    pb = await importer(pkg)
  } catch {
    throw new Error(
      `the optional peer dependency @bufbuild/protobuf (>= ${BUFBUILD_MINIMUM}) is not installed; install it or pass a \`decoder\``,
    )
  }
  let wkt: Any
  try {
    wkt = await importer(`${pkg}/wkt`)
  } catch {
    wkt = undefined
  }
  return { pb, wkt }
}

/** Decode a binary FileDescriptorSet (or buf image) to its ProtoJSON form. Throws when no usable decoder exists. */
export const decodeWithBufbuild = async (
  bytes: Uint8Array,
  ctx: BinaryContext,
  load: () => Promise<BufbuildModules> = loadBufbuild,
): Promise<FileDescriptorSetJson> => {
  const { pb, wkt } = await load()
  if (
    typeof pb?.fromBinary !== "function" ||
    typeof pb?.toJson !== "function" ||
    typeof pb?.createFileRegistry !== "function" ||
    !wkt?.FileDescriptorSetSchema
  )
    throw new Error(
      `the installed @bufbuild/protobuf is not a 2.x release (v1 has no fromBinary / FileDescriptorSetSchema); protoapi needs @bufbuild/protobuf >= ${BUFBUILD_MINIMUM}`,
    )
  const maxEdition: number = typeof pb.maximumEdition === "number" ? pb.maximumEdition : EDITION_NUMBERS.EDITION_2023
  const set = pb.fromBinary(wkt.FileDescriptorSetSchema, bytes)
  const files: FileProto[] = set.file ?? []
  // read from the bytes: buf_extension, and an edition the decoder's closed `Edition` enum does not know (which
  // @bufbuild/protobuf 2.17 loses when the file also has other unknown fields)
  const raw = scanFileRecords(bytes)
  const rawEdition = new Map<FileProto, number>()
  files.forEach((fd, i) => {
    const e = raw[i]?.edition
    if (e !== undefined && e !== fd.edition) rawEdition.set(fd, e)
  })
  const registry = buildRegistry(pb, wkt, files, ctx, maxEdition, rawEdition)
  const out: Record<string, unknown>[] = []
  files.forEach((fd, i) => {
    let json: Record<string, unknown>
    try {
      json = pb.toJson(wkt.FileDescriptorProtoSchema, fd, { registry })
    } catch (e) {
      ctx.issues.push({
        code: "unsupported",
        message: `custom options of ${fd.name} cannot be decoded (${(e as Error).message}); they are dropped`,
        file: fd.name,
      })
      json = pb.toJson(wkt.FileDescriptorProtoSchema, fd)
    }
    const ext = raw[i]?.bufExtension
    if (ext) json.bufExtension = ext
    const edition = rawEdition.get(fd)
    if (edition !== undefined) json.edition = edition
    checkUnknownFields(fd, wkt, registry, ctx.issues, maxEdition)
    out.push(json)
  })
  return { file: out }
}
