import type { SessionMeta } from "@topupsaja/core/session/store.js";
import { baseName, fmtNum } from "./format";

export interface SidebarSessions {
  metas: SessionMeta[];
  loading: boolean;
  error: string;
}

export default function Sidebar({
  collapsed,
  onToggleCollapse,
  folder,
  recentFolders,
  onPickFolder,
  onOpenFolder,
  sessions,
  activeSessionId,
  onNewSession,
  onResume,
  email,
  balance,
  appVersion,
  onCheckUpdate,
  checkingUpdate,
  onLogout,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  folder: string;
  recentFolders: string[];
  onPickFolder: () => void;
  onOpenFolder: (path: string) => void;
  sessions: SidebarSessions;
  activeSessionId?: string;
  onNewSession: () => void;
  onResume: (id: string) => void;
  email?: string;
  balance: number;
  appVersion: string;
  onCheckUpdate: () => void;
  checkingUpdate: boolean;
  onLogout: () => void;
}) {
  if (collapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center gap-2 border-r border-[#e4e4e0] bg-[#f7f7f5] py-2">
        <button onClick={onToggleCollapse} title="Buka sidebar" className="rounded-md px-2 py-1 text-zinc-500 hover:bg-white">
          ☰
        </button>
        <button onClick={onNewSession} title="Sesi baru" className="rounded-md px-2 py-1 text-zinc-500 hover:bg-white">
          ＋
        </button>
        <button onClick={onPickFolder} title="Pilih folder project" className="max-h-24 overflow-hidden rounded-md px-1 py-1 text-xs text-zinc-500 hover:bg-white [writing-mode:vertical-rl]">
          {folder ? baseName(folder) : "folder"}
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[#e4e4e0] bg-[#f7f7f5] text-sm">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="font-semibold tracking-tight text-[#1f2328]">TopUpSaja</span>
        <button onClick={onToggleCollapse} title="Ciutkan sidebar" className="rounded-md px-1.5 py-0.5 text-zinc-400 hover:bg-white hover:text-[#1f2328]">
          «
        </button>
      </div>

      {/* Project */}
      <div className="px-3 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Project</h2>
        <button
          onClick={onPickFolder}
          title={folder || "Pilih folder project"}
          className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg border border-[#e4e4e0] bg-white px-2 py-1.5 text-left text-[#1f2328] transition hover:bg-[#f0f1ef]"
        >
          <span>📁</span>
          <span className="truncate">{folder ? baseName(folder) : "Pilih folder…"}</span>
        </button>
        {recentFolders.filter((p) => p !== folder).length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {recentFolders
              .filter((p) => p !== folder)
              .map((p) => (
                <li key={p}>
                  <button
                    onClick={() => onOpenFolder(p)}
                    title={p}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-zinc-500 transition hover:bg-white hover:text-[#1f2328]"
                  >
                    <span className="text-xs">└</span>
                    <span className="truncate">{baseName(p)}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* Sesi */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-[#e4e4e0] px-3 py-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Sesi</h2>
          <button onClick={onNewSession} title="Sesi baru (/new)" className="rounded-md px-1.5 py-0.5 text-zinc-500 hover:bg-white hover:text-[#1f2328]">
            ＋ baru
          </button>
        </div>
        <div className="-mx-1 mt-1 min-h-0 flex-1 overflow-y-auto px-1">
          {sessions.error && <p className="py-1 text-xs text-red-500">{sessions.error}</p>}
          {sessions.loading && <p className="py-1 text-xs text-zinc-500">Memuat…</p>}
          {!sessions.loading && !sessions.error && sessions.metas.length === 0 && (
            <p className="py-1 text-xs text-zinc-400">Belum ada sesi tersimpan.</p>
          )}
          <ul className="space-y-0.5">
            {sessions.metas.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => onResume(s.id)}
                  className={`block w-full rounded-md px-2 py-1.5 text-left transition hover:bg-white ${
                    s.id === activeSessionId ? "bg-white font-medium text-[#1f2328]" : "text-zinc-600"
                  }`}
                >
                  <span className="block truncate">{s.title || "Tanpa judul"}</span>
                  <span className="block truncate text-xs text-zinc-400">
                    {s.model} · {new Date(s.updated).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Akun + versi */}
      <div className="border-t border-[#e4e4e0] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-zinc-500" title={email}>
            {email}
          </span>
          <button onClick={onLogout} className="shrink-0 text-xs text-zinc-400 hover:text-red-500">
            keluar
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className={`text-sm font-semibold tabular-nums ${balance < 1 ? "text-red-500" : ""}`}>
            {fmtNum(balance)} <span className="text-xs font-normal text-zinc-500">kredit</span>
          </span>
          <button
            onClick={onCheckUpdate}
            disabled={checkingUpdate}
            title="Periksa pembaruan"
            className="rounded-md px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-white disabled:opacity-50"
          >
            v{appVersion || "?"} {checkingUpdate ? "…" : "↑"}
          </button>
        </div>
      </div>
    </aside>
  );
}
