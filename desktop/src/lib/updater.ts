import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

export async function checkForUpdate(): Promise<Update | null> {
  return await check();
}

export async function applyUpdate(update: Update, onProgress: (bytes: number, total: number | null) => void): Promise<void> {
  await update.downloadAndInstall((event) => {
    if (event.event === "Started" && event.data.contentLength != null) {
      onProgress(0, event.data.contentLength);
    } else if (event.event === "Progress") {
      onProgress(event.data.chunkLength, null);
    } else if (event.event === "Finished") {
      onProgress(1, 1);
    }
  });
  await relaunch();
}