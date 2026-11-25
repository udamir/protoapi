// The internal model shared by both front ends: element types and the factories that create them.

export type * from "./types.ts"
export { addPending, newEnum, newFile, newHolder, newMessage } from "./factories.ts"
