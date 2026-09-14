import { fetchModels, streamChat, type ChatMessage, type ModelInfo, type StreamResult } from "@topupsaja/core/api.js";
import { safeGet, safeSet } from "./storage.js";

export type { ChatMessage, ModelInfo };

const MODEL_KEY = "topupsaja.model";

export function loadSavedModel(): string {
  return safeGet(MODEL_KEY) ?? "";
}

export function saveModel(id: string): void {
  safeSet(MODEL_KEY, id);
}

export async function loadModels(): Promise<ModelInfo[]> {
  try {
    return await fetchModels();
  } catch (e) {
    throw new Error(
      e instanceof Error ? `Gagal memuat daftar model: ${e.message}` : "Gagal memuat daftar model."
    );
  }
}

export function sendMessage(
  messages: ChatMessage[],
  model: string,
  onDelta: (text: string) => void,
  onCredits: (info: { credits_used: number; balance: number }) => void,
  signal: AbortSignal
): Promise<StreamResult> {
  return streamChat({ model, messages }, { onDelta, onCredits }, { signal });
}
