// Option interpretation shared by both producers (spec §3.7).
//
// Text options (`(name).sub = constant`, aggregates in text format) and ProtoJSON option messages are typed against the definitions in the symbol table (bundled descriptor.proto, bundled conventions, the input set) and normalised to one canonical tree: snake_case keys, extension keys as fqn without brackets, canonical values (spec §3.6), key order by definition (fields in declaration order, then extensions by number), defaults dropped (rule D).
//
// The interpreter is built in layers, each a class extending the one before: `OptionReader` (context.ts: context,
// issues, source text), `TextFormatReader` (textproto.ts), `OptionStatementReader` (statement.ts), `ProtoJsonReader`
// (json.ts), and `OptionInterpreter` here, which interprets every raw option of a holder.

import type { ProtoSyntax } from "../types.ts"
import type { OptionTree } from "../model/index.ts"
import { OPTIONS_MESSAGE, type OptionsKind } from "./kinds.ts"
import { keyByNumber } from "./definitions.ts"
import { orderTree } from "./tree.ts"
import { dropDefaults } from "./defaults.ts"
import { ProtoJsonReader } from "./json.ts"
import { hasKey, setKey } from "../common/objects.ts"

export class OptionInterpreter extends ProtoJsonReader {
  /** Interpret every raw option of the holder into `holder.options` (typed, ordered, rule D applied). */
  run(kind: OptionsKind, syntax: ProtoSyntax) {
    const { symbols } = this.ctx
    const def = symbols.message(OPTIONS_MESSAGE[kind])
    const tree: OptionTree = {}
    for (const raw of this.holder.raw) {
      if (raw.kind === "text") {
        const set = this.interpretText(raw, kind, tree)
        if (set?.loc && !hasKey(this.holder.optionLocs, set.key)) setKey(this.holder.optionLocs, set.key, set.loc)
      } else {
        for (const [k, v] of Object.entries(this.jsonMessage(raw.value, def, ""))) setKey(tree, k, v)
        if (raw.wire && def) for (const [k, v] of Object.entries(this.wireMessage(raw.wire, def))) setKey(tree, k, v)
        if (raw.locs && def) {
          for (const [num, loc] of Object.entries(raw.locs)) {
            const key = keyByNumber(symbols, def, Number(num))
            if (key && !hasKey(this.holder.optionLocs, key)) setKey(this.holder.optionLocs, key, loc)
          }
        }
      }
    }
    this.holder.options = dropDefaults(kind, orderTree(tree, def, symbols), syntax)
  }
}
