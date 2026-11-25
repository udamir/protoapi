import { expect, test } from "vite-plus/test"
import { ROWS, measureInChild } from "../../bench/rows.ts"

// PARSE-1 of bench/rows.ts, measured in a fresh `node --expose-gc` process like the PB-9 rows
const row = ROWS.find((r) => r.id === "PARSE-1")!

test(
  "parses a ~1.5 MB synthetic file in under 1000 ms; line index + comment lookups in under 200 ms",
  () => {
    const result = measureInChild(row.id)
    for (const m of row.metrics) expect(result[m.id], m.title).toBeLessThan(m.budget)
  },
  row.timeout,
)
