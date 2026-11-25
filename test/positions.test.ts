// Source-map positions of the text producer (C-8, D-A, C-10, text#14) against buf; cases in test/cases/positions.ts.

import { describe, expect, test } from "vite-plus/test"
import { buildFromDescriptorSet, bundledFiles } from "../src/index.ts"
import { createLineIndex } from "../src/parser/index.ts"
import { cases } from "./cases/positions.ts"
import { describeCases } from "./cases/run.ts"

describeCases("positions", "positions", cases)

describe("line index with tab stops (D-A)", () => {
  test("tabs, BOM, CR, FF and VT; plain columns without tabWidth", () => {
    const text = "﻿a\tb\r\n\t\tc\fd\ve"
    const plain = createLineIndex(text)
    expect(plain.toPosition(3)).toEqual({ line: 0, column: 3 })
    const buf = createLineIndex(text, { tabWidth: 4 })
    expect(buf.toPosition(1)).toEqual({ line: 0, column: 0 }) // after the BOM
    expect(buf.toPosition(3)).toEqual({ line: 0, column: 4 }) // `b` after `a\t`
    expect(buf.toPosition(4)).toEqual({ line: 0, column: 5 }) // the `\r`
    expect(buf.toPosition(8)).toEqual({ line: 1, column: 8 }) // `c` after two tabs
    expect(buf.toPosition(12)).toEqual({ line: 1, column: 10 }) // `e`: `\f` and `\v` have no width
  })

  test("long lines with tabs: lookups in any order agree with a scan from the line start", () => {
    const line = Array.from({ length: 3000 }, (_, i) => (i % 7 === 0 ? "\t" : "x")).join("")
    const index = createLineIndex(line, { tabWidth: 4 })
    const scan = (o: number) => {
      let col = 0
      for (let i = 0; i < o; i++) col = line[i] === "\t" ? col + 4 - (col % 4) : col + 1
      return col
    }
    for (const o of [2999, 5, 1500, 1499, 257, 256, 255, 0, 3000, 1024])
      expect(index.toPosition(o).column).toBe(scan(o))
  })
})

describe("tabWidth is a text-producer option", () => {
  test("a descriptor build reads every bundled file with the default tab stop, imported or added for the option definitions", () => {
    const desc = bundledFiles["google/protobuf/descriptor.proto"].replace(
      "message FileDescriptorSet {",
      "message FileDescriptorSet {\n\t\tint32 tabbed = 99;",
    )
    const bundle = { "google/protobuf/descriptor.proto": desc }
    const file = { name: "a.proto", package: "p", syntax: "proto3", messageType: [{ name: "M" }] }
    for (const dependency of [["google/protobuf/descriptor.proto"], []]) {
      const set = { file: [{ ...file, dependency }] }
      const results = [4, 8, 1].map((tabWidth) => buildFromDescriptorSet(set, { imports: "all", bundle, tabWidth }))
      for (const r of results.slice(1)) expect(r).toEqual(results[0])
    }
  })
})
