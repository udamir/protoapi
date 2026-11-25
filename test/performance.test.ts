// PB-9: performance budgets, one test per row of design §12. The timing rows are defined in bench/rows.ts and each is
// measured in a fresh `node --expose-gc` process (min of 3 runs after warm-up), as `node bench/budgets.ts` measures
// them; set PROTOAPI_SKIP_PERF=1 to skip them on slow or shared CI machines. The size rows (PB-9.8, PB-9.9) always run.

import { describe, expect, test } from "vite-plus/test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"
import { build } from "vite-plus"
import { bundledFiles } from "../src/index.ts"
import { ROWS, measureInChild } from "../bench/rows.ts"
import { ROOT } from "./helpers.ts"

const skip = !!process.env.PROTOAPI_SKIP_PERF

describe.skipIf(skip)("PB-9 performance (timing rows)", () => {
  for (const row of ROWS.filter((r) => r.id.startsWith("PB-"))) {
    const budgets = row.metrics.map((m) => `${m.id} < ${m.budget}${m.unit === "ms" ? " ms" : "x"}`).join(", ")
    test(
      `${row.id}: ${row.title} (${budgets})`,
      () => {
        const result = measureInChild(row.id)
        for (const m of row.metrics) expect(result[m.id], m.title).toBeLessThan(m.budget)
      },
      row.timeout,
    )
  }

  test("PB-9.7: peak heap of the 8.6 MB build < 1 GB (it completes in node with the V8 heap capped at 1 GB)", async () => {
    // a fresh node process with --max-old-space-size=1024 runs the build from the TypeScript sources (node strips the
    // types): completing proves the peak heap stays below the cap (an out-of-memory abort otherwise)
    const script = [
      `import { buildFromProto } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "index.ts")).href)}`,
      `import { generate } from ${JSON.stringify(pathToFileURL(join(ROOT, "bench", "generate.ts")).href)}`,
      'const r = buildFromProto({ "big.proto": generate(10200, "bench.f") })',
      "console.log(Object.keys(r.document.components.messages).length)",
    ].join("\n")
    const res = spawnSync("node", ["--max-old-space-size=1024", "--input-type=module", "--eval", script], {
      encoding: "utf8",
    })
    expect(res.stderr).not.toContain("heap out of memory")
    expect(res.status).toBe(0)
    expect(Number(res.stdout.trim())).toBeGreaterThan(10000)
  }, 120000)
})

describe("PB-9 performance (size rows)", () => {
  test("PB-9.8: browser code without the bundled sources, minified + gzip, < 60 KB", async () => {
    // the core entry as the browser build bundles it (IIFE, es2020, minified), its bundled .proto strings left out
    const res = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "without-bundled-sources",
          enforce: "pre",
          load: (id) =>
            /src[\\/]bundle[\\/](core-sources|sources)\.ts$/.test(id)
              ? "export const coreSources = {}; export const bundledSources = {}"
              : undefined,
        },
      ],
      build: {
        write: false,
        minify: true,
        target: "es2020",
        lib: { entry: join(ROOT, "src", "core.ts"), formats: ["iife"], name: "protoapiCore" },
        rolldownOptions: { external: [/^@bufbuild\/protobuf/] },
      },
    })) as { output: { code: string }[] }[]
    const size = gzipSync(res[0].output[0].code).length
    expect(size).toBeLessThan(60 * 1024)
  })

  test("PB-9.9: bundled .proto sources, gzip, < 120 KB", () => {
    const size = gzipSync(Object.values(bundledFiles).join("")).length
    expect(size).toBeLessThan(120 * 1024)
  })
})
