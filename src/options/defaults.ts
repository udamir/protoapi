// Rule D (spec §3.5): options equal to their protobuf default are not written.

import type { ProtoSyntax } from "../types.ts"
import type { OptionTree } from "../model/index.ts"
import type { OptionsKind } from "./kinds.ts"
import { hasKey, setKey } from "../common/objects.ts"

const RULE_D: Record<OptionsKind | "any", Record<string, unknown>> = {
  any: { deprecated: false },
  field: {
    jstype: "JS_NORMAL",
    ctype: "STRING",
    lazy: false,
    unverified_lazy: false,
    weak: false,
    debug_redact: false,
    retention: "RETENTION_UNKNOWN",
  },
  enum: { allow_alias: false },
  message: { message_set_wire_format: false, no_standard_descriptor_accessor: false },
  method: { idempotency_level: "IDEMPOTENCY_UNKNOWN" },
  file: {
    java_multiple_files: false,
    java_generic_services: false,
    cc_generic_services: false,
    py_generic_services: false,
    optimize_for: "SPEED",
    cc_enable_arenas: true,
  },
  oneof: {},
  enumValue: {},
  service: {},
  extensionRange: {},
}

/** Rule D: options equal to their protobuf default are not written. */
export const dropDefaults = (kind: OptionsKind, tree: OptionTree, syntax: ProtoSyntax): OptionTree => {
  const out: OptionTree = {}
  const table = { ...RULE_D.any, ...RULE_D[kind] }
  for (const [k, v] of Object.entries(tree)) {
    if (hasKey(table, k) && table[k] === v) continue
    if (kind === "message" && k === "map_entry") continue
    if (kind === "field" && k === "packed" && v === (syntax === "proto3")) continue
    if (kind === "field" && k === "targets" && Array.isArray(v) && v.length === 0) continue
    setKey(out, k, v)
  }
  return out
}
