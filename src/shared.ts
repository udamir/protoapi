// Exports shared by `protoapi` and `protoapi/core` that do not depend on the bundle.

export * from "./types"
export { createProtoApi, type ProtoApi } from "./api"
export { locatePointer, locateDiff, type LocatableDiff } from "./locate"
export { parseProto } from "./parser"
export { normalizeComment } from "./comments"
export { defaultJsonName } from "./values"
