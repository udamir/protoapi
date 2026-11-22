// Synthetic corpus generator from the research PoC (docs/research/grpc/poc/bench/bench.ts in api-smart-diff).

const SCALARS = ["int32", "int64", "uint32", "string", "bool", "double", "bytes", "sint64", "fixed32"]

export const generate = (messages: number, pkg: string): string => {
  const out: string[] = [`syntax = "proto3";\n\npackage ${pkg};\n\nimport "google/protobuf/timestamp.proto";\n`]
  for (let m = 0; m < messages; m++) {
    if (m % 5 === 0) {
      out.push(
        `// Status of entity ${m}.\nenum Status${m} {\n  STATUS${m}_UNSPECIFIED = 0;\n  // Active.\n  STATUS${m}_ACTIVE = 1;\n  STATUS${m}_DELETED = 2 [deprecated = true];\n}\n`,
      )
    }
    out.push(
      `// Entity number ${m}.\n// @Example {"id": ${m}}\nmessage Entity${m} {\n  reserved 100, 101 to 110;\n  reserved "old_field";\n`,
    )
    for (let f = 0; f < 12; f++) {
      const n = f + 1
      const scalar = SCALARS[(m + f) % SCALARS.length]
      switch (f % 6) {
        case 0:
          out.push(`  // Required. Identifier ${f}.\n  ${scalar} field_${f} = ${n};\n`)
          break
        case 1:
          out.push(
            `  // Optional label.\n  // @MaxLength 64\n  optional string label_${f} = ${n} [json_name = "lbl${f}"];\n`,
          )
          break
        case 2:
          out.push(`  repeated ${scalar} list_${f} = ${n}; // trailing\n`)
          break
        case 3:
          out.push(`  map<string, ${scalar}> attrs_${f} = ${n};\n`)
          break
        case 4:
          out.push(
            `  ${m > 0 ? `Entity${m - 1}` : "google.protobuf.Timestamp"} ref_${f} = ${n} [deprecated = ${f % 2 === 0}];\n`,
          )
          break
        case 5:
          out.push(`  Status${m - (m % 5)} status_${f} = ${n};\n`)
          break
      }
    }
    out.push(
      "  oneof kind {\n    string kind_a = 50;\n    int64 kind_b = 51;\n  }\n  message Nested { bool flag = 1; }\n}\n",
    )
    if (m % 50 === 49) {
      out.push(`// Service for entities ${m - 49}..${m}.\nservice EntityService${m} {\n`)
      for (let r = 0; r < 10; r++) {
        out.push(
          `  // Gets entity.\n  rpc Get${r}(Entity${m - r}) returns (${r % 2 ? "stream " : ""}Entity${m - r - 1}) { option idempotency_level = NO_SIDE_EFFECTS; }\n`,
        )
      }
      out.push("}\n")
    }
  }
  return out.join("")
}
