# protoapi

ProtoApi is a JSON document format for Protocol Buffers APIs, plus the tools that convert to and from it: `.proto` text → ProtoApi, `FileDescriptorSet` → ProtoApi, ProtoApi → `.proto` text, and a source map that locates every document node in the original files.

**Documentation: [udamir.github.io/protoapi](https://udamir.github.io/protoapi/)** — [guide](https://udamir.github.io/protoapi/guide/), [specification](https://udamir.github.io/protoapi/spec/), [conversion examples](https://udamir.github.io/protoapi/examples/) and an [online demo](https://udamir.github.io/protoapi/demo).

- proto2, proto3 and editions 2023, 2024 and 2026
- two producers with byte-identical output: a pure TypeScript `.proto` parser (runs in the browser) and `FileDescriptorSet` input (ProtoJSON from `buf build -o image.json`, or binary)
- validation and documentation conventions — comment tags, AIP prefixes, `google.api.field_behavior`, protovalidate, protoc-gen-validate, grpc-gateway — lifted into JSON Schema keywords
- bundled definitions of the well-known types, googleapis, protovalidate, protoc-gen-validate and grpc-gateway, so most imports resolve without setup
- a printer back to `.proto` text, a source map, and no runtime dependencies

## Motivation

ProtoApi was created for a unified approach to API diffs: [api-smart-diff](https://github.com/udamir/api-smart-diff) compares JSON API documents of a common shape (OpenAPI, AsyncAPI, JSON Schema) with one engine that classifies every change as breaking, non-breaking, deprecated or annotation. A ProtoApi document gives protobuf and gRPC APIs that shape, so they can be diffed with the same engine, rules and reports. See [Motivation](https://udamir.github.io/protoapi/guide/#motivation).

## Install

```sh
npm install protoapi
```

`protoapi` includes the bundled definitions; `protoapi/core` is the same API without them. Binary descriptor sets need the optional peer dependency `@bufbuild/protobuf`. Requires Node.js 18 or later; ESM, CommonJS and browser builds are included.

## Usage

```ts
import { buildFromProto, printProto } from "protoapi"

const { document, sourceMap, issues } = buildFromProto({
  "shop/v1/pet.proto": `
    syntax = "proto3";
    package shop.v1;
    // A pet.
    message Pet {
      // Required. Unique id.
      int64 id = 1;
      optional string nickname = 2;
    }
    service PetService { rpc GetPet(Pet) returns (stream Pet); }
  `,
})

const files = printProto(document) // back to .proto text
```

```yaml
protoapi: "0.1"
files:
  shop/v1/pet.proto: { syntax: proto3, package: shop.v1 }
services:
  shop.v1.PetService:
    title: PetService
    file: shop/v1/pet.proto
    methods:
      GetPet:
        request: { schema: { $ref: "#/components/messages/shop.v1.Pet" } }
        response: { schema: { $ref: "#/components/messages/shop.v1.Pet" }, stream: true }
components:
  messages:
    shop.v1.Pet:
      title: Pet
      file: shop/v1/pet.proto
      description: A pet.
      type: object
      properties:
        id: { description: Unique id., number: 1, type: int64, required: true }
        nickname: { number: 2, type: string, presence: explicit }
```

Builders never throw on invalid input: they return the most complete document the input allows, with `issues`. See [Getting started](https://udamir.github.io/protoapi/guide/getting-started), [Usage](https://udamir.github.io/protoapi/guide/usage) (build options, descriptor sets, printing) and the [API reference](https://udamir.github.io/protoapi/guide/api).

A JSON Schema of the format ships as `protoapi/schemas/v0.1/schema.json`.

## Development

```sh
pnpm install
pnpm test        # all tests
pnpm check       # format, lint and type-aware checks
pnpm build       # dist/ and browser/
```

See [Contributing](https://udamir.github.io/protoapi/guide/contributing) for the project layout, the conformance scripts against buf and the performance budgets.

## Licence

MIT. The parser is derived from [pbkit](https://github.com/riiid/pbkit) 0.0.72 (MIT OR Apache-2.0, used under MIT), see `src/parser/NOTICE`. Bundled `.proto` definitions keep their licences, see `NOTICE` and `bundle/LICENSES/`.
