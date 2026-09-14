/**
 * Plumbing agent runtime untuk desktop — tanpa React. Bootstrap runtime
 * (pola cli/src/index.ts), helper jawab approval/ask_user, stop/undo/diff,
 * dan command handlers. Ganti folder = bootstrap ulang runtime.
 */
import { loadConfig, type PermissionMode } from "@topupsaja/core/config.js";
import { fetchModels, type ModelInfo } from "@topupsaja/core/api.js";
import {
  AgentEmitter,
  AskUserManager,
  type AgentRuntime,
  type AskUserAnswer,
} from "@topupsaja/core/agent/runtime.js";
import { PermissionManager, type ApprovalAnswer } from "@topupsaja/core/agent/permission.js";
import { loadPermissionRules } from "@topupsaja/core/agent/rules.js";
import {
  discoverCustomModes,
  buildSystemPrompt,
  type CustomMode,
} from "@topupsaja/core/agent/modes.js";
import { runTurn, setMode, setPermissionMode, startNewSession } from "@topupsaja/core/agent/loop.js";
import { undoLastTurn, diffCheckpoints } from "@topupsaja/core/agent/checkpoints.js";
import { AgentSession, lastSessionId } from "@topupsaja/core/session/store.js";
import { attachPath, detachPath, expandMentions, type AttachResult } from "@topupsaja/core/session/context.js";
import { discoverCommands, renderCommand, type CustomCommand } from "@topupsaja/core/session/commands.js";
import { loadSavedModel, saveModel } from "./chat.js";
import { safeGet, safeSet } from "./storage.js";

export type { AgentRuntime, ModelInfo, AskUserAnswer, AttachResult, CustomCommand };
export { runTurn, setMode, setPermissionMode, startNewSession, undoLastTurn, diffCheckpoints, discoverCommands, renderCommand };

const FOLDER_KEY = "topupsaja.folder";
const RECENT_KEY = "topupsaja.recentFolders";
const RECENT_MAX = 8;

export function loadSavedFolder(): string {
  return safeGet(FOLDER_KEY) ?? "";
}

export function saveFolder(cwd: string): void {
  safeSet(FOLDER_KEY, cwd);
  safeSet(RECENT_KEY, JSON.stringify(pushRecent(loadRecentFolders(), cwd)));
}

function pushRecent(list: string[], cwd: string): string[] {
  return [cwd, ...list.filter((p) => p !== cwd)].slice(0, RECENT_MAX);
}

export function loadRecentFolders(): string[] {
  try {
    const raw = safeGet(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export interface BootstrapResult {
  rt: AgentRuntime;
  models: ModelInfo[];
  model: string;
  mode: string;
  customModes: CustomMode[];
  warnings: string[];
}

export async function bootstrapAgent(cwd: string): Promise<BootstrapResult> {
  const cfg = await loadConfig();
  const customModes = await discoverCustomModes(cwd);
  const { rules, errors } = await loadPermissionRules(cwd);

  const models = await fetchModels();
  let model = loadSavedModel();
  if (!model || !models.some((m) => m.id === model)) model = cfg.model ?? "";
  if (!model || !models.some((m) => m.id === model)) model = models[0]?.id ?? "";
  saveModel(model);

  const permMode: PermissionMode = cfg.permission_mode ?? "ask";

  // Sesi: lanjutkan sesi terakhir folder ini, atau buat baru.
  const last = await lastSessionId(cwd);
  let session: AgentSession | null = last ? await AgentSession.load(cwd, last) : null;
  if (session && session.model && models.some((m) => m.id === session!.model)) model = session.model;
  if (!session) session = AgentSession.create(cwd, model, "");

  const mode = session.mode || "code";
  if (!session.messages.some((m) => m.role === "system")) {
    session.messages.unshift({ role: "system", content: await buildSystemPrompt(cwd, mode, customModes) });
  }

  const rt: AgentRuntime = {
    cwd,
    session,
    permissions: new PermissionManager(permMode, cfg.tool_allowlist ?? [], rules, cwd),
    emitter: new AgentEmitter(),
    askUser: new AskUserManager(),
    mode,
    customModes,
    models,
    abort: false,
    abortController: null,
    checkpointTurns: [],
    turnSnapshots: [],
    mcp: [],
  };

  return { rt, models, model, mode, customModes, warnings: errors };
}

/** Jawab approval; warning dari 'always' ditampilkan sebagai notice. */
export async function answerApproval(
  rt: AgentRuntime,
  id: string,
  ans: ApprovalAnswer,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const warn = await rt.permissions.answer(id, ans, tool, args);
  if (warn) rt.emitter.emit("notice", warn);
}

export function answerAskUser(rt: AgentRuntime, id: string, ans: AskUserAnswer): void {
  rt.askUser.answer(id, ans);
}

export function stopTurn(rt: AgentRuntime): void {
  rt.abort = true;
  rt.abortController?.abort();
}

export async function sendUserTurn(rt: AgentRuntime, text: string) {
  return runTurn(rt, await expandMentions(text, rt.cwd));
}

/** Attach file/folder via dialog; kumpulkan notice hasil per path.
 *  Gambar → user message vision one-shot (sama seperti /add di CLI). */
export async function attachFiles(rt: AgentRuntime, paths: string[]): Promise<void> {
  for (const p of paths) {
    const res = await attachPath(rt.session, rt.cwd, p);
    if (res.image) {
      const model = rt.models.find((m) => m.id === rt.session.model);
      if (model && model.supports_vision === false) {
        rt.emitter.emit("notice", `Model ${rt.session.model} tidak mendukung vision — ganti model dulu.`);
        continue;
      }
      rt.session.messages.push({
        role: "user",
        content: [{ type: "text", text: `[gambar] ${res.image.path}` }, res.image.part],
      });
      await rt.session.save();
      const kb = Math.max(1, Math.round(res.image.bytes / 1024));
      rt.emitter.emit("notice", `Gambar dilampirkan: ${res.image.path} (${kb} KB)`);
    } else if (res.message) {
      rt.emitter.emit("notice", res.message);
    }
  }
}

export async function detachFile(rt: AgentRuntime, path: string): Promise<void> {
  const res = await detachPath(rt.session, rt.cwd, path);
  if (res.message) rt.emitter.emit("notice", res.message);
}

export function listAttached(rt: AgentRuntime): string[] {
  return rt.session.attached.map((a) => a.path);
}

/** Ganti model runtime: update session.model + simpan preferensi. */
export async function changeModel(rt: AgentRuntime, id: string): Promise<void> {
  rt.session.model = id;
  saveModel(id);
  await rt.session.save();
}
