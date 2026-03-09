import { Schema } from "effect";

export class McpServerManagerError extends Schema.TaggedErrorClass<McpServerManagerError>()(
  "McpServerManagerError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
