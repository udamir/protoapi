/** Deterministic synthetic `.proto` text of roughly `targetBytes` characters. */
export function generateSyntheticProto(targetBytes: number): string {
  const parts: string[] = [
    "// Synthetic file for parser benchmarks.\n",
    "\n",
    'syntax = "proto3";\n',
    "\n",
    "package bench.v1;\n",
    "\n",
    'import "google/protobuf/timestamp.proto";\n',
    'import "google/api/field_behavior.proto";\n',
    "\n",
    'option go_package = "example.com/bench/v1;benchv1";\n',
    "option java_multiple_files = true;\n",
    "\n",
  ]
  let size = parts.reduce((n, p) => n + p.length, 0)
  let i = 0
  while (size < targetBytes) {
    const chunk: string[] = []
    chunk.push(`// Message number ${i}.\n// It has a multi-line leading comment.\nmessage Item${i} {\n`)
    chunk.push(`  option (acme.opts.table) = { name: "item_${i}" indexes: ["a", "b"] };\n\n`)
    chunk.push(
      `  // Kind of item ${i}.\n  enum Kind {\n    KIND_UNSPECIFIED = 0; // not set\n    KIND_A = 1;\n    KIND_B = 2 [deprecated = true];\n  }\n\n`,
    )
    for (let f = 1; f <= 12; f++) {
      if (f % 3 === 0) chunk.push(`  // Field ${f} of item ${i}.\n`)
      const label = f % 4 === 0 ? "repeated " : f % 5 === 0 ? "optional " : ""
      const type = ["string", "int64", "Kind", "google.protobuf.Timestamp", "bytes", "double"][f % 6]
      const opts =
        f % 2 === 0
          ? ` [(google.api.field_behavior) = REQUIRED, (buf.validate.field).string = { min_len: 1, max_len: ${f * 10} }]`
          : ""
      const trailing = f % 4 === 1 ? " // trailing" : ""
      chunk.push(`  ${label}${type} field_${f} = ${f}${opts};${trailing}\n`)
    }
    chunk.push(
      "  map<string, int32> counts = 13;\n  oneof choice {\n    string a = 14;\n    int32 b = 15; /* block */\n  }\n",
    )
    chunk.push(`  reserved 100 to 199, 500;\n  reserved "old_name";\n}\n\n`)
    if (i % 10 === 0) {
      chunk.push(`/** Service ${i}. */\nservice Service${i} {\n`)
      chunk.push(
        `  rpc Get(Item${i}) returns (Item${i}) {\n    option (google.api.http) = { get: "/v1/{name=items/*}" };\n  }\n`,
      )
      chunk.push(`  rpc List(stream Item${i}) returns (stream Item${i});\n}\n\n`)
    }
    const text = chunk.join("")
    parts.push(text)
    size += text.length
    i++
  }
  return parts.join("")
}
