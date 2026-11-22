/** Example `.proto` inputs: the conversion examples page renders each one, and the online demo offers them as presets */
import type { BuildOptions } from "../../../src/index.ts"

export interface ExampleCase {
  id: string
  title: string
  /** anchor of the specification section that defines the mapping */
  spec: string
  /** import path -> `.proto` text; every file is an entry file of the build */
  files: Record<string, string>
  /** build options other than the defaults, shown next to the call */
  options?: BuildOptions
}

export const CASES: ExampleCase[] = [
  {
    id: "pet-shop",
    title: "Pet shop",
    spec: "_3-9-complete-example",
    files: {
      "shop/v1/pet.proto": `// Pet shop API.
//
// Copyright the pet shop authors.

syntax = "proto3";

package shop.v1;

import "google/api/annotations.proto";
import "google/api/field_behavior.proto";

option go_package = "example.com/shop/v1;shopv1";

// The pet shop.
service PetService {
  // Get a pet by id.
  rpc GetPet(GetPetRequest) returns (Pet) {
    option (google.api.http) = { get: "/v1/pets/{id}" };
  }

  // Stream every pet of the shop.
  rpc ListPets(ListPetsRequest) returns (stream Pet) {
    option idempotency_level = NO_SIDE_EFFECTS;
  }
}

// A pet in the shop.
message Pet {
  // Required. Unique id.
  int64 id = 1;

  // @Format email
  // @MaxLength 254
  string owner_email = 2 [(google.api.field_behavior) = REQUIRED];

  optional string nickname = 3; // what the owner calls it

  repeated string tags = 4 [json_name = "petTags"];

  map<string, int32> attrs = 5;

  oneof kind {
    Dog dog = 10;
    Cat cat = 11;
  }

  // Creation time, in Unix seconds.
  int64 created_at = 12 [(google.api.field_behavior) = OUTPUT_ONLY];

  Status status = 13 [deprecated = true];

  reserved 6, 7 to 9;
  reserved "legacy_name";

  message Dog { bool good = 1; }
  message Cat { int32 lives = 1; }
}

enum Status {
  STATUS_UNSPECIFIED = 0;
  STATUS_AVAILABLE = 1;
  STATUS_SOLD = 2;
}

message GetPetRequest {
  int64 id = 1;
}

message ListPetsRequest {
  // @Maximum 100
  int32 page_size = 1;
}
`,
    },
  },
  {
    id: "scalars",
    title: "Scalar fields",
    spec: "_3-4-scalar-mapping",
    files: {
      "scalars.proto": `syntax = "proto3";

package demo.scalars;

message Scalars {
  int32 i32 = 1;
  int64 i64 = 2;
  uint32 u32 = 3;
  uint64 u64 = 4;
  sint32 s32 = 5;
  sint64 s64 = 6;
  fixed32 f32 = 7;
  fixed64 f64 = 8;
  sfixed32 sf32 = 9;
  sfixed64 sf64 = 10;
  float ratio = 11;
  double score = 12;
  bool active = 13;
  string name = 14;
  bytes payload = 15;
}
`,
    },
  },
  {
    id: "presence",
    title: "Cardinality and presence",
    spec: "_3-5-identity-ordering-and-omission-rules",
    files: {
      "presence.proto": `syntax = "proto3";

package demo.presence;

message Profile {
  string name = 1;               // implicit presence: no key
  optional string nickname = 2;  // explicit presence
  repeated string emails = 3;    // repeated: type array
  repeated int32 scores = 4 [packed = false];
  Address home = 5;              // message fields always track presence
  optional Address work = 6;     // ... so optional changes nothing
  repeated Address others = 7;
}

message Address {
  string city = 1;
}
`,
    },
  },
  {
    id: "maps",
    title: "Maps",
    spec: "_3-3-construct-mapping",
    files: {
      "maps.proto": `syntax = "proto3";

package demo.maps;

message Inventory {
  map<string, int32> counts = 1;
  map<int64, Item> items_by_id = 2;
  map<bool, string> labels = 3;
  map<string, Kind> kinds = 4;
}

message Item {
  string name = 1;
}

enum Kind {
  KIND_UNSPECIFIED = 0;
  KIND_FOOD = 1;
}
`,
    },
  },
  {
    id: "oneofs",
    title: "Oneofs",
    spec: "_3-3-construct-mapping",
    files: {
      "oneofs.proto": `syntax = "proto3";

package demo.oneofs;

message Payment {
  string id = 1;

  // How the payment is made.
  oneof method {
    Card card = 2;
    string iban = 3;
    // Deprecated: wallets are no longer supported.
    string wallet_id = 4;
  }

  // proto3 optional: a synthetic oneof, not listed in oneofs
  optional int64 amount = 5;
}

message Card {
  string number = 1;
}
`,
    },
  },
  {
    id: "nested",
    title: "Nested types and name resolution",
    spec: "_3-5-identity-ordering-and-omission-rules",
    files: {
      "nested.proto": `syntax = "proto3";

package demo.nested;

message Order {
  message Line {
    message Price {
      int64 cents = 1;
      string currency = 2;
    }
    string sku = 1;
    Price price = 2;
  }

  enum State {
    STATE_UNSPECIFIED = 0;
    STATE_OPEN = 1;
  }

  repeated Line lines = 1;
  State state = 2;
  Line.Price total = 3;
  .demo.nested.Customer customer = 4; // fully qualified
}

message Customer {
  string name = 1;
}
`,
    },
  },
  {
    id: "proto2",
    title: "proto2: defaults, required and groups",
    spec: "_3-6-canonical-values",
    files: {
      "legacy.proto": `syntax = "proto2";

package demo.legacy;

message Order {
  required int64 id = 1;
  optional string note = 2 [default = "none"];
  optional int32 qty = 3 [default = 1];
  optional int64 big = 4 [default = 9007199254740993];
  optional Color color = 5 [default = GREEN];
  optional double ratio = 6 [default = inf];
  repeated int32 codes = 7;
  repeated int32 packed_codes = 8 [packed = true];
  optional bytes magic = 9 [default = "\\x00\\xFFok"];

  optional group Shipping = 10 {
    optional string carrier = 1;
  }

  extensions 100 to 199;
}

enum Color {
  RED = 1;
  GREEN = 2;
}

extend Order {
  optional bool priority = 100;
}
`,
    },
  },
  {
    id: "enums",
    title: "Enums",
    spec: "_3-3-construct-mapping",
    files: {
      "enums.proto": `syntax = "proto3";

package demo.enums;

// Workflow state of an order.
enum OrderStatus {
  option allow_alias = true;

  ORDER_STATUS_UNSPECIFIED = 0;
  // Created, not yet paid.
  ORDER_STATUS_PENDING = 1;
  ORDER_STATUS_PAID = 2;
  ORDER_STATUS_SETTLED = 2; // alias of PAID
  ORDER_STATUS_CANCELLED = 3 [deprecated = true];

  reserved 4, 10 to 20;
  reserved "ORDER_STATUS_LOST";
}

message Order {
  OrderStatus status = 1;
  repeated OrderStatus history = 2;
}
`,
    },
  },
  {
    id: "reserved",
    title: "Reserved numbers, names and extension ranges",
    spec: "_3-5-identity-ordering-and-omission-rules",
    files: {
      "reserved.proto": `syntax = "proto2";

package demo.reserved;

message Envelope {
  reserved 2, 3, 4 to 6, 9;
  reserved 15 to 50;
  reserved "old_name", "legacy";

  optional string id = 1;

  extensions 100 to 199, 200 to 299;
  extensions 1000 to 1999 [verification = UNVERIFIED];
}
`,
    },
  },
  {
    id: "extensions",
    title: "Extensions and custom options",
    spec: "_3-7-options",
    files: {
      "acme/options.proto": `syntax = "proto3";

package acme.options;

import "google/protobuf/descriptor.proto";

message Audit {
  string owner = 1;
  bool pii = 2;
  repeated string tags = 3;
}

extend google.protobuf.MessageOptions {
  optional string table = 50001;
}

extend google.protobuf.FieldOptions {
  optional Audit audit = 50002;
}

extend google.protobuf.MethodOptions {
  optional int32 timeout_ms = 50003;
}
`,
      "acme/users.proto": `syntax = "proto3";

package acme.users;

import "acme/options.proto";

message User {
  option (acme.options.table) = "users";

  string id = 1;
  string email = 2 [(acme.options.audit) = { owner: "security" pii: true tags: ["contact"] }];
  string name = 3 [(acme.options.audit).owner = "profile"];
}

service Users {
  rpc GetUser(User) returns (User) {
    option (acme.options.timeout_ms) = 500;
  }
}
`,
    },
  },
  {
    id: "builtin-options",
    title: "Built-in options",
    spec: "_3-7-options",
    files: {
      "options.proto": `syntax = "proto3";

package demo.options;

option java_package = "com.example.demo";
option java_multiple_files = true;
option optimize_for = SPEED; // the default: not written
option deprecated = true;    // stays under the file's options

message Account {
  option deprecated = true;

  int64 id = 1 [jstype = JS_STRING];
  string display_name = 2 [json_name = "name"];
  string user_name = 3 [json_name = "userName"]; // equal to the default: not written
  string secret = 4 [debug_redact = true];
  repeated int32 flags = 5 [packed = true];       // the proto3 default
  string legacy = 6 [deprecated = true, ctype = CORD];
}
`,
    },
  },
  {
    id: "services",
    title: "Services and methods",
    spec: "_3-3-construct-mapping",
    files: {
      "chat.proto": `syntax = "proto3";

package demo.chat.v1;

import "google/api/annotations.proto";

// Chat rooms.
service ChatService {
  rpc GetRoom(GetRoomRequest) returns (Room) {
    option idempotency_level = NO_SIDE_EFFECTS;
    option (google.api.http) = {
      get: "/v1/rooms/{id}"
      additional_bindings { get: "/v1/rooms:byName/{id}" }
    };
  }

  rpc UpdateRoom(Room) returns (Room) {
    option idempotency_level = IDEMPOTENT;
    option (google.api.http) = { patch: "/v1/rooms/{id}" body: "*" };
  }

  rpc Upload(stream Chunk) returns (Room) {
    option (google.api.http) = { custom { kind: "UPLOAD" path: "/v1/rooms:upload" } body: "*" };
  }

  rpc Subscribe(GetRoomRequest) returns (stream Message);

  rpc Chat(stream Message) returns (stream Message) {
    option deprecated = true;
  }
}

message GetRoomRequest { string id = 1; }
message Room { string id = 1; string name = 2; }
message Chunk { bytes data = 1; }
message Message { string text = 1; }
`,
    },
  },
  {
    id: "well-known-types",
    title: "Well-known types",
    spec: "_3-3-construct-mapping",
    files: {
      "events.proto": `syntax = "proto3";

package demo.events;

import "google/protobuf/duration.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/wrappers.proto";

message Event {
  string id = 1;
  google.protobuf.Duration ttl = 2;
  google.protobuf.Int64Value attendees = 3;
  google.protobuf.FieldMask update_mask = 4;
}

service Events {
  rpc Ping(google.protobuf.Empty) returns (google.protobuf.Empty);
}
`,
    },
  },
  {
    id: "comments",
    title: "Comments and descriptions",
    spec: "_3-8-annotation-layer",
    files: {
      "comments.proto": `// The comments demo.
//
// This header is detached from the syntax statement by a blank line, so it is
// the file's description.

syntax = "proto3";

package demo.comments;

// A note.
//
// Descriptions keep  line breaks and blank lines,
// and   collapse runs of spaces.
message Note {
  // Leading comment.
  string text = 1; // Trailing comment.

  /* A block comment
   * with a leading star on every line. */
  string author = 2;

  // Detached: a blank line separates it from the field.

  int64 created = 3;
}

enum Mood {
  MOOD_UNSPECIFIED = 0; // Not set.
  // Deprecated: use MOOD_UNSPECIFIED.
  MOOD_NEUTRAL = 1;
}
`,
    },
  },
  {
    id: "comment-tags",
    title: "Comment tags",
    spec: "_3-8-annotation-layer",
    files: {
      "tags.proto": `syntax = "proto3";

package demo.tags;

message Product {
  // Stock keeping unit.
  // @Pattern ^[A-Z]{3}-\\d{4}$
  // @Example "ABC-1234"
  string sku = 1;

  // @Minimum 0
  // @ExclusiveMaximum 1000000
  // @Default 100
  int64 price_cents = 2;

  // @Format email
  // @Required
  string contact = 3;

  // @MinItems 1
  // @MaxItems 10
  // @MaxLength 32
  repeated string labels = 4;

  // @Enum S, M, L
  string size = 5;

  // @ReadOnly
  // @Title Last update
  int64 updated = 6;

  // @Deprecated use sku
  string code = 7;

  // @since 1.2 (not a known tag: stays in the description)
  string origin = 8;
}
`,
    },
  },
  {
    id: "aip",
    title: "AIP prefixes and google.api field options",
    spec: "_3-8-annotation-layer",
    files: {
      "library.proto": `syntax = "proto3";

package demo.library.v1;

import "google/api/field_behavior.proto";
import "google/api/field_info.proto";

message Book {
  // Identifier. The resource name.
  string name = 1;

  // Required. The title of the book.
  string title = 2;

  // Output only. When the book was added.
  int64 create_time = 3;

  // Input only. A one-time token.
  string token = 4;

  // Immutable. The ISBN.
  string isbn = 5;

  // Optional. A comment.
  string comment = 6;

  string request_id = 7 [
    (google.api.field_info).format = UUID4,
    (google.api.field_behavior) = OPTIONAL
  ];

  string author = 8 [(google.api.field_behavior) = REQUIRED, (google.api.field_behavior) = IMMUTABLE];

  repeated string tags = 9 [(google.api.field_behavior) = UNORDERED_LIST];
}
`,
    },
  },
  {
    id: "protovalidate",
    title: "protovalidate rules",
    spec: "_3-8-annotation-layer",
    files: {
      "signup.proto": `syntax = "proto3";

package demo.signup;

import "buf/validate/validate.proto";

message Signup {
  int32 age = 1 [(buf.validate.field).int32 = { gt: 0, lte: 150 }];
  int64 ref = 2 [(buf.validate.field).int64.gte = 1];
  double score = 3 [(buf.validate.field).double = { gte: 0, lt: 1 }];
  string email = 4 [(buf.validate.field).string.email = true, (buf.validate.field).required = true];
  string name = 5 [(buf.validate.field).string = { min_len: 1, max_len: 64, pattern: "^[A-Za-z ]+$" }];
  string code = 6 [(buf.validate.field).string = { len: 6, prefix: "SH" }];
  string kind = 7 [(buf.validate.field).string = { in: ["cat", "dog"] }];
  bytes token = 8 [(buf.validate.field).bytes = { min_len: 16, max_len: 16 }];
  bool tos = 9 [(buf.validate.field).bool.const = true];
  repeated string tags = 10 [(buf.validate.field).repeated = { min_items: 1, unique: true, items: { string: { max_len: 16 } } }];
  map<string, int32> quotas = 11 [(buf.validate.field).map = { max_pairs: 8, values: { int32: { gte: 0 } } }];
  string referrer = 12 [(buf.validate.field).cel = { id: "referrer", expression: "this != 'self'" }];

  option (buf.validate.message).oneof = { fields: ["email", "name"] };
}
`,
    },
  },
  {
    id: "pgv-openapiv2",
    title: "Legacy PGV and grpc-gateway",
    spec: "_3-8-annotation-layer",
    files: {
      "gateway.proto": `syntax = "proto3";

package demo.gateway;

import "protoc-gen-openapiv2/options/annotations.proto";
import "validate/validate.proto";

message Order {
  option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_schema) = {
    json_schema: { title: "An order" required: ["id"] }
  };

  string id = 1 [(validate.rules).string.uuid = true];
  uint32 quantity = 2 [(validate.rules).uint32 = { gte: 1, lte: 99 }];
  Address address = 3 [(validate.rules).message.required = true];

  string note = 4 [(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {
    title: "Note"
    example: "\\"leave at the door\\""
    max_length: 200
    read_only: true
  }];
}

message Address {
  string city = 1;
}
`,
    },
  },
  {
    id: "conflicts",
    title: "Precedence and conflicts",
    spec: "_3-8-annotation-layer",
    files: {
      "coupon.proto": `syntax = "proto3";

package demo.coupon;

import "buf/validate/validate.proto";
import "google/api/field_behavior.proto";

message Coupon {
  // @MaxLength 100
  // @Required
  string code = 1 [(buf.validate.field).string.max_len = 64, (google.api.field_behavior) = OPTIONAL];

  // @Format email
  string contact = 2 [(buf.validate.field).string.uuid = true];

  // @MaxLength 64
  string note = 3 [(buf.validate.field).string.max_len = 64];
}
`,
    },
  },
  {
    id: "editions",
    title: "Editions 2023",
    spec: "_3-5-identity-ordering-and-omission-rules",
    files: {
      "editions.proto": `edition = "2023";

package demo.editions;

option features.field_presence = IMPLICIT;

message Thing {
  string name = 1 [features.field_presence = LEGACY_REQUIRED];
  int32 count = 2;
  string label = 3 [features.field_presence = EXPLICIT];
  repeated int32 ids = 4 [features.repeated_field_encoding = EXPANDED];
  string raw = 5 [features.utf8_validation = NONE];
  Part part = 6 [features.message_encoding = DELIMITED];

  message Part {
    string id = 1;
  }
}

enum Level {
  option features.enum_type = CLOSED;

  LEVEL_LOW = 1;
  LEVEL_HIGH = 2;
}

message Legacy {
  option features.json_format = LEGACY_BEST_EFFORT;

  string json = 1;
}
`,
    },
  },
  {
    id: "edition-2024",
    title: "Edition 2024: visibility and option imports",
    spec: "_3-3-construct-mapping",
    files: {
      "acme/opts.proto": `edition = "2024";

package acme.opts;

import "google/protobuf/descriptor.proto";

extend google.protobuf.MessageOptions {
  string table = 50100;
}
`,
      "shop/v2/shop.proto": `edition = "2024";

package shop.v2;

import option "acme/opts.proto";

export message Pet {
  option (acme.opts.table) = "pets";

  local message Secret {
    string s = 1;
  }

  Secret secret = 1;
}

local enum Internal {
  INTERNAL_UNKNOWN = 0;
}

message Plain {}
`,
    },
  },
  {
    id: "imports",
    title: "Imports and bundled files",
    spec: "_3-3-construct-mapping",
    files: {
      "shop/v1/api.proto": `syntax = "proto3";

package shop.v1;

import "shop/v1/types.proto";
import "google/protobuf/empty.proto";

service Shop {
  rpc Get(GetRequest) returns (Item);
  rpc Clear(google.protobuf.Empty) returns (google.protobuf.Empty);
}

message GetRequest {
  string id = 1;
  common.v1.Money budget = 2; // re-exported by types.proto
}
`,
      "shop/v1/types.proto": `syntax = "proto3";

package shop.v1;

import public "common/v1/money.proto";

message Item {
  string id = 1;
  common.v1.Money price = 2;
}

message Unused {
  string note = 1;
}
`,
      "common/v1/money.proto": `syntax = "proto3";

package common.v1;

message Money {
  string currency = 1;
  int64 units = 2;
}
`,
    },
    options: { entry: ["shop/v1/api.proto"] },
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    spec: "_4-2-build-results-and-issues",
    files: {
      "broken.proto": `syntax = "proto3";

package demo.broken;

import "missing/thing.proto";

message Broken {
  string id = 1;
  int32 count = 1;
  Unknown ref = 2;
  required string legacy = 3;
  string bad = 4 [(nope.option) = 1];
  // @Minimum lots
  int32 size = 5;

  reserved 6;
  string reused = 6;
}
`,
    },
  },
]
