/** Skema tool v2 dalam format OpenAI function calling. */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Baca isi file teks. Return isi file dengan nomor baris. Auto-izin (tidak butuh approval).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file (relatif atau absolut)' },
          offset: { type: 'integer', description: 'Nomor baris awal (1-indexed), opsional' },
          limit: { type: 'integer', description: 'Jumlah baris maksimal, opsional' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Tulis/buat file (overwrite penuh). Butuh approval user — tampilkan preview dulu. Bila formatter hook terkonfigurasi, file bisa diformat ulang otomatis setelah ditulis.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file tujuan' },
          content: { type: 'string', description: 'Konten lengkap file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit file: ganti old_string dengan new_string (harus exact match dan unik di file). Gagal bila old_string tidak ditemukan atau muncul lebih dari sekali. Bila formatter hook terkonfigurasi, file bisa diformat ulang otomatis setelah diedit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file' },
          old_string: { type: 'string', description: 'Teks exact yang mau diganti' },
          new_string: { type: 'string', description: 'Teks pengganti' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Jalankan command shell (bash) di cwd sesi. Timeout 120 detik. Output stdout+stderr dipotong ~10k karakter. Butuh approval user — command ditampilkan dulu. Command read-only yang aman (ls, cat, git status, grep, dll) otomatis diizinkan tanpa approval; command berbahaya (sudo, curl|sh, rm -rf /, dsb) ditolak keras di semua mode.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command bash yang mau dijalankan' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Cari file by pattern glob (mis. "src/**/*.ts"). Support * ? ** []. Auto-izin. Skip node_modules dan .git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern glob relatif cwd' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Cari teks/regex rekursif di file. Return file:baris: konten. Auto-izin. Skip node_modules, .git, dan file binary.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern regex (JS regex syntax)' },
          path: { type: 'string', description: 'File atau direktori awal, default cwd' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description:
        'Cari definisi symbol (fungsi, class, struct, interface, type, dll) berdasarkan nama di kode project (TS/JS/Python/Go/Rust/PHP). Return path:baris: signature. Auto-izin.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nama symbol (substring, case-insensitive), minimal 2 karakter' },
          path: { type: 'string', description: 'File atau direktori awal, default cwd' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Tulis daftar todo untuk tugas multi-langkah. Ganti seluruh daftar tiap kali dipanggil; update status item menjadi in_progress saat mulai dikerjakan dan completed setelah selesai.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Daftar todo lengkap (replace semua item lama)',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Deskripsi langkah' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: 'Status item',
                },
                priority: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: 'Prioritas, opsional',
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Tanyakan satu keputusan ke user dengan pilihan opsi (single-select, atau multi-select bila multi_select=true) — gunakan HANYA saat butuh keputusan user sebelum lanjut; JANGAN untuk pertanyaan yang bisa dijawab dari kode; maksimal 1 pertanyaan per keputusan. User bisa memilih opsi, mengetik jawaban bebas, atau membatalkan.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Pertanyaan singkat dan jelas (satu keputusan)' },
          multi_select: {
            type: 'boolean',
            description: 'true bila user boleh memilih lebih dari satu opsi',
          },
          options: {
            type: 'array',
            description: '2–5 opsi pilihan',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Label singkat opsi' },
                description: { type: 'string', description: 'Penjelasan singkat opsi, opsional' },
              },
              required: ['label'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Ambil konten URL (http/https) → teks polos (HTML di-strip, cap 20k char, timeout 15s). Read-only, auto-izin. Gunakan untuk dokumentasi/API publik; konten besar akan dipotong.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL lengkap yang mau diambil (harus http/https)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        'Delegasikan tugas riset read-only ke subagent (loop kecil dengan read_file, glob, grep, model sama, maks 15 langkah). Gunakan untuk pencarian/analisa kode yang butuh banyak langkah baca tanpa mengotori konteks percakapan utama. Return: jawaban ringkas subagent.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Instruksi riset yang jelas dan spesifik untuk subagent' },
        },
        required: ['task'],
      },
    },
  },
] as const

/** Skema tool MCP (mcp__<server>__<tool>) dari koneksi aktif. */
export function mcpToolSchemas(mcp: { name: string; tools: { name: string; description?: string; inputSchema?: unknown }[] }[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const conn of mcp) {
    for (const t of conn.tools) {
      out.push({
        type: 'function',
        function: {
          name: `mcp__${conn.name}__${t.name}`,
          description: t.description
            ? `[MCP:${conn.name}] ${t.description}`
            : `[MCP:${conn.name}] tool '${t.name}'`,
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      })
    }
  }
  return out
}
