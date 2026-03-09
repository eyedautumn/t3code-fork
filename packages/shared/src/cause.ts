import { Cause } from "effect";

const trimMessage = (value: string): string => value.trim();

export const safeCauseMessage = (cause: unknown): string => {
  if (cause == null) return "Unknown error";

  try {
    if (Cause.isCause(cause)) {
      try {
        const squashed = Cause.squash(cause);
        const message =
          squashed instanceof Error ? trimMessage(squashed.message) : trimMessage(String(squashed));
        if (message.length > 0) return message;
      } catch {
        // Fall through to other strategies.
      }

      try {
        const pretty = trimMessage(Cause.pretty(cause));
        if (pretty.length > 0) return pretty;
      } catch {
        // Fall through to other strategies.
      }
    }
  } catch {
    // Fall through to other strategies.
  }

  if (cause instanceof Error) {
    const message = trimMessage(cause.message);
    if (message.length > 0) return message;
  }

  try {
    const message = trimMessage(String(cause));
    if (message.length > 0) return message;
  } catch {
    // Ignore stringification failures.
  }

  return "Unknown error";
};

export const safeCauseSquash = (cause: unknown): unknown => {
  if (cause == null) return cause;

  try {
    if (Cause.isCause(cause)) {
      return Cause.squash(cause);
    }
  } catch {
    // Fall through to return the original cause.
  }

  return cause;
};
