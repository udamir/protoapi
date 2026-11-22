// Build (validation PK-1, PK-2):
//   dist/index.mjs, dist/index.cjs     `protoapi` (ESM, also the `browser` field; CommonJS), with the bundled sources
//   dist/core.mjs, dist/core.cjs       `protoapi/core`, the same API without the bundled sources
//   browser/protoapi.min.js            minified IIFE (global `protoapi`), for <script> tags (`unpkg` / `jsdelivr`)
//   browser/protoapi-core.min.js       minified IIFE of protoapi/core (global `protoapiCore`)
//   dist/types/*.d.ts                  tsc
// `@bufbuild/protobuf` stays external (optional peer, loaded on demand).

import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { gzipSync } from "node:zlib"
import { build } from "esbuild"

const ROOT = join(import.meta.dir, "..")
rmSync(join(ROOT, "dist"), { recursive: true, force: true })
rmSync(join(ROOT, "browser"), { recursive: true, force: true })

const common = {
  bundle: true,
  target: "es2020",
  external: ["@bufbuild/protobuf", "@bufbuild/protobuf/*"],
  legalComments: "eof" as const,
  logLevel: "warning" as const,
}

for (const entry of ["index", "core"]) {
  const entryPoints = [join(ROOT, "src", `${entry}.ts`)]
  await build({
    ...common,
    entryPoints,
    format: "esm",
    platform: "neutral",
    outfile: join(ROOT, "dist", `${entry}.mjs`),
  })
  await build({ ...common, entryPoints, format: "cjs", platform: "node", outfile: join(ROOT, "dist", `${entry}.cjs`) })
}
const iife = { ...common, format: "iife" as const, platform: "browser" as const, minify: true }
await build({
  ...iife,
  entryPoints: [join(ROOT, "src", "index.ts")],
  globalName: "protoapi",
  outfile: join(ROOT, "browser", "protoapi.min.js"),
})
await build({
  ...iife,
  entryPoints: [join(ROOT, "src", "core.ts")],
  globalName: "protoapiCore",
  outfile: join(ROOT, "browser", "protoapi-core.min.js"),
})

const tsc = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(ROOT, "tsconfig.build.json")], {
  stdio: "inherit",
})
if (tsc.status !== 0) process.exit(tsc.status ?? 1)
const gz = (f: string) => `${(gzipSync(readFileSync(join(ROOT, f))).length / 1024).toFixed(1)} KB gzip`
console.log(
  `built dist/ and browser/: protoapi.min.js ${gz("browser/protoapi.min.js")}, protoapi-core.min.js ${gz("browser/protoapi-core.min.js")}`,
)
