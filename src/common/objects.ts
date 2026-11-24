// Object tests: plain (JSON-like) objects, as opposed to arrays, null and bytes.

/** An object that is neither null nor an array (a JSON object, an option tree, a ProtoJSON message). */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** A plain object that is not bytes (`Uint8Array`): the test of the public arguments, where bytes are a different argument. */
export const isPlainObjectNotBytes = (v: unknown): v is Record<string, unknown> =>
  isPlainObject(v) && !(v instanceof Uint8Array)
