import type { Database } from "bun:sqlite";
import type { MessageBus } from "../lib/messages";
import type {
  AIClientOptions,
  EmbedderOptions,
  LLMOptions,
} from "../lib/ai/types";

export interface ModelProfiles {
  connection?: AIClientOptions;
  chat?: LLMOptions;
  embedding?: EmbedderOptions;
}

export interface ExtensionSDKOptions {
  namespace?: string;
  database?: Database;
  extensionName?: string;
  extensionDir?: string;
  messageBus?: MessageBus;
  models?: ModelProfiles;
}
