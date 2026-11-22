// Definition checks of the text producer (validation decision D-E) against the buf oracle; cases in
// test/cases/validation.ts.

import { describe, expect, test } from "vite-plus/test"
import { buildFromProto, bundledFiles } from "../src/index.ts"
import { cases } from "./cases/validation.ts"
import { describeCases } from "./cases/run.ts"

describeCases("D-E definition checks", "validation", cases)

// deterministic PRNG
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const EDITIONS = `edition = "2024";
package shop.v1;
import "google/protobuf/descriptor.proto";
import "google/protobuf/cpp_features.proto";
import option "google/api/annotations.proto";
option features.(pb.cpp).string_type = VIEW;
option features.default_symbol_visibility = STRICT;
extend google.protobuf.FieldOptions { int32 level = 50001 [targets = TARGET_TYPE_FIELD]; }
export message Pet {
  message Tag { string value = 1; }
  string name = 2 [features.field_presence = EXPLICIT, (level) = 3, json_name = "n"];
  int32 count = 7 [features.field_presence = IMPLICIT];
  repeated Tag tags = 3 [features.repeated_field_encoding = EXPANDED];
  map<string, int32> counts = 4;
  oneof choice { int32 a = 5; string b = 6; }
  extensions 100 to 200;
  Kinds.Kind kind = 8;
}
message Kinds { export enum Kind { KIND_UNSPECIFIED = 0; CAT = 1; } reserved 1 to max; }
local enum Size { option features.enum_type = CLOSED; SMALL = 1; LARGE = 2; reserved 5 to 9; reserved OLD; }
service PetService { rpc GetPet (Pet) returns (Pet) { option (google.api.http) = { get: "/v1/pets" }; } }
`

describe("D-E checks never throw", () => {
  test("mutated editions files and bundled files build without throwing", () => {
    const rand = rng(11)
    const inputs = [EDITIONS, EDITIONS.replace('"2024"', '"2026"'), EDITIONS.replace('"2024"', '"2023"')]
    const bundled = Object.entries(bundledFiles)
    for (let i = 0; i < 300; i++) {
      const fromBundle = i % 3 === 0
      const [path, text] = fromBundle
        ? bundled[Math.floor(rand() * bundled.length)]
        : ["shop.proto", inputs[i % inputs.length]]
      const chars = text.split("")
      for (let k = 0; k < 4; k++) {
        const at = Math.floor(rand() * chars.length)
        const op = rand()
        if (op < 0.35) chars.splice(at, 1)
        else if (op < 0.7) chars.splice(at, 0, "{};=\"'[]()<>,.-0aZ_\t\n"[Math.floor(rand() * 21)])
        else
          chars.splice(
            at,
            0,
            [" local ", " export ", " optional ", " required ", " group ", " max ", " 0 "][Math.floor(rand() * 7)],
          )
      }
      const r = buildFromProto({ [path]: chars.join("") }, { includeImports: fromBundle })
      expect(r.document.protoapi).toBe("0.1")
      for (const issue of r.issues) expect(typeof issue.message).toBe("string")
    }
  })

  test("the unmutated editions file is valid (no issues)", () => {
    expect(buildFromProto({ "shop.proto": EDITIONS }).issues).toEqual([])
  })
})
