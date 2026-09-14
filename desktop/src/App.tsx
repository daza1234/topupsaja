import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, applyUpdate, type Update } from "./lib/updater";
import {
  apiOrigin,
  clearKey,
  getStoredKey,
  loginWithGoogle,
  verifyStoredKey,
  type VerifyResult,
} from "./lib/auth";
import { saveModel, type ModelInfo } from "./lib/chat";
import {
  bootstrapAgent,
  loadSavedFolder,
  loadRecentFolders,
  saveFolder,
  answerApproval,
  answerAskUser,
  stopTurn,
  sendUserTurn,
  setMode,
  setPermissionMode,
  startNewSession,
  undoLastTurn,
  diffCheckpoints,
  changeModel,
  attachFiles,
  detachFile,
  listAttached,
  discoverCommands,
  renderCommand,
  type AgentRuntime,
  type AskUserAnswer,
  type CustomCommand,
} from "./lib/agent";
import { splitHunks } from "@topupsaja/core/agent/hunks.js";
import { ALL_MODES, type CustomMode } from "@topupsaja/core/agent/modes.js";
import type { ApprovalRequest, ApprovalAnswer } from "@topupsaja/core/agent/permission.js";
import type { AskUserRequest } from "@topupsaja/core/agent/runtime.js";
import { AgentSession, listSessions, type SessionMeta } from "@topupsaja/core/session/store.js";
import { getHost } from "@topupsaja/core/host.js";
import type { TodoItem } from "@topupsaja/core/storage/todo.js";
import type { PermissionMode } from "@topupsaja/core/config.js";
import type { ChatMessage } from "@topupsaja/core/api.js";
import Sidebar from "./components/Sidebar";
import Composer, { PERMISSION_MODES } from "./components/Composer";
import { baseName, fmtNum } from "./components/format";

type Status = "checking" | "login" | "main";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; desc: string; result?: { ok: boolean; output: string } }
  | { kind: "notice"; text: string; error?: boolean };

interface StatusInfo {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  creditsUsed?: number;
  balance?: number;
  contextPct?: number;
}

/** Ekstrak teks dari ChatMessage (content string atau array part) — skip tool/system. */
function messageText(m: ChatMessage): string | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
  }
  return null;
}

// ── Komponen kecil ──

function ToolOutput({ output }: { output: string }) {
  const [showAll, setShowAll] = useState(false);
  const lines = output.split("\n");
  const truncated = !showAll && lines.length > 40;
  const text = truncated ? lines.slice(0, 40).join("\n") : output;
  return (
    <pre className="max-h-72 overflow-auto rounded bg-[#f6f8fa] p-2 font-mono text-xs text-[#1f2328] whitespace-pre-wrap">
      {text}
      {truncated && (
        <button onClick={() => setShowAll(true)} className="block mt-1 text-zinc-500 underline hover:text-[#1f2328]">
          tampilkan semua ({lines.length} baris)
        </button>
      )}
    </pre>
  );
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  return (
    <details className="self-stretch rounded-lg border border-[#e4e4e0] bg-white px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none flex items-center gap-2">
        <span className="font-medium text-[#1f2328]">⚙ {item.name}</span>
        <span className="truncate text-zinc-500">{item.desc}</span>
        {!item.result && <span className="ml-auto h-2 w-2 animate-pulse rounded-full bg-zinc-400" />}
        {item.result && (
          <span className={`ml-auto text-xs ${item.result.ok ? "text-green-600" : "text-red-500"}`}>
            {item.result.ok ? "ok" : "gagal"}
          </span>
        )}
      </summary>
      {item.result && (
        <div className="mt-2">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Output — {item.name}</p>
          <ToolOutput output={item.result.output} />
        </div>
      )}
    </details>
  );
}

function DiffPreview({ preview }: { preview: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded bg-[#f6f8fa] p-2 font-mono text-xs whitespace-pre-wrap">
      {preview.split("\n").map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith("+")
              ? "bg-green-50 text-green-700"
              : line.startsWith("-")
                ? "bg-red-50 text-red-600"
                : "text-zinc-500"
          }
        >
          {line}
        </div>
      ))}
    </pre>
  );
}

