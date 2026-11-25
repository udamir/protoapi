// Number limits of protobuf: field numbers, the message-set maximum, the int32 range of enum value numbers.

/** The largest field number (2^29 - 1), `max` in the `reserved` and `extensions` ranges of a message. */
export const FIELD_NUMBER_MAX = 536870911
/** `max` in a message with `message_set_wire_format = true` (as in protoc) */
export const MESSAGE_SET_NUMBER_MAX = 2147483646
export const INT32_MIN = -2147483648
/** The largest int32: the largest enum value number, `max` in the `reserved` ranges of an enum. */
export const INT32_MAX = 2147483647
/** The field numbers reserved for the protobuf implementation, 19000 to 19999. */
export const IMPLEMENTATION_RESERVED_START = 19000
export const IMPLEMENTATION_RESERVED_END = 19999
