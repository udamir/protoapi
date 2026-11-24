// Binary FileDescriptorSet decoding with the optional peer dependency @bufbuild/protobuf.
//
// The set is decoded with `FileDescriptorSetSchema`; custom options arrive as unknown fields and are converted by `toJson` with a registry. The registry is built per file from the set plus the bundled definitions, so one file that @bufbuild/protobuf cannot load (a future edition, a missing import) only loses its own definitions. Every fallback is reported: `unsupported` when a file's definitions cannot be loaded or decoded, `unknown-option` when an option field has no definition anywhere. buf's `ImageFile.buf_extension` (field 8042) is read from the unknown fields, so `bufExtension.isImport` survives the binary path.
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
  type UnknownField,
} from "./binary/bufbuild.ts"
import { buildRegistry } from "./binary/registry.ts"
import { OPTION_SCHEMAS, checkUnknownFields, eachElement, scanFileRecords } from "./binary/unknown-fields.ts"
import { WIRE_OPTIONS } from "./frontend/descriptor/json.ts"

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

type Json = Record<string, unknown>

/**
 * The options of a file whose ProtoJSON @bufbuild/protobuf cannot write as a whole (`toJson` throws for an `Any` of a type the registry does not have, an out-of-range `Timestamp` or `Duration`, …): each `*Options` message is converted on its own, and in one that still fails each option field on its own. The fields that fail stay wire bytes under `WIRE_OPTIONS`, which the option interpreter decodes against the set's definitions as the text producer does; every other option keeps its ProtoJSON. `json` is the file's ProtoJSON without custom options, walked in parallel with `fd`.
 */
const rescueOptions = (pb: Any, wkt: Any, registry: Any, fd: FileProto, json: Json) =>
  eachElement(fd, json, (d, kind, j) => {
    const opts = d.options
    const unknown = opts?.$unknown ?? []
    const schema = wkt[OPTION_SCHEMAS[kind]]
    if (!unknown.length || !schema || !j) return
    const convert = (keep: UnknownField[]): Json | undefined => {
      try {
        return pb.toJson(schema, { ...opts, $unknown: keep }, { registry })
      } catch {
        return undefined
      }
    }
    let out = convert(unknown)
    if (!out) {
      const failing = new Set<number>()
      for (const no of new Set(unknown.map((u) => u.no)))
        if (!convert(unknown.filter((u) => u.no === no))) failing.add(no)
      let keep = unknown.filter((u) => !failing.has(u.no))
      // fields that convert one by one but not together all stay bytes
      out = convert(keep) ?? convert((keep = [])) ?? {}
      ;(out as Record<symbol, unknown>)[WIRE_OPTIONS] = unknown.filter((u) => !keep.includes(u))
    }
    j.options = out
  })

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
    } catch {
      // one option value without a ProtoJSON form fails the whole file: convert each options message on its own
      json = pb.toJson(wkt.FileDescriptorProtoSchema, fd)
      rescueOptions(pb, wkt, registry, fd, json)
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
