/** A complete HTTP response can still contain unusable, token-truncated output. */
export class TruncatedChatCompletionError extends Error {
  constructor(endpoint: string, public readonly content: string) {
    super(`Chat completion from ${endpoint} was truncated by its token limit; increase maxTokens before ingesting it`);
  }
}