function ApprovalModal({ req, onAnswer }: { req: ApprovalRequest; onAnswer: (ans: ApprovalAnswer) => void }) {
  const hunks = useMemo(() => (req.tool === "edit_file" ? splitHunks(req.preview) : []), [req]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(hunks.map((_, i) => i + 1)));

  function submit(ans: ApprovalAnswer) {
    onAnswer(req.tool === "edit_file" && hunks.length > 0 ? { ...ans, hunks: [...selected].sort((a, b) => a - b) } : ans);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#e4e4e0] bg-white p-4 text-sm text-[#1f2328] shadow-2xl">
        <h2 className="font-semibold">{req.label}</h2>
        {req.args?.path != null && <p className="mt-1 font-mono text-xs text-zinc-500">{String(req.args.path)}</p>}
        {req.tool === "bash" && <p className="mt-1 font-mono text-xs text-zinc-500">{String(req.args.command ?? "")}</p>}
        {hunks.length > 1 && (
          <p className="mt-2 text-xs text-zinc-500">Pilih bagian yang diterapkan:</p>
        )}
        {req.tool === "edit_file" && hunks.length > 1 ? (
          hunks.map((hk, i) => (
            <label key={i} className="mt-2 block cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(i + 1)}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(i + 1);
                    else next.delete(i + 1);
                    return next;
                  })
                }
              />{" "}
              <span className="text-xs text-zinc-500">Hunk {i + 1}</span>
              <DiffPreview preview={hk.lines.join("\n")} />
            </label>
          ))
        ) : req.preview ? (
          <div className="mt-2">
            <DiffPreview preview={req.preview} />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button onClick={() => submit({ approved: false })} className="rounded-lg border border-[#e4e4e0] px-3 py-1.5 hover:bg-[#f7f7f5]">
            Tolak
          </button>
          {req.tool === "bash" && (
            <button onClick={() => submit({ approved: true, alwaysPattern: true })} className="rounded-lg border border-[#e4e4e0] px-3 py-1.5 hover:bg-[#f7f7f5]">
              Izinkan pola
            </button>
          )}
          <button onClick={() => submit({ approved: true, always: true })} className="rounded-lg border border-[#e4e4e0] px-3 py-1.5 hover:bg-[#f7f7f5]">
            Selalu izinkan
          </button>
          <button onClick={() => submit({ approved: true })} className="rounded-lg bg-[#2563eb] px-3 py-1.5 font-medium text-white hover:bg-[#1d4ed8]">
            Izinkan
          </button>
        </div>
      </div>
    </div>
  );
}

