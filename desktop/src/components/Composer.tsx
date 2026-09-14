import { useMemo } from "react";
import type { ModelInfo } from "../lib/chat";
import type { CustomCommand } from "../lib/agent";
import type { PermissionMode } from "@topupsaja/core/config.js";
import { baseName } from "./format";

export const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: "ask", label: "ask" },
  { value: "auto-edit", label: "auto-edit" },
  { value: "yolo", label: "yolo" },
];

export const COMMANDS = [
  { cmd: "/new", desc: "Sesi baru" },
  { cmd: "/resume", desc: "Lanjutkan sesi tersimpan" },
  { cmd: "/mode ", desc: "Ganti mode (code/architect/ask/test/custom)" },
  { cmd: "/permission ", desc: "Permission ask/auto-edit/yolo" },
  { cmd: "/model ", desc: "Ganti model" },
  { cmd: "/undo", desc: "Batalkan perubahan turn terakhir" },
  { cmd: "/diff", desc: "Diff checkpoint turn terakhir" },
];

export default function Composer({
  input,
  setInput,
  inputRef,
  onSend,
  onKeyDown,
  busy,
  ready,
  canSend,
  onStop,
  attached,
  onAttach,
  onDetach,
  models,
  model,
  onModelChange,
  mode,
  modeOptions,
  onModeChange,
  permMode,
  onPermChange,
  customCmds,
  apiOrigin,
}: {
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  busy: boolean;
  ready: boolean;
  canSend: boolean;
  onStop: () => void;
  attached: string[];
  onAttach: () => void;
  onDetach: (p: string) => void;
  models: ModelInfo[];
  model: string;
  onModelChange: (id: string) => void;
  mode: string;
  modeOptions: string[];
  onModeChange: (m: string) => void;
  permMode: PermissionMode;
  onPermChange: (pm: PermissionMode) => void;
  customCmds: CustomCommand[];
  apiOrigin: string;
}) {
  const slashMatches = useMemo(() => {
    if (!input.startsWith("/")) return [];
    const q = input.toLowerCase();
    const all = [...COMMANDS, ...customCmds.map((c) => ({ cmd: c.name, desc: c.description }))];
    return all.filter((c) => c.cmd.trim().toLowerCase().startsWith(q.trim())).slice(0, 6);
  }, [input, customCmds]);

  const selectCls =
    "rounded-md border border-[#e4e4e0] bg-white px-1.5 py-1 text-xs text-[#1f2328] disabled:opacity-50";

  return (
    <footer className="border-t border-[#e4e4e0] bg-[#f7f7f5] px-4 py-3">
      {attached.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-3xl gap-1.5 overflow-x-auto">
          {attached.map((p) => (
            <span
              key={p}
              className="flex shrink-0 items-center gap-1 rounded-full border border-[#e4e4e0] bg-white px-2 py-0.5 text-xs text-[#1f2328]"
              title={p}
            >
              <span className="max-w-48 truncate font-mono">{baseName(p)}</span>
              <button onClick={() => onDetach(p)} title={`Lepas ${p}`} className="text-zinc-400 transition hover:text-red-500">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mx-auto max-w-3xl rounded-xl border border-[#e4e4e0] bg-white shadow-sm">
        {slashMatches.length > 0 && (
          <div className="relative">
            <div className="absolute bottom-full left-0 z-40 mb-1 w-full overflow-hidden rounded-lg border border-[#e4e4e0] bg-white shadow-xl">
              {slashMatches.map((c) => (
                <button
                  key={c.cmd}
                  onClick={() => setInput(c.cmd)}
                  className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#f7f7f5]"
                >
                  <span className="font-mono text-[#1f2328]">{c.cmd.trim()}</span>
                  <span className="text-xs text-zinc-500">{c.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-end gap-2 px-2 py-2">
          <button
            onClick={onAttach}
            disabled={busy || !ready}
            title="Lampirkan file"
            className="rounded-lg border border-[#e4e4e0] bg-white px-3 py-2 text-sm text-[#1f2328] transition hover:bg-[#f7f7f5] disabled:cursor-not-allowed disabled:opacity-50"
          >
            📎
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ketik pesan… (Enter kirim, Shift+Enter baris baru, / perintah)"
            disabled={busy || !ready}
            className="flex-1 resize-none rounded-lg border border-[#e4e4e0] bg-white px-3 py-2 text-sm text-[#1f2328] placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-[#2563eb] disabled:opacity-50"
          />
          {busy ? (
            <button onClick={onStop} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600">
              Stop
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!input.trim() || !canSend}
              className="rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Kirim
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-[#f0f0ee] px-2 py-1.5">
          <select value={mode} onChange={(e) => onModeChange(e.target.value)} disabled={busy || !ready} className={selectCls} title="Mode">
            {modeOptions.map((m) => (
              <option key={m} value={m}>
                mode: {m}
              </option>
            ))}
          </select>
          <select
            value={permMode}
            onChange={(e) => onPermChange(e.target.value as PermissionMode)}
            disabled={busy || !ready}
            className={selectCls}
            title="Permission mode"
          >
            {PERMISSION_MODES.map((p) => (
              <option key={p.value} value={p.value}>
                perm: {p.label}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={busy || !ready}
            className={`${selectCls} max-w-56`}
            title="Model"
          >
            {models.length === 0 && model && <option value={model}>{model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-zinc-400">API: {apiOrigin}</span>
        </div>
      </div>
    </footer>
  );
}
