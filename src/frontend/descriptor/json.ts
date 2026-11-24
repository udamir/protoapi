// Readers of ProtoJSON descriptor messages: fields by lowerCamelCase or snake_case name, lists, scalars, enum names.

import { toSnake } from "../../values/json-name.ts"
import { isPlainObject } from "../../common/objects.ts"

export type Json = Record<string, unknown>

/** Read a ProtoJSON field by lowerCamelCase or snake_case name. */
const snakeCache = new Map<string, string>()
export const get = <T = unknown>(o: Json | undefined, camel: string): T | undefined => {
  if (!o) return undefined
  const v = o[camel]
  if (v !== undefined) return v as T
  let snake = snakeCache.get(camel)
  if (snake === undefined) snakeCache.set(camel, (snake = toSnake(camel)))
  return snake === camel ? undefined : (o[snake] as T | undefined)
}
export const arr = (o: Json | undefined, camel: string): Json[] => {
  const v = get<unknown>(o, camel)
  return Array.isArray(v) ? (v.filter(isPlainObject) as Json[]) : []
}
export const list = <T>(o: Json | undefined, camel: string): T[] => {
  const v = get<unknown>(o, camel)
  return Array.isArray(v) ? (v.filter((x) => x !== null && typeof x !== "object") as T[]) : []
}
/** The numbers of a list (a path or a span), without the filter and map passes of `list`. */
export const numbers = (v: unknown): number[] => {
  const out: number[] = []
  if (Array.isArray(v)) for (const x of v) if (x !== null && typeof x !== "object") out.push(Number(x))
  return out
}
export const str = (o: Json | undefined, camel: string): string | undefined => {
  const v = get(o, camel)
  return v === undefined ? undefined : String(v)
}
export const num = (o: Json | undefined, camel: string): number | undefined => {
  const v = get(o, camel)
  return v === undefined ? undefined : Number(v)
}
export const enumStr = (v: unknown, byNumber?: Record<number, string>): string | undefined =>
  v === undefined ? undefined : typeof v === "number" ? (byNumber?.[v] ?? String(v)) : String(v)
