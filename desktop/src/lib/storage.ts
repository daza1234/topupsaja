/**
 * Akses localStorage yang aman — WebKitGTK bisa melempar DOMException
 * ("The string did not match the expected pattern.") saat DB localStorage
 * korup. Semua baca/tulis preferensi harus lewat wrapper ini supaya app
 * tetap jalan (prefs hilang = degrade halus, bukan crash saat render).
 */

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn(`localStorage.getItem("${key}") gagal:`, e);
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn(`localStorage.setItem("${key}") gagal:`, e);
  }
}
