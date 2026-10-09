import type { Database } from "bun:sqlite";
import type { MessageBus } from "../lib/messages";
import type {
  AIClientOptions,
  LLMOptions,
} from "../lib/ai/types";

export interface ModelProfiles {
  connection?: AIClientOptions;
  chat?: LLMOptions;
}

export interface ExtensionSDKOptions {
  namespace?: string;
  database?: Database;
  extensionName?: string;
  extensionDir?: string;
  messageBus?: MessageBus;
  models?: ModelProfiles;
}
