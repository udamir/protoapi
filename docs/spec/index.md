---
title: ProtoApi Specification
outline: [2, 3]
---

# ProtoApi Specification

The ProtoApi Specification defines a serializable, JSON-Schema-flavoured description of a Protocol Buffers API. A ProtoApi document describes everything a set of `.proto` files defines — files with their syntax or edition, packages, imports and options; services and methods with their streaming, idempotency and HTTP bindings; messages with their fields, oneofs, reserved ranges and extension ranges; enums and their values; extensions and custom option definitions; comments; and the validation and documentation annotations of the common conventions — as plain JSON data that can be stored, versioned, rendered and diffed with ordinary JSON tooling.

ProtoApi is an alternative to a `FileDescriptorSet` for every consumer that is not a protobuf runtime. A descriptor set is designed to be read by code generators: it nests types inside files, keeps comments in a separate `sourceCodeInfo` table addressed by numeric paths, encodes types as enum numbers, and leaves custom options as extensions that need their definitions to be read. A ProtoApi document is designed to be read by people and programs: services and types are keyed by fully qualified name and refer to each other with `$ref`s, fields read like JSON Schema properties, comments are `description`s, options are typed JSON values, and annotations are normalized into JSON Schema keywords.

The reference implementation is the [`protoapi`](https://www.npmjs.com/package/protoapi) npm package, which builds documents from `.proto` text (`buildFromProto`) and from descriptor sets (`buildFromDescriptorSet`), prints a document back to `.proto` text (`printProto`), and produces a source map for every document. You can try it in the [online demo](/demo).

## Version

The current version is **ProtoApi 0.1**, marked by `protoapi: "0.1"` (a string; quote it in YAML) and defined on the [ProtoApi 0.1](/spec/v0.1) page. It is the format `protoapi` produces; consumers accept every `0.x` document. Additive changes, such as a new optional keyword, keep the version; an incompatible change increments it.

```ts
import { buildFromProto } from "protoapi"

const { document } = buildFromProto({ "pet.proto": source }) // protoapi: "0.1"
```

### A file and its document

::: code-group

```proto [pet.proto]
syntax = "proto3";

package shop.v1;

// A pet.
message Pet {
  // Required. Unique id.
  int64 id = 1;
  optional string nickname = 2;
  repeated string tags = 3;
  map<string, int32> attrs = 4;
  Kind kind = 5;
}

enum Kind {
  KIND_UNSPECIFIED = 0;
  KIND_DOG = 1;
}

service PetService {
  rpc GetPet(Pet) returns (stream Pet);
}
```

```yaml [protoapi.yaml]
protoapi: "0.1"
files:
  pet.proto:
    syntax: proto3
    package: shop.v1
services:
  shop.v1.PetService:
    title: PetService
    file: pet.proto
    methods:
      GetPet:
        request:
          schema: { $ref: "#/components/messages/shop.v1.Pet" }
        response:
          schema: { $ref: "#/components/messages/shop.v1.Pet" }
          stream: true
components:
  messages:
    shop.v1.Pet:
      title: Pet
      file: pet.proto
      description: A pet.
      type: object
      properties:
        id: { description: Unique id., number: 1, type: integer, protoType: int64, required: true }
        nickname: { number: 2, type: string, protoType: string, presence: explicit }
        tags: { number: 3, type: array, items: { type: string, protoType: string } }
        attrs:
          number: 4
          type: object
          additionalProperties: { type: integer, protoType: int32 }
          propertyNames: { type: string, protoType: string }
        kind: { number: 5, $ref: "#/components/enums/shop.v1.Kind" }
  enums:
    shop.v1.Kind:
      title: Kind
      file: pet.proto
      type: string
      values:
        KIND_UNSPECIFIED: { number: 0 }
        KIND_DOG: { number: 1 }
```

:::

## Design principles

- **API-shaped, not file-shaped.** Services and methods come first; messages, enums and extensions are components keyed by fully qualified name, whatever file declares them. Files are listed separately, with what belongs to the file itself (syntax, package, imports, file options), and every service and component names its declaring `file`.
- **JSON Schema where it fits.** A message is an object schema (`type: object`, `properties`), a repeated field is an array (`items`), a map is an object with `propertyNames` and `additionalProperties`, an enum is a string type with `values`, and validation annotations are JSON Schema keywords. Where protobuf has semantics JSON Schema lacks, the document uses protobuf keywords: `number`, `protoType`, `presence`, `oneof`, `jsonName`, `reserved`, `extensions`, `closed`, …
- **Nominal references.** A field of a message or enum type is a `$ref` to its component. Siblings of a `$ref` are attributes of the field (its number, description, annotations), never a schema to merge with the target.
- **One spelling per fact.** Values are canonical (64-bit integers as decimal strings, bytes as base64, enum values as names), options equal to their default are omitted, absent keys mean the protobuf default, and keys and lists have a defined order. Two builds of the same API — from text or from a descriptor set — give equal documents, so a difference between two documents is a difference between the APIs.
- **Lossless.** Everything that affects the API or its documentation is kept, and a document prints back to `.proto` files that build to the same document.

## Related

- [ProtoApi 0.1](/spec/v0.1) — the normative definition of the document.
- [Conversion examples](/examples/) — one `.proto` example per feature, with its document, buf's descriptor set, the source map and the printed text.
- [GraphAPI](https://udamir.github.io/graphapi/) — the same idea for GraphQL schemas; both formats are inputs of [api-smart-diff](https://github.com/udamir/api-smart-diff).
