// Node CPU profiling entry for the descriptor producer (image from bench/phases.ts).
import { readFileSync } from "node:fs"
import { buildFromDescriptorSet } from "../src/index.ts"

const set = JSON.parse(readFileSync(process.env.IMAGE ?? ".tmp/phases/image-1700.json", "utf8"))
buildFromDescriptorSet(set)
const t0 = performance.now()
buildFromDescriptorSet(set)
console.log(`buildFromDescriptorSet ${(performance.now() - t0).toFixed(0)} ms`)
