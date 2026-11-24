// Lowering of a service and its methods: request and response, idempotency and the `google.api.http` rule.

import type { ProtoApiHttpRule, ProtoApiMethod, ProtoApiService } from "../types.ts"
import type { MFile, MMethod, MService } from "../model.ts"
import { HTTP_RULE } from "../conventions/keys.ts"
import { withoutFeatureKeys } from "../features.ts"
import { ptr } from "../paths.ts"
import { servicePointer } from "../common/names.ts"
import { isPlainObject } from "../common/objects.ts"
import type { LowerContext } from "./context.ts"
import { DEPRECATED, docKeywords, finish, head, refOf } from "./emit.ts"

/** The keywords of a method written from one of its options (source map entries, in this order). */
const METHOD_KEYWORDS: Record<string, string> = {
  idempotency: "idempotency_level",
  http: HTTP_RULE,
  deprecation: "deprecated",
}

/** google.api.HttpRule -> { method, path, body?, responseBody?, additionalBindings? } (D16) */
export const normalizeHttp = (rule: Record<string, unknown>): ProtoApiHttpRule => {
  const out: Record<string, unknown> = {}
  for (const m of ["get", "put", "post", "delete", "patch"]) {
    if (typeof rule[m] === "string") {
      out.method = m.toUpperCase()
      out.path = rule[m]
      break
    }
  }
  if (!out.method && isPlainObject(rule.custom)) {
    out.method = String(rule.custom.kind ?? "")
    out.path = String(rule.custom.path ?? "")
  }
  if (!out.method) {
    out.method = ""
    out.path = ""
  }
  if (typeof rule.body === "string" && rule.body) out.body = rule.body
  if (typeof rule.response_body === "string" && rule.response_body) out.responseBody = rule.response_body
  if (Array.isArray(rule.additional_bindings) && rule.additional_bindings.length)
    out.additionalBindings = rule.additional_bindings
      .filter(isPlainObject)
      .map((r) => normalizeHttp(r as Record<string, unknown>))
  return out as unknown as ProtoApiHttpRule
}

const lowerMethod = (cx: LowerContext, m: MMethod, s: MService, file: MFile, mp: string): ProtoApiMethod => {
  const mo = withoutFeatureKeys(cx.opts(m, "method", file, s.fqn))
  const entry: Record<string, unknown> = {}
  let idempotency: unknown
  let http: ProtoApiHttpRule | undefined
  if (typeof mo.idempotency_level === "string") {
    idempotency = mo.idempotency_level
    delete mo.idempotency_level
  }
  if (isPlainObject(mo[HTTP_RULE])) {
    http = normalizeHttp(mo[HTTP_RULE])
    delete mo[HTTP_RULE]
  }
  const ma = cx.annotate("method", m, mo)
  docKeywords(entry, ma)
  entry.request = { schema: { $ref: refOf(m.input) }, ...(m.clientStreaming ? { stream: true } : {}) }
  entry.response = { schema: { $ref: refOf(m.output) }, ...(m.serverStreaming ? { stream: true } : {}) }
  if (idempotency !== undefined && idempotency !== "IDEMPOTENCY_UNKNOWN") entry.idempotency = idempotency
  if (http) entry.http = http
  if (Object.keys(ma.options).length) entry.options = ma.options
  finish(cx, entry, ma, `method ${m.name}`, file, mp, m, {
    keys: {
      request: "request",
      response: "response",
      "request/stream": "request/stream",
      "response/stream": "response/stream",
    },
    keywords: METHOD_KEYWORDS,
  })
  return entry as unknown as ProtoApiMethod
}

export const lowerService = (cx: LowerContext, s: MService): ProtoApiService => {
  const file = s.file
  const pointer = servicePointer(s.fqn)
  const options = withoutFeatureKeys(cx.opts(s, "service", file, s.fqn))
  const ann = cx.annotate("service", s, options)
  const out = head(cx, s.name, file, ann)
  const methods: Record<string, ProtoApiMethod> = {}
  for (const m of s.methods) {
    const mp = `${pointer}/methods/${ptr(m.name)}`
    if (m.name in methods) {
      cx.issue("duplicate-name", `method ${m.name} is declared more than once in ${s.fqn}`, file, mp, m.locs[""])
      continue
    }
    methods[m.name] = lowerMethod(cx, m, s, file, mp)
  }
  out.methods = methods
  if (Object.keys(ann.options).length) out.options = ann.options
  finish(cx, out, ann, `service ${s.fqn}`, file, pointer, s, { keywords: DEPRECATED })
  return out as unknown as ProtoApiService
}
