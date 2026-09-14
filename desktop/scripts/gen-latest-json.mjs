#!/usr/bin/env node
// ponytail: updater v1 JSON hanya mendukung AppImage di Linux (deb tidak didukung
// Tauri updater) dan NSIS di Windows. Tambah platform lain via PLATFORMS map.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "daza1234/topupsaja";

const VERSION = "0.1.0";
const BUNDLE = join(import.meta.dirname, "../src-tauri/target/release/bundle");
const BUNDLE_XWIN = join(
  import.meta.dirname,
  "../src-tauri/target/x86_64-pc-windows-msvc/release/bundle",
);
// Tauri updater platform key → nama file artefak di bundle dir
const PLATFORMS = [
  { key: "linux-x86_64", base: BUNDLE, dir: "appimage", file: `TopUpSaja_${VERSION}_amd64.AppImage` },
  { key: "windows-x86_64", base: BUNDLE_XWIN, dir: "nsis", file: `TopUpSaja_${VERSION}_x64-setup.exe` },
];

const platforms = {};
for (const p of PLATFORMS) {
  const path = join(p.base, p.dir, p.file);
  try {
    readFileSync(path); // kalau gagal → artefak belum ada, skip
  } catch {
    console.warn(`skip ${p.key}: ${p.file} tidak ada`);
    continue;
  }
  platforms[p.key] = {
    signature: readFileSync(`${path}.sig`, "utf8").trim(),
    url: `https://github.com/${REPO}/releases/download/v${VERSION}/${p.file}`,
  };
}

if (!Object.keys(platforms).length) {
  console.error("Tidak ada artefak ditemukan. Jalankan `npx tauri build` dulu.");
  process.exit(1);
}

const out = { version: VERSION, pub_date: new Date().toISOString(), platforms };
const dest = join(import.meta.dirname, "../latest.json");
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`OK → ${dest}`);
console.log(JSON.stringify(out.platforms, null, 2));