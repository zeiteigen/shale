import OpenAI from "openai";
import type { ModelRole } from "./config";
import { modelCoordinator } from "./scheduler";

export async function modelRequest<T>(
  role: ModelRole,
  endpoint: string,
  request: () => Promise<T>,
  resource?: string | null,
): Promise<T> {
  return modelCoordinator.request(
    role,
    endpoint,
    async () => {
      try {
        return await request();
      } catch (error) {
        if (error instanceof OpenAI.APIConnectionError) {
          throw new Error(
            `Failed to connect to ${role} endpoint at ${endpoint}: ${error.message}`,
            { cause: error },
          );
        }
        if (error instanceof OpenAI.APIError) {
          const label = role === "chat" ? "Chat" : "Embedding";
          throw new Error(
            `OpenAI ${label} API error (HTTP ${error.status} from ${endpoint}): ${error.message}`,
            { cause: error },
          );
        }
        throw error;
      }
    },
    resource,
  );
}
