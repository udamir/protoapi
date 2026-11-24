// Option kinds: the elements that carry options and the `google.protobuf.*Options` message of each.

export type OptionsKind =
  | "file"
  | "message"
  | "field"
  | "oneof"
  | "enum"
  | "enumValue"
  | "service"
  | "method"
  | "extensionRange"

export const OPTIONS_MESSAGE: Record<OptionsKind, string> = {
  file: "google.protobuf.FileOptions",
  message: "google.protobuf.MessageOptions",
  field: "google.protobuf.FieldOptions",
  oneof: "google.protobuf.OneofOptions",
  enum: "google.protobuf.EnumOptions",
  enumValue: "google.protobuf.EnumValueOptions",
  service: "google.protobuf.ServiceOptions",
  method: "google.protobuf.MethodOptions",
  extensionRange: "google.protobuf.ExtensionRangeOptions",
}

/** The fully qualified names of all `*Options` messages. */
export const OPTIONS_MESSAGES = new Set<string>(Object.values(OPTIONS_MESSAGE))
