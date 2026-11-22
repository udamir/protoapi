import { expect, test } from "bun:test"
import { createLineIndex, parseProto } from "../../src/parser"
import { generateSyntheticProto } from "./synthetic"

test("parses a ~1.5 MB synthetic file in under 1000 ms", () => {
  const text = generateSyntheticProto(1_500_000)
  expect(text.length).toBeGreaterThanOrEqual(1_500_000)
  parseProto(text.slice(0, 50_000)) // warm-up
  const t0 = performance.now()
  const r = parseProto(text)
  const elapsed = performance.now() - t0
  expect(r.error).toBeUndefined()
  const mb = text.length / 1e6
  console.log(
    `parseProto: ${mb.toFixed(2)} MB in ${elapsed.toFixed(0)} ms (${(mb / (elapsed / 1000)).toFixed(1)} MB/s), ` +
      `${r.ast.statements.length} top-level statements, ${r.comments.length} comments`,
  )
  expect(elapsed).toBeLessThan(1000)

  const t1 = performance.now()
  const index = createLineIndex(text)
  let sum = 0
  for (const c of r.comments) sum += index.toPosition(c.start).line
  const indexElapsed = performance.now() - t1
  console.log(`createLineIndex + ${r.comments.length} lookups: ${indexElapsed.toFixed(1)} ms`)
  expect(sum).toBeGreaterThan(0)
  expect(indexElapsed).toBeLessThan(200)
})
