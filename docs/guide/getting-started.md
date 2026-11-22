# Getting started

## Installation

`protoapi` has no runtime dependencies.

::: code-group

```sh [npm]
npm install protoapi
```

```sh [pnpm]
pnpm add protoapi
```

```sh [yarn]
yarn add protoapi
```

```sh [bun]
bun add protoapi
```

:::

The package ships ESM and CommonJS builds with bundled TypeScript declarations; `import` and `require` both work. It supports Node.js 18 and later, and runs in the browser.

::: tip Binary descriptor sets
Building from a binary `FileDescriptorSet` (`buf build -o image.binpb`, `protoc --descriptor_set_out`) needs the optional peer dependency `@bufbuild/protobuf` 2.8.0 or later (2.16.0 or later for edition 2026), or a decoder of your own. `.proto` text and ProtoJSON descriptor sets need nothing. See [Usage](/guide/usage#from-a-binary-descriptor-set).
:::

## Build your first document

```ts
import { buildFromProto } from "protoapi"

const { document, sourceMap, issues } = buildFromProto({
  "todo/v1/todo.proto": `
    syntax = "proto3";

    package todo.v1;

    // Manages to-do items.
    service TodoService {
      rpc GetTodo(GetTodoRequest) returns (Todo);
    }

    // A to-do item.
    message Todo {
      // Required. Unique id.
      string id = 1;
      string title = 2;
      bool done = 3 [deprecated = true];
      repeated string tags = 4;
    }

    message GetTodoRequest {
      string id = 1;
    }
  `,
})
```

The argument maps import paths to `.proto` text; imports between the files resolve by these paths. `document` is a plain object, a `protoapi: "0.1"` document. Dumped as YAML:

```yaml
protoapi: "0.1"
files:
  todo/v1/todo.proto:
    syntax: proto3
    package: todo.v1
services:
  todo.v1.TodoService:
    title: TodoService
    file: todo/v1/todo.proto
    description: Manages to-do items.
    methods:
      GetTodo:
        request:
          schema:
            $ref: "#/components/messages/todo.v1.GetTodoRequest"
        response:
          schema:
            $ref: "#/components/messages/todo.v1.Todo"
components:
  messages:
    todo.v1.Todo:
      title: Todo
      file: todo/v1/todo.proto
      description: A to-do item.
      type: object
      properties:
        id:
          description: Unique id.
          number: 1
          type: string
          protoType: string
          required: true
        title:
          number: 2
          type: string
          protoType: string
        done:
          deprecation: {}
          number: 3
          type: boolean
          protoType: bool
        tags:
          number: 4
          type: array
          items:
            type: string
            protoType: string
    todo.v1.GetTodoRequest:
      title: GetTodoRequest
      file: todo/v1/todo.proto
      type: object
      properties:
        id:
          number: 1
          type: string
          protoType: string
```

A few things to note:

- Services and messages are keyed by their fully qualified name (`todo.v1.Todo`), fields by their name; every field carries its `number`.
- A scalar field has a JSON Schema `type` and its `protoType`; a repeated field is `type: array` with `items`.
- Comments became `description`s. The `Required.` prefix of the `id` comment is an [AIP annotation](/guide/annotations#aip-prefixes): it was removed from the description and became `required: true`.
- `[deprecated = true]` became `deprecation: {}`; options equal to their default and implicit presence are not written at all.

The [specification](/spec/v0.1) defines every key.

## Issues and the source map

The builders never throw on bad input. Problems are reported in `issues`, each with a code, a message, its location in the source and the pointer of the document node concerned, and the document is as complete as the input allows:

```ts
const { document, issues } = buildFromProto({
  "a.proto": `syntax = "proto3";\nmessage A { Missing m = 1; }\n`,
})
// issues: [{
//   code: "unresolved-type",
//   message: "unresolved type: Missing is not defined",
//   file: "a.proto",
//   location: { file: "a.proto", start: { line: 1, column: 12 }, end: { line: 1, column: 26 } },
//   pointer: "#/components/messages/A/properties/m",
// }]
```

`sourceMap` maps JSON pointers of the document to spans in the files (zero-based lines and columns, end exclusive). `locatePointer` returns the span of a node, or of its nearest ancestor that has one:

```ts
import { locatePointer } from "protoapi"

sourceMap["#/components/messages/todo.v1.Todo/properties/done"]
// { file: "todo/v1/todo.proto", start: { line: 14, column: 2 }, end: { line: 14, column: 36 } }  — the field
locatePointer("#/components/messages/todo.v1.Todo/properties/done/deprecation", sourceMap)
// { file: "todo/v1/todo.proto", start: { line: 14, column: 17 }, end: { line: 14, column: 34 } } — `deprecated = true`
```

See [Source maps](/guide/source-maps) and [Diagnostics](/guide/diagnostics).

## Print it back to `.proto`

```ts
import { printProto } from "protoapi"

const files = printProto(document) // { "todo/v1/todo.proto": "syntax = \"proto3\";\n…" }
```

```proto
syntax = "proto3";
package todo.v1;

// A to-do item.
message Todo {
  // Unique id.
  // @Required
  string id = 1;
  string title = 2;
  bool done = 3 [deprecated = true];
  repeated string tags = 4;
}

message GetTodoRequest {
  string id = 1;
}

// Manages to-do items.
service TodoService {
  rpc GetTodo(GetTodoRequest) returns (Todo);
}
```

The printed text is formatted canonically and keywords are printed in the first spelling available to the file (here the `@Required` comment tag), but building it again gives exactly the same document: `buildFromProto(printProto(document)).document` deep-equals `document`.

## Use it in the browser

With a bundler, import the package normally; the `browser` field points at the ESM build. Without a bundler, `browser/protoapi.min.js` is a self-contained build that exposes a `protoapi` global:

```html
<script src="https://cdn.jsdelivr.net/npm/protoapi/browser/protoapi.min.js"></script>
<script>
  const { document, issues } = protoapi.buildFromProto({ "pet.proto": source })
  console.log(protoapi.printProto(document))
</script>
```

The full build is about 158 KB gzipped, of which about 97 KB are the bundled `.proto` definitions. If you do not need them, `protoapi/core` (and `browser/protoapi-core.min.js`, global `protoapiCore`) has the same API with only `descriptor.proto` and the feature files bundled; see [Imports and the bundle](/guide/imports#protoapi-core).

## What next?

- Try your own files in the [online demo](/demo).
- Browse the [conversion examples](/examples/), one per feature.
- Read [Usage](/guide/usage) for descriptor sets, async loaders and the build options.
