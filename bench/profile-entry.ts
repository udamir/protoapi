// Node CPU profiling entry: `node --cpu-prof bench/profile-entry.ts` runs it from the TypeScript sources.
import { generate } from "./generate.ts"
import { buildFromProto } from "../src/index.ts"

const src = generate(Number(process.env.MESSAGES ?? 1700), "bench.p")
buildFromProto({ "x.proto": src })
const t0 = performance.now()
buildFromProto({ "x.proto": src })
console.log(`buildFromProto ${(performance.now() - t0).toFixed(0)} ms`)
