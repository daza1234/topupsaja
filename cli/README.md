# topupsaja — TopUpSaja CLI v2

CLI coding agent **TUI full-screen** dari TopUpSaja (gateway AI prepaid credit
Indonesia), dibangun dengan [Ink 5](https://github.com/vadimdemedes/ink) +
React 18. Nama binary utama: `topupsaja`; `tsa` tersedia sebagai alias pendek
(`tsa` ≡ `topupsaja`).

## Fitur v2

- **TUI Ink full-screen** — streaming jawaban per-token, tool cards, approval
  dialog, todo panel live, status bar (mode/permission/model/token/saldo/konteks).
- **Semua request streaming** — termasuk turn yang membawa `tools`; delta
  `tool_calls` diakumulasi per index. Fallback non-stream otomatis sekali bila
  SSE gagal di awal.
- **Sessions persisten** — tiap sesi disimpan di
  `~/.topupsaja/projects/<hash-cwd>/sessions/<id>.json`; lanjutkan dengan
  `--continue` (sesi terakhir) atau `--resume` (picker).
- **Permission modes** — `ask` (tanya semua), `auto-edit`
  (write/edit otomatis, bash tanya), `yolo` (semua otomatis). Jawaban
  **[a]lways** menyimpan allowlist per-tool di config dan berlaku lintas sesi.
- **Mode plan/act** — `/plan` membuat agent read-only (write/edit/bash ditolak
  dengan pesan); `/act` kembali ke eksekusi penuh. Judul rencana diakhiri
  langkah-langkah bernomor.
- **Todo tool** — agent multi-langkah memakai `todo_write`; panel checklist
  update live.
- **Compaction otomatis** — bila estimasi konteks (chars/4) lewat 70% context
  window, pesan lama diringkas via 1 call chat dengan **model termurah aktif**,
  menyisakan system + ringkasan + 8 pesan terakhir. Manual: `/compact`.
- **AGENTS.md** — bila ada di cwd, isinya diinjeksi ke system prompt.
  `/init` meminta agent menuliskannya dari struktur project.
- **@-mentions** — ketik `@path/file` di pesan untuk menyisipkan isi file
  (maks 50k char) ke konteks; autocomplete muncul saat mengetik `@`.
- **Fallback non-TTY** — bila stdout/stdin bukan TTY (pipe/CI) atau dengan
  `--plain`, jalan tanpa Ink: REPL teks polos + one-shot, jalur headless yang sama.

## Install & Build

```bash
cd cli
npm install
npm run build
npm link        # opsional: pasang `topupsaja` (dan alias `tsa`) global
```

## Mulai cepat

```bash
topupsaja login        # simpan API key (sk-ts-...) ke ~/.topupsaja/config.json (0600)
topupsaja models       # lihat model aktif + harga credit
topupsaja model ts/claude-3-haiku   # set model default

topupsaja              # TUI interaktif di folder sekarang
topupsaja --continue   # lanjut sesi terakhir folder ini
topupsaja --resume     # pilih sesi tersimpan
topupsaja --mode plan  # mulai dalam mode plan
topupsaja --permission yolo   # auto-approve semua tool
topupsaja "prompt awal"  # one-shot: satu turn lalu keluar (plain output)
```

`tsa` tersedia sebagai alias pendek (`tsa` ≡ `topupsaja`).

Perintah lain: `topupsaja balance`, `topupsaja models`.

## Slash commands di dalam sesi

| Perintah       | Fungsi                                        |
| -------------- | --------------------------------------------- |
| `/plan` `/act` | toggle mode plan / act                        |
| `/permissions` | ganti permission mode (ask → auto-edit → yolo)|
| `/sessions`    | pilih & muat sesi tersimpan                   |
| `/init`        | generate AGENTS.md dari struktur project      |
| `/todo`        | lihat todo saat ini                           |
| `/compact`     | paksa ringkas konteks                         |
| `/model`       | pilih model (fetch `/v1/models`)              |
| `/clear`       | reset riwayat sesi                            |
| `/balance`     | cek credit (GET `/v1/credits`)                |
| `/help` `/exit`| bantuan / keluar                              |

Shortcut TUI: **Esc** batalkan turn yang berjalan; **Enter** kirim,
**Shift/Alt+Enter** baris baru; **↑/↓** riwayat input; **Tab** lengkapi
autocomplete `@file` dan slash-command.

## Approval dialog

Untuk `write_file` / `edit_file` / `bash`, TUI menampilkan preview diff/command:

- **[y]** — izinkan sekali
- **[n]** — tolak (agent diberi tahu user menolak)
- **[a]** — izinkan **selalu** untuk tool tersebut (tersimpan di
  `~/.topupsaja/config.json` → `tool_allowlist`; tidak disimpan bila ada rule
  granular ask/deny yang match — muncul warning)
- **[p]** — izinkan **pola** (khusus bash): rule allow prefix seperti
  `npm run*` disimpan ke `<cwd>/.tsa/settings.json`
- **edit_file** dengan ≥2 hunk: hunk bisa dipilih per-blok (j/k navigasi,
  Space toggle, Enter terapkan hanya hunk terpilih)

## Aturan permission granular

Aturan allow/ask/deny berbasis glob, dibaca dari
`<cwd>/.tsa/settings.json` (project) lalu `~/.topupsaja/settings.json` (global)
— **hot-reload otomatis tiap awal turn** tanpa restart:

```json
{
  "permissions": [
    { "tool": "bash", "pattern": "npm install*", "action": "allow" },
    { "tool": "bash", "pattern": "npm publish*", "action": "ask" },
    { "tool": "read_file", "pattern": "*.env*", "action": "deny" },
    { "tool": "web_fetch", "pattern": "**localhost**", "action": "deny" }
  ]
}
```

- Precedence: **deny absolut** > **spesifisitas pattern** > **ask** > **allow**;
  tie → project > global. Rule `ask` berlaku juga di mode yolo.
- Match target per tool: `bash` → command penuh; `read_file`/`write_file`/
  `edit_file` → path relatif cwd; `web_fetch` → URL; tool lain → nama tool.
- Keputusan permission (termasuk hasil approval user) tercatat di audit log
  sesi (`permission_log`, 200 entri terakhir) — tampil di `/permissions`.

## Tool bawaan

`read_file`, `write_file`, `edit_file`, `bash` (klasifikasi aman/berbahaya),
`glob`, `grep`, `find_symbol`, `todo_write`, `task` (subagent riset
read-only), `web_fetch` (ambil URL http/https → teks, strip HTML, cap 20k
char, read-only), dan `ask_user` — termasuk **multi-select**
(`multi_select: true`, user bisa memilih lebih dari satu opsi).

## Format sesi

```
~/.topupsaja/
├── config.json                          # api_key, base_url, model, permission_mode, tool_allowlist
├── settings.json                        # aturan permission global (permissions[])
└── projects/<hash-cwd>/sessions/<id>.json
    # { id, title(=pesan user pertama), model, created, updated,
    #   mode, permission_mode, messages[], todos[], permission_log[] }
```

Aturan project ada di `<cwd>/.tsa/settings.json` dengan format `permissions[]`
yang sama.

## Lingkungan

- Node ≥ 18.17
- Env: `TOPUPSAJA_API_KEY`, `TOPUPSAJA_API_URL` (untuk dev server:
  `TOPUPSAJA_API_URL=http://localhost:3000`), `TOPUPSAJA_PLAIN=1` (paksa teks polos).

## Catatan

- Publishing ke npm dilakukan manual (di luar scope kode).
- Server & web tidak berubah di v2 — semua fitur murni client-side.
