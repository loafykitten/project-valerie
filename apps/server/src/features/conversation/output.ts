export function isStructuredCompanionOutput(text: string): boolean {
  // These are output wrappers, not word-level restrictions on conversation.
  if (
    /(?:^|\n)\s*[[{]/u.test(text) ||
    /```|~~~/u.test(text) ||
    /\{\s*"(?:[^"\\]|\\.)+"\s*:/u.test(text) ||
    /(?:^|\n)\s*(?:["']?(?:decision|finish_reason|request_id)["']?\s*:|<(?:decision|analysis|think|response|message|text)(?:\s|>))/iu.test(
      text,
    )
  )
    return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
