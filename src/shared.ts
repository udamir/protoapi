// Exports shared by `protoapi` and `protoapi/core` that do not depend on the bundle.

export * from "./types.ts"
export { createProtoApi, type ProtoApi } from "./api.ts"
export { locatePointer, locateDiff, type LocatableDiff } from "./locate.ts"
export { parseProto } from "./parser/index.ts"
export { normalizeComment } from "./comments.ts"
export { defaultJsonName } from "./values/json-name.ts"
