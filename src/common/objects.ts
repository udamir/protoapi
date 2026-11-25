// Object tests: plain (JSON-like) objects, as opposed to arrays, null and bytes; and own-key access for objects keyed by user names.

/** An object that is neither null nor an array (a JSON object, an option tree, a ProtoJSON message). */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** A plain object that is not bytes (`Uint8Array`): the test of the public arguments, where bytes are a different argument. */
export const isPlainObjectNotBytes = (v: unknown): v is Record<string, unknown> =>
  isPlainObject(v) && !(v instanceof Uint8Array)

/** Whether `o` has the own key `k`: a user name such as `constructor`, `toString` or `__proto__` is not found through Object.prototype. */
export const hasKey = (o: object, k: string): boolean => Object.hasOwn(o, k)

/** The value of the own key `k` of `o`, undefined when `o` is undefined or has no such key (never a member of Object.prototype). */
export const getKey = <T>(o: Readonly<Record<string, T>> | undefined, k: string): T | undefined =>
  o && Object.hasOwn(o, k) ? o[k] : undefined

/** Set the own key `k` of `o`: `__proto__` becomes an ordinary own key, which JSON.stringify writes, instead of replacing the prototype. Keeps the key order of plain assignment. */
export const setKey = <T>(o: Record<string, T>, k: string, v: NoInfer<T>): void => {
  if (k === "__proto__" && !Object.hasOwn(o, k))
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
  else o[k] = v
}
