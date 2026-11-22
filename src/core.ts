// protoapi/core: the protoapi API without the bundled convention sources (validation decision PK-1). It keeps
// google/protobuf/descriptor.proto and cpp/java/go_features.proto, so built-in options and `features.*` are typed
// (design §17 item 4, "registry always included"). Imports of the well-known types, googleapis, protovalidate, PGV
// and grpc-gateway must come from `sources`, a loader, the `bundle` option or the descriptor set.

import { type ProtoApi, createProtoApi } from "./api"
import { coreSources } from "./bundle/core-sources"

export * from "./shared"

const api = createProtoApi(coreSources)

export const buildFromProto: ProtoApi["buildFromProto"] = api.buildFromProto
export const buildFromProtoAsync: ProtoApi["buildFromProtoAsync"] = api.buildFromProtoAsync
export const buildFromDescriptorSet: ProtoApi["buildFromDescriptorSet"] = api.buildFromDescriptorSet
export const buildFromDescriptorSetBinary: ProtoApi["buildFromDescriptorSetBinary"] = api.buildFromDescriptorSetBinary
export const printProto: ProtoApi["printProto"] = api.printProto
/** descriptor.proto and cpp/java/go_features.proto in protoapi/core. */
export const bundledFiles: ProtoApi["bundledFiles"] = api.bundledFiles
