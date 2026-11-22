// Node CPU profiling entry (no Bun APIs): esbuild bundles it, `node --cpu-prof` runs it.
import { generate } from "./generate"
import { buildFromProto } from "../src"

const src = generate(Number(process.env.MESSAGES ?? 1700), "bench.p")
buildFromProto({ "x.proto": src })
const t0 = performance.now()
buildFromProto({ "x.proto": src })
console.log(`buildFromProto ${(performance.now() - t0).toFixed(0)} ms`)