function AskUserModal({ req, onAnswer }: { req: AskUserRequest; onAnswer: (ans: AskUserAnswer) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const single = (v: string) => onAnswer({ kind: "option", label: v });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-xl border border-[#e4e4e0] bg-white p-4 text-sm text-[#1f2328] shadow-2xl">
        <p className="whitespace-pre-wrap">{req.question}</p>
        <div className="mt-3 space-y-1.5">
          {req.multiSelect
            ? req.options.map((o) => (
                <label key={o.label} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[#f7f7f5]">
                  <input
                    type="checkbox"
                    checked={picked.includes(o.label)}
                    onChange={(e) =>
                      setPicked((prev) => (e.target.checked ? [...prev, o.label] : prev.filter((x) => x !== o.label)))
                    }
                  />
                  <span>
                    {o.label}
                    {o.description && <span className="block text-xs text-zinc-500">{o.description}</span>}
                  </span>
                </label>
              ))
            : req.options.map((o) => (
                <button
                  key={o.label}
                  onClick={() => single(o.label)}
                  className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-[#f7f7f5]"
                >
                  {o.label}
                  {o.description && <span className="block text-xs text-zinc-500">{o.description}</span>}
                </button>
              ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Atau ketik jawaban bebas…"
          className="mt-3 w-full resize-none rounded-lg border border-[#e4e4e0] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={() => onAnswer({ kind: "cancel" })} className="rounded-lg border border-[#e4e4e0] px-3 py-1.5 hover:bg-[#f7f7f5]">
            Batal
          </button>
          {req.multiSelect && picked.length > 0 && (
            <button onClick={() => onAnswer({ kind: "options", labels: picked })} className="rounded-lg bg-[#2563eb] px-3 py-1.5 font-medium text-white hover:bg-[#1d4ed8]">
              Kirim pilihan
            </button>
          )}
          <button
            onClick={() => text.trim() && onAnswer({ kind: "text", text: text.trim() })}
            disabled={!text.trim()}
            className="rounded-lg bg-[#2563eb] px-3 py-1.5 font-medium text-white hover:bg-[#1d4ed8] disabled:opacity-50"
          >
            Kirim teks
          </button>
        </div>
      </div>
    </div>
  );
}

// ── App ──

type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest" }
  | { phase: "available"; update: Update }
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "ready" }
  | { phase: "error"; message: string };

function UpdateModal({ state, onClose, onApply }: { state: UpdateState; onClose: () => void; onApply: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-[#e4e4e0] bg-white p-4 text-sm text-[#1f2328] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold">Pembaruan aplikasi</h2>
        <div className="mt-2">
          {state.phase === "checking" && <p className="text-zinc-500">Memeriksa pembaruan…</p>}
          {state.phase === "latest" && <p className="text-zinc-500">Aplikasi sudah versi terbaru.</p>}
          {state.phase === "available" && <p className="text-zinc-500">Versi baru tersedia. Unduh dan instal sekarang?</p>}
          {state.phase === "downloading" && (
            <p className="text-zinc-500">
              Mengunduh…{" "}
              {state.total
                ? `${Math.round((state.downloaded / state.total) * 100)}%`
                : `${Math.round(state.downloaded / 1024)} KB`}
            </p>
          )}
          {state.phase === "ready" && <p className="text-zinc-500">Selesai. Aplikasi akan dimulai ulang.</p>}
          {state.phase === "error" && <p className="text-red-500">{state.message}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {state.phase === "available" && (
            <button onClick={onApply} className="rounded-lg bg-[#2563eb] px-3 py-1.5 font-medium text-white hover:bg-[#1d4ed8]">
              Unduh &amp; instal
            </button>
          )}
          {state.phase === "downloading" && <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400" />}
          <button onClick={onClose} className="rounded-lg border border-[#e4e4e0] px-3 py-1.5 hover:bg-[#f7f7f5]">
            {state.phase === "ready" ? "Mulai ulang" : "Tutup"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("checking");
  const [account, setAccount] = useState<VerifyResult | null>(null);
  const [loginMsg, setLoginMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // ── Agent runtime ──
  const [folder, setFolder] = useState(loadSavedFolder());
  const [recentFolders, setRecentFolders] = useState<string[]>(() => loadRecentFolders());
  const [rt, setRt] = useState<AgentRuntime | null>(null);
  const [bootError, setBootError] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [mode, setModeState] = useState("code");
  const [permMode, setPermModeState] = useState<PermissionMode>("ask");
  const [customModes, setCustomModes] = useState<CustomMode[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const [customCmds, setCustomCmds] = useState<CustomCommand[]>([]);

  // ── Render items + modal state ──
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [askReq, setAskReq] = useState<AskUserRequest | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [stat, setStat] = useState<StatusInfo | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessions, setSessions] = useState<{ metas: SessionMeta[]; loading: boolean; error: string }>({
    metas: [],
    loading: false,
    error: "",
  });
  const [diffText, setDiffText] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [updState, setUpdState] = useState<UpdateState>({ phase: "idle" });
  const updRef = useRef<Update | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const unsubsRef = useRef<(() => void)[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const balance = stat?.balance ?? account?.balance ?? 0;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const key = await getStoredKey();
      if (!key) {
        if (!cancelled) setStatus("login");
        return;
      }
      try {
        const v = await verifyStoredKey(key);
        if (cancelled) return;
        if (v) {
          getHost().env.TOPUPSAJA_API_KEY = key;
          setAccount(v);
          setStatus("main");
        } else {
          await clearKey();
          setStatus("login");
        }
      } catch {
        if (!cancelled) {
          setError("Tidak bisa terhubung ke server. Periksa koneksi internet Anda.");
          setStatus("login");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bootstrap runtime saat folder berubah (atau pertama masuk main).
  useEffect(() => {
    if (status !== "main" || !folder) return;
    let cancelled = false;
    setBootError("");
    bootstrapAgent(folder)
      .then((res) => {
        if (cancelled) return;
        setRt(res.rt);
        setModels(res.models);
        setModel(res.model);
        setModeState(res.rt.mode);
        setPermModeState(res.rt.permissions.mode);
        setCustomModes(res.customModes);
        setStat({ model: res.model, balance: res.rt.session.lastBalance });
        for (const fn of unsubsRef.current) fn();
        unsubsRef.current = [];
        // Riwayat resume: teks sederhana user/assistant (termasuk content array).
        const histItems: Item[] = [];
        for (const m of res.rt.session.messages) {
          const t = messageText(m);
          if (t && t.length > 0) histItems.push({ kind: m.role as "user" | "assistant", text: t });
        }
        if (histItems.length > 0)
          histItems.push({ kind: "notice", text: "Sesi sebelumnya dilanjutkan — /new untuk mulai baru." });
        setItems(histItems);
        setTodos(res.rt.session.todos.items);
        setAttached(listAttached(res.rt));
        setCustomCmds(discoverCommands(res.rt.cwd));
      })
      .catch((e) => {
        if (!cancelled) setBootError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [status, folder]);

  // Pasang listener event runtime.
  useEffect(() => {
    if (!rt) return;
    const em = rt.emitter;
    const unsubs = [
      em.on("delta", (text) => {
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === "assistant") return [...prev.slice(0, -1), { ...last, text: last.text + text }];
          return [...prev, { kind: "assistant", text }];
        });
      }),
      em.on("tool_start", (info) => {
        setItems((prev) => [...prev, { kind: "tool", id: info.id, name: info.name, desc: info.desc }]);
      }),
      em.on("tool_result", (info) => {
        setItems((prev) =>
          prev.map((it) => (it.kind === "tool" && it.id === info.id ? { ...it, result: { ok: info.ok, output: info.output } } : it))
        );
      }),
      em.on("approval_request", (req) => setApproval(req)),
      em.on("ask_user_request", (req) => setAskReq(req)),
      em.on("status", (info) => setStat(info)),
      em.on("notice", (text) => setItems((prev) => [...prev, { kind: "notice", text }])),
      em.on("todo", (t) => setTodos(t)),
      em.on("mode_changed", (info) => {
        setModeState(info.mode);
        setPermModeState(info.permissionMode);
      }),
      em.on("done", () => {
        setBusy(false);
        // Judul/waktu sesi berubah tiap turn — segarkan daftar sidebar.
        void listSessions(rt.cwd)
          .then((metas) => setSessions({ metas, loading: false, error: "" }))
          .catch(() => {});
      }),
      em.on("error", (msg) => {
        setBusy(false);
        setItems((prev) => [...prev, { kind: "notice", text: msg, error: true }]);
      }),
    ];
    unsubsRef.current = unsubs;
    return () => {
      for (const fn of unsubs) fn();
      unsubsRef.current = [];
    };
  }, [rt]);

  const refreshSessions = useCallback(async () => {
    if (!rt) return;
    setSessions((s) => ({ ...s, loading: true }));
    try {
      const metas = await listSessions(rt.cwd);
      setSessions({ metas, loading: false, error: "" });
    } catch (e) {
      setSessions({ metas: [], loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [rt]);

  useEffect(() => {
    if (rt) void refreshSessions();
  }, [rt, refreshSessions]);

  // Auto-scroll hanya bila user dekat dasar area pesan.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items, approval, askReq]);

  // Ctrl+K → command palette sederhana: fokus input dengan "/".
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setInput("/");
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleLogin() {
    setBusy(true);
    setError("");
    try {
      const v = await loginWithGoogle(setLoginMsg);
      setAccount(v);
      setStatus("main");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setLoginMsg("");
    }
  }

  async function handleLogout() {
    await clearKey();
    setAccount(null);
    setStatus("login");
  }

  async function pickFolder(explicit?: string) {
    let picked = explicit;
    if (!picked) {
      const d = await openDialog({ directory: true, title: "Pilih folder project" });
      if (typeof d === "string" && d) picked = d;
    }
    if (!picked) return;
    saveFolder(picked);
    setRecentFolders(loadRecentFolders());
    setRt(null);
    setItems([]);
    setTodos([]);
    setStat(null);
    setFolder(picked);
  }

  async function handleModelChange(id: string) {
    setModel(id);
    saveModel(id);
    if (rt) await changeModel(rt, id);
  }

  async function handleModeChange(m: string) {
    if (rt) await setMode(rt, m);
  }

  async function handlePermChange(pm: PermissionMode) {
    if (rt) await setPermissionMode(rt, pm);
  }

  function renderResumeHistory(s: AgentSession) {
    const hist: Item[] = [];
    for (const m of s.messages) {
      const t = messageText(m);
      if (t && t.length > 0) hist.push({ kind: m.role as "user" | "assistant", text: t });
    }
    setItems(hist);
  }

  async function resumeSession(id: string) {
    if (!rt) return;
    try {
      const s = await AgentSession.load(rt.cwd, id);
      if (!s) throw new Error("Sesi gagal dimuat.");
      rt.session = s;
      rt.checkpointTurns = [];
      rt.turnSnapshots = [];
      rt.mode = s.mode || "code";
      rt.permissions.mode = s.permissionMode ?? "ask";
      setModel(s.model || model);
      setModeState(rt.mode);
      setPermModeState(rt.permissions.mode);
      setTodos(s.todos.items);
      setStat({ model: s.model, balance: s.lastBalance });
      setAttached(s.attached.map((a) => a.path));
      renderResumeHistory(s);
    } catch (e) {
      setItems((prev) => [...prev, { kind: "notice", text: e instanceof Error ? e.message : String(e), error: true }]);
    }
  }

  async function execCommand(raw: string): Promise<boolean> {
    if (!rt) return false;
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/new": {
        const s = await startNewSession(rt);
        rt.session = s;
        setItems([]);
        setTodos([]);
        setAttached([]);
        await refreshSessions();
        return true;
      }
      case "/resume":
        setSidebarCollapsed(false);
        await refreshSessions();
        return true;
      case "/mode": {
        const valid = [...ALL_MODES, ...customModes.map((c) => c.name)];
        if (!valid.includes(arg)) {
          setItems((prev) => [...prev, { kind: "notice", text: `Mode tidak dikenal: ${arg}. Pilihan: ${valid.join(", ")}` }]);
          return true;
        }
        await handleModeChange(arg);
        return true;
      }
      case "/permission": {
        if (!PERMISSION_MODES.some((p) => p.value === arg)) {
          setItems((prev) => [...prev, { kind: "notice", text: `Permission harus ask | auto-edit | yolo.` }]);
          return true;
        }
        await handlePermChange(arg as PermissionMode);
        return true;
      }
      case "/model": {
        if (!models.some((m) => m.id === arg)) {
          setItems((prev) => [...prev, { kind: "notice", text: `Model tidak tersedia: ${arg}.` }]);
          return true;
        }
        await handleModelChange(arg);
        return true;
      }
      case "/undo": {
        try {
          const restored = await undoLastTurn(rt);
          setItems((prev) => [
            ...prev,
            { kind: "notice", text: restored.length ? `Dipulihkan: ${restored.join(", ")}` : "Tidak ada checkpoint untuk dipulihkan." },
          ]);
        } catch (e) {
          setItems((prev) => [...prev, { kind: "notice", text: e instanceof Error ? e.message : String(e), error: true }]);
        }
        return true;
      }
      case "/diff": {
        setDiffText(await diffCheckpoints(rt));
        return true;
      }
      default:
        return false;
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || busy || !rt) return;
    setInput("");
    stickBottomRef.current = true;
    setItems((prev) => [...prev, { kind: "user", text }]);

    if (text.startsWith("/")) {
      const handled = await execCommand(text);
      if (handled) return;
      const cc = customCmds.find((c) => text === c.name || text.startsWith(c.name + " "));
      if (cc) {
        setBusy(true);
        try {
          await sendUserTurn(rt, renderCommand(cc, text.slice(cc.name.length).trim()));
        } catch (e) {
          setItems((prev) => [...prev, { kind: "notice", text: e instanceof Error ? e.message : String(e), error: true }]);
        } finally {
          setBusy(false);
        }
        return;
      }
      setItems((prev) => [...prev, { kind: "notice", text: `Perintah tidak dikenal: ${text}` }]);
      return;
    }

    setBusy(true);
    try {
      await sendUserTurn(rt, text);
    } catch (e) {
      setItems((prev) => [...prev, { kind: "notice", text: e instanceof Error ? e.message : String(e), error: true }]);
    } finally {
      setBusy(false);
    }
  }

  function handleStop() {
    if (rt) stopTurn(rt);
  }

  async function handleAttach() {
    if (!rt || busy) return;
    const picked = await openDialog({ multiple: true, title: "Lampirkan file" });
    if (!picked || picked.length === 0) return;
    await attachFiles(rt, picked);
    setAttached(listAttached(rt));
  }

  async function handleDetach(path: string) {
    if (!rt) return;
    await detachFile(rt, path);
    setAttached(listAttached(rt));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleCheckUpdate() {
    setUpdState({ phase: "checking" });
    try {
      const update = await checkForUpdate();
      if (update) {
        updRef.current = update;
        setUpdState({ phase: "available", update });
      } else {
        setUpdState({ phase: "latest" });
      }
    } catch (e) {
      setUpdState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleApplyUpdate() {
    const update = updRef.current;
    if (!update) return;
    let downloaded = 0;
    let total: number | null = null;
    setUpdState({ phase: "downloading", downloaded: 0, total: null });
    try {
      await applyUpdate(update, (bytes, t) => {
        if (t != null) {
          total = t;
          downloaded = 0;
        } else {
          downloaded += bytes;
        }
        setUpdState({ phase: "downloading", downloaded, total });
      });
      setUpdState({ phase: "ready" });
    } catch (e) {
      setUpdState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const modeOptions = useMemo(() => [...ALL_MODES, ...customModes.map((c) => c.name)], [customModes]);

  if (status === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f7f7f5] text-zinc-400">
        <div className="animate-spin h-8 w-8 rounded-full border-2 border-zinc-300 border-t-zinc-500" />
      </div>
    );
  }

  if (status === "login") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-6 bg-[#f7f7f5] px-6 text-[#1f2328]">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">TopUpSaja</h1>
          <p className="mt-2 text-zinc-500">Masuk untuk mulai menggunakan aplikasi desktop.</p>
        </div>
        <button
          onClick={handleLogin}
          disabled={busy}
          className="rounded-lg bg-[#2563eb] px-6 py-3 font-medium text-white transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Memproses…" : "Masuk dengan Google"}
        </button>
        {loginMsg && !error && <p className="text-sm text-zinc-500">{loginMsg}</p>}
        {error && <p className="max-w-md text-center text-sm text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-white text-[#1f2328]">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        folder={folder}
        recentFolders={recentFolders}
        onPickFolder={() => void pickFolder()}
        onOpenFolder={(p) => void pickFolder(p)}
        sessions={sessions}
        activeSessionId={rt?.session.id}
        onNewSession={() => void execCommand("/new")}
        onResume={(id) => void resumeSession(id)}
        email={account?.email}
        balance={balance}
        appVersion={appVersion}
        onCheckUpdate={handleCheckUpdate}
        checkingUpdate={updState.phase === "checking"}
        onLogout={() => void handleLogout()}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Status bar */}
        <div className="flex items-center gap-3 border-b border-[#e4e4e0] bg-[#f7f7f5] px-4 py-1 text-xs text-zinc-500">
          <span className="truncate font-medium text-[#1f2328]">{folder ? `📁 ${baseName(folder)}` : "belum ada project"}</span>
          {rt && (
            <>
              <span className="truncate">{stat?.model || model}</span>
              {stat?.promptTokens != null && <span>in {fmtNum(stat.promptTokens)}</span>}
              {stat?.completionTokens != null && <span>out {fmtNum(stat.completionTokens)}</span>}
              {stat?.creditsUsed != null && <span>{fmtNum(stat.creditsUsed)} kredit terpakai</span>}
              {stat?.contextPct != null && (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-16 overflow-hidden rounded bg-zinc-200">
                    <span
                      className={`block h-full ${stat.contextPct > 85 ? "bg-red-500" : "bg-zinc-400"}`}
                      style={{ width: `${Math.min(100, stat.contextPct)}%` }}
                    />
                  </span>
                  {Math.round(stat.contextPct)}%
                </span>
              )}
            </>
          )}
        </div>

        {bootError && <p className="border-b border-[#e4e4e0] bg-red-50 px-4 py-2 text-sm text-red-600">{bootError}</p>}

        <div className="flex min-h-0 flex-1">
          {/* Pesan */}
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto bg-white px-4 py-6">
            {items.length === 0 && (
              <p className="mt-16 text-center text-sm text-zinc-500">
                {folder ? "Mulai percakapan… (/ untuk perintah)" : "Pilih folder project dulu untuk mulai."}
              </p>
            )}
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {items.map((it, i) => {
                if (it.kind === "notice")
                  return (
                    <div
                      key={i}
                      className={`self-stretch rounded-lg border px-3 py-2 text-sm ${
                        it.error ? "border-red-200 bg-red-50 text-red-600" : "border-[#e4e4e0] bg-[#f7f7f5] text-zinc-500"
                      }`}
                    >
                      {it.text}
                    </div>
                  );
                if (it.kind === "tool") return <ToolCard key={i} item={it} />;
                if (it.kind === "user")
                  return (
                    <div key={i} className="self-stretch rounded-lg bg-[#f7f7f5] px-3 py-2.5 text-sm whitespace-pre-wrap">
                      {it.text}
                    </div>
                  );
                return it.text ? (
                  <div
                    key={i}
                    className="self-stretch text-sm [&_code]:rounded [&_code]:bg-[#f6f8fa] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[#f6f8fa] [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-[#2563eb] [&_a]:underline"
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
                  </div>
                ) : busy ? (
                  <div key={i} className="self-stretch text-sm">
                    <span className="animate-pulse text-zinc-400">…</span>
                  </div>
                ) : null;
              })}
            </div>
          </div>

          {/* Todo panel */}
          {todos.length > 0 && (
            <aside className="w-64 shrink-0 overflow-y-auto border-l border-[#e4e4e0] bg-[#f7f7f5] px-3 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Todo</h2>
              <ul className="mt-2 space-y-1.5 text-sm">
                {todos.map((t, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span
                      className={
                        t.status === "completed"
                          ? "text-green-600"
                          : t.status === "in_progress"
                            ? "text-yellow-500"
                            : "text-zinc-400"
                      }
                    >
                      {t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}
                    </span>
                    <span className={t.status === "completed" || t.status === "cancelled" ? "text-zinc-400 line-through" : "text-[#1f2328]"}>
                      {t.content}
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>

        <Composer
          input={input}
          setInput={setInput}
          inputRef={inputRef}
          onSend={() => void handleSend()}
          onKeyDown={handleKeyDown}
          busy={busy}
          ready={!!rt}
          canSend={!!rt && !!folder && balance >= 1}
          onStop={handleStop}
          attached={attached}
          onAttach={() => void handleAttach()}
          onDetach={(p) => void handleDetach(p)}
          models={models}
          model={model}
          onModelChange={(id) => void handleModelChange(id)}
          mode={mode}
          modeOptions={modeOptions}
          onModeChange={(m) => void handleModeChange(m)}
          permMode={permMode}
          onPermChange={(pm) => void handlePermChange(pm)}
          customCmds={customCmds}
          apiOrigin={apiOrigin()}
        />
      </div>

      {/* Modals */}
      {approval && (
        <ApprovalModal
          req={approval}
          onAnswer={(ans) => {
            const req = approval;
            setApproval(null);
            if (rt) void answerApproval(rt, req.id, ans, req.tool, req.args);
          }}
        />
      )}
      {askReq && (
        <AskUserModal
          req={askReq}
          onAnswer={(ans) => {
            const req = askReq;
            setAskReq(null);
            if (rt) answerAskUser(rt, req.id, ans);
          }}
        />
      )}
      {diffText !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setDiffText(null)}>
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#e4e4e0] bg-white p-4 text-sm text-[#1f2328] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-semibold">Diff turn terakhir</h2>
            <DiffPreview preview={diffText} />
          </div>
        </div>
      )}
      {updState.phase !== "idle" && (
        <UpdateModal state={updState} onClose={() => setUpdState({ phase: "idle" })} onApply={handleApplyUpdate} />
      )}
    </div>
  );
}
