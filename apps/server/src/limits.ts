import { MAX_PROMPT_BYTES } from "@valerie/core";

// JSON may encode one UTF-8 control byte as six ASCII bytes (for example \u0000).
// Leave room for the wrapper so valid authored text reaches domain validation.
export const MAX_ADMIN_BODY_BYTES = 6 * MAX_PROMPT_BYTES + 4096;
