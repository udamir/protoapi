# Source maps

Every builder returns a source map next to the document: a plain object that maps [JSON pointers](https://www.rfc-editor.org/rfc/rfc6901) of the document to spans of the `.proto` files.

```ts
type SourceMap = Record<JsonPointer, Location>

interface Location {
  file: string // import path of the file
  start: Position
  end: Position // exclusive
}

interface Position {
  line: number // zero-based
  column: number // zero-based, UTF-16 code units; a tab advances to the next multiple of tabWidth (4)
}
```

Both producers give the same pointers and the same spans: the text producer from its parser, the descriptor producer from the `sourceCodeInfo` of the set (so build descriptor sets with source info: buf includes it, protoc needs `--include_source_info`).

## What is located

For this file:

```proto
syntax = "proto3";
package shop.v1;

message Pet {
  int64 id = 1;
  // @MaxLength 64
  string name = 2;
  reserved 5, 7 to 9;
}
```

the source map holds (lines and columns zero-based, end exclusive):

```text
#/files/pet.proto                                         0:0-8:1    the whole file
#/files/pet.proto/syntax                                  0:0-0:18   syntax = "proto3";
#/files/pet.proto/package                                 1:0-1:16   package shop.v1;
#/components/messages/shop.v1.Pet                         3:0-8:1    message Pet { … }
#/components/messages/shop.v1.Pet/properties/id           4:2-4:15   int64 id = 1;
#/components/messages/shop.v1.Pet/properties/id/number    4:13-4:14  1
#/components/messages/shop.v1.Pet/properties/id/type      4:2-4:7    int64
#/components/messages/shop.v1.Pet/properties/name         6:2-6:18   string name = 2;
#/components/messages/shop.v1.Pet/properties/name/maxLength  5:2-5:18  // @MaxLength 64
#/components/messages/shop.v1.Pet/reserved                7:2-7:21   reserved 5, 7 to 9;
#/components/messages/shop.v1.Pet/reserved/numbers/0      7:11-7:12  5
#/components/messages/shop.v1.Pet/reserved/numbers/1      7:14-7:20  7 to 9
```

In general:

| Pointer                                                                                                                       | Span                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `#/files/<path>`                                                                                                              | the whole file                                                                           |
| `…/syntax`, `…/package`, `…/imports/<i>`, `…/options/<name>` of a file                                                        | the statement                                                                            |
| `#/services/<S>`, `…/methods/<M>`, `#/components/messages/<M>`, `#/components/enums/<E>`                                      | the declaration, from its keyword to its closing `}` or `;`                              |
| `…/methods/<M>/request`, `…/response`                                                                                         | the type name; `…/request/stream`, `…/response/stream` the `stream` keyword              |
| `…/properties/<f>`, `…/values/<V>`, `#/components/extensions/<x>`                                                             | the field or value declaration                                                           |
| `…/number`, `…/type` (also for `$ref`), `…/jsonName`, `…/default`                                                             | the token or option                                                                      |
| `…/presence`                                                                                                                  | the `optional` / `required` label when written, else the field                           |
| `…/oneofs/<k>`                                                                                                                | the `oneof` block                                                                        |
| `…/reserved/numbers/<i>`, `…/reserved/names/<i>`, `…/extensions/<i>`                                                          | the written range or name that starts the interval                                       |
| `…/options/<name>`, `…/deprecation`, `…/idempotency`, `…/http`                                                                | the option statement                                                                     |
| lifted keywords (`required`, `minimum`, `format`, `examples`, …), also under `items`, `propertyNames`, `additionalProperties` | the option statement they were lifted from, or the line of the comment tag or AIP prefix |
| resolved features (`packed`, `utf8Validation`, `jsonFormat`)                                                                  | the option that sets them on the element itself; an inherited value has no entry         |

Bundled files are located too, so a type such as `google.protobuf.Timestamp` points into the bundled `timestamp.proto`. The [conversion examples](/examples/) show the source map of each example in the **Source map** tab, and the [online demo](/demo) has a **Source map** output.

## `locatePointer`

```ts
function locatePointer(pointer: JsonPointer, sourceMap: SourceMap): Location | undefined
```

Returns the entry for the pointer, or for its nearest ancestor that has one, so any node of the document can be located — a description, an item of `examples` or a sub-key of an option fall back to their element. Pointers may be written with or without the leading `#`.

```ts
import { locatePointer } from "protoapi"

locatePointer("#/components/messages/shop.v1.Pet/properties/name/description", sourceMap)
// { file: "pet.proto", start: { line: 6, column: 2 }, end: { line: 6, column: 18 } } — the field
```

## `locateDiff`

```ts
function locateDiff(diff: LocatableDiff, beforeMap: SourceMap, afterMap: SourceMap): Location | undefined

interface LocatableDiff {
  action: string // "add" | "remove" | "replace" | "rename"
  path: (string | number)[] // keys of the document; for "rename", the container
  before?: unknown
  after?: unknown
  origin?: { before: (string | number)[]; after: (string | number)[] }
}
```

`locateDiff` takes a diff of [api-smart-diff](https://github.com/udamir/api-smart-diff) 2.0 between two ProtoApi documents and the source maps of both builds, and returns where the change is:

- `remove` is located in the before files; `add` and `replace` in the after files, falling back to the before map;
- `rename` (`path` is the container, `before` / `after` the old and new key) at the new key, else the old key, else the container;
- an index into `reserved.numbers`, `reserved.names` or `extensions` at the written range;
- a `$ref` leaf at the type name of the field or method;
- `origin`, when present (a change inside a referenced type), replaces `path`;
- anything else at the nearest ancestor with an entry.

If `pet.proto` changes to

```proto
message Pet {
  int64 id = 1;
  // @MaxLength 32
  string name = 2;
  bool good = 3;
  reserved 5;
}
```

then

```ts
import { locateDiff } from "protoapi"

const pet = ["components", "messages", "shop.v1.Pet"]
locateDiff({ action: "add", path: [...pet, "properties", "good"] }, before.sourceMap, after.sourceMap)
// after file 7:2-7:16    bool good = 3;
locateDiff({ action: "replace", path: [...pet, "properties", "name", "maxLength"] }, before.sourceMap, after.sourceMap)
// after file 5:2-5:18    // @MaxLength 32
locateDiff({ action: "remove", path: [...pet, "reserved", "numbers", 1] }, before.sourceMap, after.sourceMap)
// before file 7:14-7:20  7 to 9
```

Both maps are plain data: serialize them next to the documents, and look them up in a viewer without `protoapi`.
