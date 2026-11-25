// Linking: resolve type names, extendees and method types against the symbol table, index extensions by extendee. Shared by both front ends (descriptor names are absolute, text names relative).

import type { MField, MFile, MMessage, MOptionHolder, MTypeRef } from "./model/index.ts"
import { type LookupFrom, type LookupResult, type SymbolTable, kindName, unresolvedKey } from "./symbols.ts"
import { addPending } from "./model/index.ts"
import { FEATURE_SET, type FeatureDefaults } from "./features.ts"

const kindPhrase = (kind: string) => (kind === "message" || kind === "enum" ? `${kind} type` : kindName(kind as never))

/** The reason a name did not resolve to a symbol of the wanted kind, for the issue message. */
export const unresolvedWhy = (
  name: string,
  r: LookupResult,
  symbols: SymbolTable,
  from: LookupFrom,
  wanted: string,
): string => {
  if (r.found) return `${name} resolves to ${kindPhrase(r.found.kind)} ${r.found.fqn}, which is not ${wanted}`
  if (r.hidden) return symbols.hiddenReason(r.hidden, from)
  if (r.wrongKind)
    return `${name} resolves to ${kindPhrase(r.wrongKind.kind)} ${r.wrongKind.fqn}, which is not ${wanted}`
  return `${name} is not defined`
}

const resolveType = (
  t: MTypeRef | undefined,
  scope: string,
  file: MFile,
  symbols: SymbolTable,
  holder: MOptionHolder,
  sub?: string,
  /** method request / response types must be messages (an enum is an `unresolved-type`: the wrong kind, spec §4.2); protoc looks them up like extendees, taking the first symbol of any kind (a method of the service included) */
  messageOnly = false,
) => {
  if (!t || t.kind !== "named" || t.resolved) return
  const from = { file }
  const r = symbols.lookup(t.name, scope, messageOnly ? "any" : "type", from)
  const found = r.found
  if (found && (found.kind === "message" || found.kind === "enum")) {
    t.resolved = { kind: found.kind, fqn: found.fqn }
    if (messageOnly && found.kind === "enum")
      addPending(holder, {
        code: "unresolved-type",
        message: `unresolved type: ${t.name} resolves to enum type ${found.fqn}; a method ${sub} must be a message type`,
        loc: undefined,
        sub,
      })
    return
  }
  t.unresolvedKey = unresolvedKey(t.name, file.package)
  const why = unresolvedWhy(t.name, r, symbols, from, "a message or enum type")
  addPending(holder, { code: "unresolved-type", message: `unresolved type: ${why}`, loc: undefined, sub })
}

const resolveExtendee = (x: MField, scope: string, file: MFile, symbols: SymbolTable) => {
  if (!x.extendee) return
  if (!x.extendee.resolved) {
    const from = { file }
    // protoc / buf: the first symbol of any kind (a field of the enclosing message included); the wrong kind is an error, not skipped
    const r = symbols.lookup(x.extendee.name, scope, "any", from)
    if (r.found?.kind === "message") x.extendee.resolved = r.found.fqn
    else {
      x.extendee.unresolvedKey = unresolvedKey(x.extendee.name, file.package)
      addPending(x, {
        code: "unresolved-extendee",
        message: `unresolved extendee: ${unresolvedWhy(x.extendee.name, r, symbols, from, "a message type")}`,
        loc: x.locs.extendee,
      })
    }
  }
  if (x.extendee.resolved) symbols.indexExtension(x, x.extendee.resolved)
}

const linkMessage = (m: MMessage, file: MFile, symbols: SymbolTable) => {
  // a map field's `type` is its entry message, which no source names: only the value type is linked
  for (const f of m.fields) resolveType(f.map ? f.map.value : f.type, m.fqn, file, symbols, f)
  for (const x of m.extensions) {
    resolveType(x.type, m.fqn, file, symbols, x)
    resolveExtendee(x, m.fqn, file, symbols)
  }
  for (const n of m.nested) linkMessage(n, file, symbols)
}

export const linkFile = (file: MFile, symbols: SymbolTable) => {
  for (const m of file.messages) linkMessage(m, file, symbols)
  for (const x of file.extensions) {
    resolveType(x.type, file.package, file, symbols, x)
    resolveExtendee(x, file.package, file, symbols)
  }
  for (const s of file.services) {
    for (const m of s.methods) {
      resolveType(m.input, s.fqn, file, symbols, m, "request", true)
      resolveType(m.output, s.fqn, file, symbols, m, "response", true)
    }
  }
}

/**
 * Link every file. `featureDefaults` gives the build's edition defaults, read from the typed options of its `google.protobuf.FeatureSet`: the file declaring FeatureSet (descriptor.proto, whose own references do not depend on visibility) is linked first, then the defaults set the symbol visibility (`default_symbol_visibility`, as buf reads it from the build's descriptor.proto) before the other files are linked. Without it the bundled defaults apply.
 */
export const linkAll = (files: MFile[], symbols: SymbolTable, featureDefaults?: () => FeatureDefaults) => {
  const fs = featureDefaults ? symbols.message(FEATURE_SET) : undefined
  if (featureDefaults && fs) {
    linkFile(fs.file, symbols)
    symbols.useFeatureDefaults(featureDefaults())
  }
  for (const f of files) if (f !== fs?.file) linkFile(f, symbols)
}
