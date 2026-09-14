import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getHost } from "@topupsaja/core/host.js";

const KEYRING_ACCOUNT = "api_key";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function apiOrigin(): string {
  return (getHost().env.TOPUPSAJA_API_URL || "https://api.topupsaja.com").replace(/\/+$/, "");
}

export async function getStoredKey(): Promise<string | null> {
  return invoke<string | null>("keyring_get", { account: KEYRING_ACCOUNT });
}

export async function saveKey(key: string): Promise<void> {
  await invoke("keyring_set", { account: KEYRING_ACCOUNT, value: key });
  getHost().env.TOPUPSAJA_API_KEY = key;
}

export async function clearKey(): Promise<void> {
  await invoke("keyring_delete", { account: KEYRING_ACCOUNT });
  delete getHost().env.TOPUPSAJA_API_KEY;
}

export interface VerifyResult {
  email: string;
  balance: number;
}

/** Verify key di server. 401 → null (logout). Error jaringan → throw (offline). */
export async function verifyStoredKey(key: string): Promise<VerifyResult | null> {
  const res = await fetch(`${apiOrigin()}/api/v1/auth/verify`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`verify gagal: HTTP ${res.status}`);
  const data = await res.json();
  return { email: data.email, balance: data.balance };
}

/** Login Google OAuth di browser, tunggu token loopback, exchange jadi API key. */
export async function loginWithGoogle(
  onStatus: (msg: string) => void,
): Promise<{ email: string; balance: number }> {
  const origin = apiOrigin();

  onStatus("Menyiapkan sesi login…");
  const onToken = new Channel<string>();
  const tokenPromise = new Promise<string>((resolve) => {
    onToken.onmessage = (t) => resolve(t);
  });
  const start = await invoke<{ port: number; redirectUri: string }>("oauth_start", {
    apiOrigin: origin,
    onToken,
  });

  onStatus("Membuka browser untuk login Google…");
  await openUrl(
    `${origin}/api/v1/auth/google/start?redirect_uri=${encodeURIComponent(start.redirectUri)}`,
  );

  onStatus("Menunggu login di browser… (timeout 5 menit)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const token = await Promise.race([
    tokenPromise,
    new Promise<never>((_, rej) => {
      timer = setTimeout(
        () => rej(new Error("Timeout: login tidak selesai dalam 5 menit")),
        LOGIN_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));

  onStatus("Menukar token dengan API key…");
  const res = await fetch(`${origin}/api/v1/auth/exchange`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Exchange gagal: HTTP ${res.status}`);
  const data = await res.json();
  await saveKey(data.api_key);
  return { email: data.email, balance: data.balance_credits };
}