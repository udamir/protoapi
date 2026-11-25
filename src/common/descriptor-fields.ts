// Field numbers of the google/protobuf/descriptor.proto messages, as they appear in `SourceCodeInfo.Location.path`
// and on the wire.

/** `FileDescriptorProto` */
export const FILE = {
  package: 2,
  dependency: 3,
  messageType: 4,
  enumType: 5,
  service: 6,
  extension: 7,
  options: 8,
  syntax: 12,
  edition: 14,
  optionDependency: 15,
} as const

/** `DescriptorProto` */
export const MESSAGE = {
  name: 1,
  field: 2,
  nestedType: 3,
  enumType: 4,
  extensionRange: 5,
  extension: 6,
  options: 7,
  oneofDecl: 8,
  reservedRange: 9,
  reservedName: 10,
} as const

/** `DescriptorProto.ExtensionRange` */
export const EXTENSION_RANGE = { options: 3 } as const

/** `FieldDescriptorProto` */
export const FIELD = {
  name: 1,
  extendee: 2,
  number: 3,
  label: 4,
  type: 5,
  typeName: 6,
  defaultValue: 7,
  options: 8,
  jsonName: 10,
} as const

/** `OneofDescriptorProto` */
export const ONEOF = { name: 1, options: 2 } as const

/** `EnumDescriptorProto` */
export const ENUM = { name: 1, value: 2, options: 3, reservedRange: 4, reservedName: 5 } as const

/** `EnumValueDescriptorProto` */
export const ENUM_VALUE = { name: 1, number: 2, options: 3 } as const

/** `ServiceDescriptorProto` */
export const SERVICE = { name: 1, method: 2, options: 3 } as const

/** `MethodDescriptorProto` */
export const METHOD = {
  name: 1,
  inputType: 2,
  outputType: 3,
  options: 4,
  clientStreaming: 5,
  serverStreaming: 6,
} as const

/** `FileDescriptorSet` */
export const FILE_SET = { file: 1 } as const
