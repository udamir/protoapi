// Service declarations: options, and the methods with their lifted options (deprecated, idempotency_level, google.api.http) back in the options tree.

import type { ProtoApiHttpRule, ProtoApiMethod, ProtoApiService } from "../types.ts"
import { HTTP_RULE } from "../conventions/keys.ts"
import { lastSegment } from "../common/names.ts"
import { isPlainObject } from "../common/objects.ts"
import type { FilePrinter } from "./file-printer.ts"
import { elementComment } from "./comments.ts"
import { optionAssignments, withDeprecated } from "./option-values.ts"

type Obj = Record<string, unknown>

/** The google.api.HttpRule option tree of a normalised `http` keyword (the inverse of `normalizeHttp`). */
const httpRule = (h: ProtoApiHttpRule): Obj => {
  const m = `${h.method}`.toLowerCase()
  const t: Obj = ["get", "put", "post", "delete", "patch"].includes(m)
    ? { [m]: h.path }
    : { custom: { kind: h.method, path: h.path } }
  if (h.body) t.body = h.body
  if (h.responseBody) t.response_body = h.responseBody
  if (Array.isArray(h.additionalBindings)) t.additional_bindings = h.additionalBindings.map(httpRule)
  return t
}

/** A top-level service, printed in its own scope. */
export const printService = (p: FilePrinter, fqn: string, s: ProtoApiService) =>
  p.within(fqn, () => {
    const { oracle, tag } = p.ctx
    const out = p.out
    const name = lastSegment(fqn)
    out.comment(0, elementComment(tag, s, name))
    out.emit(0, `service ${name} {`)
    for (const line of optionAssignments(oracle, p.imports, withDeprecated(s), "service"))
      out.emit(1, `option ${line};`)
    for (const [mn, m] of Object.entries(isPlainObject(s.methods) ? s.methods : {}) as [string, ProtoApiMethod][]) {
      // the lifted method options back in the options tree: deprecated, idempotency_level, google.api.http
      const o = withDeprecated(m)
      if (m.idempotency) o.idempotency_level = m.idempotency
      if (isPlainObject(m.http)) o[HTTP_RULE] = httpRule(m.http)
      const body = optionAssignments(oracle, p.imports, o, "method").map((line) => `option ${line};`)
      out.comment(1, elementComment(tag, m, undefined))
      const ref = (x: ProtoApiMethod["request"] | undefined) =>
        typeof x?.schema?.$ref === "string" ? p.typeName(x.schema.$ref, p.ctx.members) : "google.protobuf.Empty"
      const req = `${m.request?.stream ? "stream " : ""}${ref(m.request)}`
      const res = `${m.response?.stream ? "stream " : ""}${ref(m.response)}`
      if (!body.length) out.emit(1, `rpc ${mn}(${req}) returns (${res});`)
      else {
        out.emit(1, `rpc ${mn}(${req}) returns (${res}) {`)
        for (const b of body) out.emit(2, b)
        out.emit(1, "}")
      }
    }
    out.emit(0, "}")
  })
