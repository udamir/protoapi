// Downloads real-world conformance fixtures (googleapis, pinned commit) into test/fixtures/googleapis/.
// Then `node scripts/images.ts googleapis` builds their buf images.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const GOOGLEAPIS = "62746790cb5c0fe1956e7f2df8422d3a7f00ba15"
const FILES = [
  "google/pubsub/v1/pubsub.proto",
  "google/pubsub/v1/schema.proto",
  "google/cloud/compute/v1/compute.proto",
  "google/cloud/extended_operations.proto",
  "google/longrunning/operations.proto",
  "google/cloud/secretmanager/v1/service.proto",
  "google/cloud/secretmanager/v1/resources.proto",
  "google/iam/v1/iam_policy.proto",
  "google/iam/v1/policy.proto",
  "google/iam/v1/options.proto",
  "google/iam/v1/resource_policy_member.proto",
  "google/type/expr.proto",
  // design §13 sample (phase D)
  "google/storage/v2/storage.proto",
]
const ROOT = join(import.meta.dirname, "..", "test", "fixtures", "googleapis")
for (const f of FILES) {
  const res = await fetch(`https://raw.githubusercontent.com/googleapis/googleapis/${GOOGLEAPIS}/${f}`)
  if (!res.ok) throw new Error(`${res.status} ${f}`)
  const out = join(ROOT, f)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, await res.text())
  console.log(f)
}
writeFileSync(join(ROOT, "SOURCE.md"), `From googleapis/googleapis@${GOOGLEAPIS} (Apache-2.0).\n`)
