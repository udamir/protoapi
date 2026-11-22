// Fragment matcher for the mapping catalogue (design Appendix A, "How to read the examples").
//
// Rules, applied to an expected value transcribed from the design's YAML:
// - the string "…" matches any present value (elided bundled-file descriptions, `description: …`);
// - an object with the key "…" (any value) is open: other actual keys are allowed;
// - any other object must have exactly the expected keys (order ignored), except that `title` and `file` may be
//   missing from the expectation on component objects (services, messages, enums, extensions), and keys listed in
//   `ignoreKeys` may be missing anywhere below the assertion's pointer;
// - arrays match element-wise and in order; primitives match with Object.is.

import type { BuildIssue, Location } from "../../src"

export const ELLIPSIS = "…"

export interface MatchOptions {
  /** keys that may be present in the actual value without being expected, anywhere in the subtree */
  ignoreKeys?: string[]
}

/** RFC 6901 pointer (with or without the leading `#`) to unescaped segments. */
export const parsePointer = (pointer: string): string[] => {
  const p = pointer.startsWith("#") ? pointer.slice(1) : pointer
  if (p === "") return []
  if (!p.startsWith("/")) throw new Error(`invalid pointer ${pointer}`)
  return p
    .slice(1)
    .split("/")
    .map((s) => s.split("~1").join("/").split("~0").join("~"))
}

export const formatPointer = (segments: string[]): string =>
  `#${segments.map((s) => `/${s.split("~").join("~0").split("/").join("~1")}`).join("")}`

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Value at a pointer, or `undefined` when a segment is missing. */
export const resolvePointer = (root: unknown, pointer: string): unknown => {
  let node: unknown = root
  for (const seg of parsePointer(pointer)) {
    if (Array.isArray(node)) node = node[Number(seg)]
    else if (isObject(node)) node = has(node, seg) ? node[seg] : undefined
    else return undefined
  }
  return node
}

const isComponentPath = (path: string[]): boolean =>
  (path.length === 3 && path[0] === "components" && ["messages", "enums", "extensions"].includes(path[1])) ||
  (path.length === 2 && path[0] === "services")

const show = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v)?.slice(0, 160))

/** Mismatches between `actual` and `expected`, as `pointer: message` lines (empty when they match). */
export const matchFragment = (
  actual: unknown,
  expected: unknown,
  path: string[] = [],
  options: MatchOptions = {},
  out: string[] = [],
): string[] => {
  const at = formatPointer(path)
  if (expected === ELLIPSIS) {
    if (actual === undefined) out.push(`${at}: missing (expected any value)`)
    return out
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${at}: expected an array ${show(expected)}, got ${show(actual)}`)
      return out
    }
    if (actual.length !== expected.length)
      out.push(`${at}: expected ${expected.length} items, got ${actual.length}: ${show(actual)}`)
    expected.forEach((e, i) => {
      if (i < actual.length) matchFragment(actual[i], e, [...path, String(i)], options, out)
    })
    return out
  }
  if (isObject(expected)) {
    if (!isObject(actual)) {
      out.push(`${at}: expected an object ${show(expected)}, got ${show(actual)}`)
      return out
    }
    const open = has(expected, ELLIPSIS)
    for (const [k, v] of Object.entries(expected)) {
      if (k === ELLIPSIS) continue
      if (!has(actual, k)) out.push(`${formatPointer([...path, k])}: missing, expected ${show(v)}`)
      else matchFragment(actual[k], v, [...path, k], options, out)
    }
    if (!open) {
      for (const k of Object.keys(actual)) {
        if (has(expected, k)) continue
        if (options.ignoreKeys?.includes(k)) continue
        if ((k === "title" || k === "file") && isComponentPath(path)) continue
        out.push(`${formatPointer([...path, k])}: unexpected key, value ${show(actual[k])}`)
      }
    }
    return out
  }
  if (!Object.is(actual, expected)) out.push(`${at}: expected ${show(expected)}, got ${show(actual)}`)
  return out
}

// ---- issues ----------------------------------------------------------------------------------------------------

/**
 * Issue spec: `code @ pointer`, `code @ pointer/**` (the pointer or any descendant), `code @ *` (any pointer or
 * none), optionally followed by ` at file:line:column` (zero-based start of the issue location).
 */
export interface IssueSpec {
  code: string
  pointer: string
  prefix: boolean
  any: boolean
  at?: { file: string; line: number; column: number }
  text: string
}

export const parseIssueSpec = (text: string): IssueSpec => {
  const m = /^(\S+) @ (\S+)(?: at (\S+):(\d+):(\d+))?$/.exec(text.trim())
  if (!m) throw new Error(`invalid issue spec: ${text}`)
  const [, code, ptr, file, line, column] = m
  const prefix = ptr.endsWith("/**")
  return {
    code,
    pointer: prefix ? ptr.slice(0, -3) : ptr,
    prefix,
    any: ptr === "*",
    at: file ? { file, line: Number(line), column: Number(column) } : undefined,
    text,
  }
}

export const issueMatches = (spec: IssueSpec, issue: BuildIssue): boolean => {
  if (issue.code !== spec.code) return false
  if (!spec.any) {
    const p = issue.pointer ?? ""
    if (spec.prefix ? !(p === spec.pointer || p.startsWith(`${spec.pointer}/`)) : p !== spec.pointer) return false
  }
  if (spec.at) {
    const loc = issue.location
    if (!loc || (loc.file ?? issue.file) !== spec.at.file) return false
    if (loc.start.line !== spec.at.line || loc.start.column !== spec.at.column) return false
  }
  return true
}

export const formatIssue = (i: BuildIssue): string => {
  const loc = i.location ? ` at ${i.location.file}:${i.location.start.line}:${i.location.start.column}` : ""
  return `${i.code} @ ${i.pointer ?? "(none)"}${loc} -- ${i.message}`
}

/** Mismatches between the expected issue specs (an exact multiset, order-insensitive) and the actual issues. */
export const matchIssues = (actual: BuildIssue[], specs: string[]): string[] => {
  const out: string[] = []
  const left = [...actual]
  for (const text of specs) {
    const spec = parseIssueSpec(text)
    const i = left.findIndex((issue) => issueMatches(spec, issue))
    if (i < 0) out.push(`missing issue: ${text}`)
    else left.splice(i, 1)
  }
  for (const issue of left) out.push(`unexpected issue: ${formatIssue(issue)}`)
  return out
}

// ---- source map ------------------------------------------------------------------------------------------------

/** `"L:C-L:C"` (zero-based, end exclusive) for a location. */
export const formatSpan = (loc: Location | undefined): string | undefined =>
  loc && `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`
