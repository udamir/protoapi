// Node benchmark of the performance budgets (design §12, PB-9): every timing row of bench/rows.ts, each measurement in
// a fresh `node --expose-gc` process, repeated over several rounds; prints min / median / max against the budget.
//
//   node bench/budgets.ts                   # 5 rounds of every row
//   node bench/budgets.ts --rounds 10       # more rounds
//   node bench/budgets.ts --only PB-9.4     # one row
//   node bench/budgets.ts --write           # also write bench/results/node.md
//   node --expose-gc bench/budgets.ts --row PB-9.4   # one measurement in this process, as JSON (used by the tests)

import { mkdirSync, writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { join } from "node:path"
import { ROWS, measureInChild } from "./rows.ts"

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

const child = arg("--row")
if (child) {
  const row = ROWS.find((r) => r.id === child)
  if (!row) throw new Error(`unknown row ${child}; rows: ${ROWS.map((r) => r.id).join(", ")}`)
  console.log(JSON.stringify(row.measure()))
} else {
  const rounds = Number(arg("--rounds") ?? 5)
  const only = arg("--only")
  const rows = ROWS.filter((r) => !only || r.id === only)
  const values = new Map<string, number[]>()
  for (let round = 1; round <= rounds; round++) {
    for (const row of rows) {
      const result = measureInChild(row.id)
      for (const [id, value] of Object.entries(result)) values.set(id, [...(values.get(id) ?? []), value])
      console.error(
        `round ${round}/${rounds} ${row.id}: ${JSON.stringify(result, (_, v) => (typeof v === "number" ? +v.toFixed(2) : v))}`,
      )
    }
  }

  const fmt = (v: number, unit: string) => (unit === "ms" ? `${v.toFixed(0)} ms` : `${v.toFixed(2)}x`)
  const lines = [
    "| Row | Measures | Budget | Min | Median | Max | Max / budget |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ]
  let failing = 0
  for (const row of rows) {
    for (const m of row.metrics) {
      const vs = [...(values.get(m.id) ?? [])].sort((a, b) => a - b)
      if (!vs.length) continue
      const max = vs[vs.length - 1]
      if (max >= m.budget) failing++
      lines.push(
        `| ${m.id} | ${m.title} | ${fmt(m.budget, m.unit)} | ${fmt(vs[0], m.unit)} | ${fmt(vs[Math.floor(vs.length / 2)], m.unit)} | ${fmt(max, m.unit)} | ${max >= m.budget ? "**" : ""}${((max / m.budget) * 100).toFixed(0)}%${max >= m.budget ? "**" : ""} |`,
      )
    }
  }
  const cpu = cpus()[0]?.model ?? "unknown CPU"
  const environment = `Node.js ${process.version}, ${process.platform}-${process.arch}, ${cpu} (${cpus().length} threads), ${rounds} rounds, each measurement in a fresh process (min of 3 runs after warm-up).`
  const table = lines.join("\n")
  console.log(
    `${environment}\n\n${table}\n\n${failing ? `${failing} metric(s) at or over budget` : "every metric within budget"}`,
  )

  if (process.argv.includes("--write")) {
    const dir = join(import.meta.dirname, "results")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "node.md"),
      `# Performance budgets on Node.js\n\nMeasured with \`node bench/budgets.ts --write\` on ${new Date().toISOString().slice(0, 10)}: ${environment}\n\n${table}\n`,
    )
  }
}
