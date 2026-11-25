// protoapi: the ProtoApi 0.1 document format and its conversion tools, with the bundled definitions.
// `protoapi/core` has the same API without the bundled sources.

import { type ProtoApi, createProtoApi } from "./api.ts"
import { bundledSources } from "./bundle/sources.ts"

export * from "./shared.ts"

const api = createProtoApi(bundledSources)

export const buildFromProto: ProtoApi["buildFromProto"] = api.buildFromProto
export const buildFromProtoAsync: ProtoApi["buildFromProtoAsync"] = api.buildFromProtoAsync
export const buildFromDescriptorSet: ProtoApi["buildFromDescriptorSet"] = api.buildFromDescriptorSet
export const buildFromDescriptorSetBinary: ProtoApi["buildFromDescriptorSetBinary"] = api.buildFromDescriptorSetBinary
export const printProto: ProtoApi["printProto"] = api.printProto
/** The bundled `.proto` sources (import path -> text), see bundle/VERSIONS.md. */
export const bundledFiles: ProtoApi["bundledFiles"] = bundledSources
