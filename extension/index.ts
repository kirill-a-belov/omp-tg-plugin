/**
 * omp-telegram-bridge — in-runtime Telegram channel for OMP (oh-my-pi).
 *
 * ONE file, zero npm dependencies, no MCP. Lives in <agentDir>/extensions/
 * (e.g. ~/.omp/agent/extensions/telegram-bridge.ts) and is loaded by OMP at
 * session start.
 *
 * Inbound  : long-polls the bot's getUpdates. Any message from an allowlisted
 *            user is injected via pi.sendUserMessage — a native user prompt:
 *            an idle session starts a turn, a streaming turn receives a steer
 *            (cuts interruptible waits short, injects at the next boundary).
 *            So a phone DM can redirect or stop work mid-task.
 * Outbound : registers a `telegram_send` tool so the agent delivers results
 *            to the user's phone.
 *
 * Config   : <agentDir>/telegram-bridge.json  ->  { "token", "allowed_user_ids" }
 *            (env TELEGRAM_BOT_TOKEN overrides "token").
 * State    : <agentDir>/telegram-bridge.state.json (update offset + dedupe).
 *
 * <agentDir> resolution order: $PI_CODING_AGENT_DIR, else ~/.omp/agent (the
 * standard, and what OMP itself uses by default), else two levels up from
 * this file (only when neither env nor HOME exists). For a project-local
 * install with isolated config, set PI_CODING_AGENT_DIR explicitly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const CHARS_PER_MESSAGE = 4000; // Telegram hard limit is 4096
const POLL_TIMEOUT_S = 40; // long-poll window per getUpdates round trip

function resolveAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const home = process.env.HOME?.trim();
  if (home) return path.join(home, ".omp", "agent");
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

const AGENT_DIR = resolveAgentDir();
const CONFIG_PATH = path.join(AGENT_DIR, "telegram-bridge.json");
const STATE_PATH = path.join(AGENT_DIR, "telegram-bridge.state.json");

interface Config {
  token: string;
  allowed: string[];
}

interface State {
  offset: number;
  seen: string[];
}

interface TgChatMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat?: { id: number };
  text?: string;
}

interface TgMessage {
  update_id: number;
  message?: TgChatMessage;
}

const cfg: Config = loadConfig();
let state: State = loadState();
let stopCurrent: (() => void) | undefined;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function loadConfig(): Config {
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    raw = undefined;
  }
  let fileToken = "";
  let allowed: string[] = [];
  const rec = asRecord(raw ? tryParseJson(raw) : undefined);
  if (rec) {
    if (typeof rec.token === "string" && rec.token) fileToken = rec.token;
    if (Array.isArray(rec.allowed_user_ids)) {
      allowed = rec.allowed_user_ids
        .map((x) => (typeof x === "string" ? x : typeof x === "number" ? String(x) : ""))
        .filter((x) => x !== "");
    }
  }
  const envToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  return { token: envToken || fileToken, allowed };
}

function loadState(): State {
  let offset = 1;
  let seen: string[] = [];
  try {
    const rec = asRecord(tryParseJson(fs.readFileSync(STATE_PATH, "utf8")));
    if (rec) {
      if (typeof rec.offset === "number" && Number.isFinite(rec.offset)) offset = rec.offset;
      if (Array.isArray(rec.seen)) seen = rec.seen.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* no state yet */
  }
  return { offset, seen };
}

function saveState(): void {
  state.seen = state.seen.slice(-200); // dedupe window only
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* non-fatal: offset loss means at most one replay, guarded by `seen` */
  }
}

async function tgRequest(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`telegram ${method} network: ${errMsg(err)}`);
  }
  const j = asRecord(await res.json().catch(() => undefined));
  if (!j || j.ok !== true) {
    const desc = typeof j?.description === "string" ? j.description : `HTTP ${res.status}`;
    throw new Error(`telegram ${method}: ${desc}`);
  }
  return j.result;
}

function normalizeUpdate(u: unknown): TgMessage | null {
  const r = asRecord(u);
  if (!r || typeof r.update_id !== "number") return null;
  const m = asRecord(r.message);
  if (!m) return { update_id: r.update_id };
  const from = asRecord(m.from);
  const chat = asRecord(m.chat);
  return {
    update_id: r.update_id,
    message: {
      message_id: typeof m.message_id === "number" ? m.message_id : 0,
      from:
        from && typeof from.id === "number"
          ? {
              id: from.id,
              username: typeof from.username === "string" ? from.username : undefined,
              first_name: typeof from.first_name === "string" ? from.first_name : undefined,
            }
          : undefined,
      chat: chat && typeof chat.id === "number" ? { id: chat.id } : undefined,
      text: typeof m.text === "string" ? m.text : undefined,
    },
  };
}

async function getUpdates(token: string, offset: number): Promise<TgMessage[]> {
  const r: unknown = await tgRequest(token, "getUpdates", {
    offset,
    timeout: POLL_TIMEOUT_S,
    allowed_updates: ["message"],
  });
  if (!Array.isArray(r)) return [];
  return r.map(normalizeUpdate).filter((u): u is TgMessage => u !== null);
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function sendTelegramText(pi: ExtensionAPI, chatId: string, text: string): Promise<number> {
  const parts = chunk(text, CHARS_PER_MESSAGE);
  let id = 0;
  for (let i = 0; i < parts.length; i++) {
    const r: unknown = await tgRequest(cfg.token, "sendMessage", {
      chat_id: chatId,
      text: parts[i],
      disable_web_page_preview: true,
    });
    const rec = asRecord(r);
    id = rec && typeof rec.message_id === "number" ? rec.message_id : id;
    if (i < parts.length - 1) await delay(2000); // rate-limit cushion
  }
  pi.logger.info(`[telegram-bridge] sent ${parts.length} message(s) to ${chatId}, id=${id}`);
  return id;
}

function startPoller(pi: ExtensionAPI): void {
  stopCurrent?.();
  let stopped = false;
  stopCurrent = () => {
    stopped = true;
  };
  pi.logger.info("[telegram-bridge] polling started (inbound -> session)");
  void (async () => {
    while (!stopped) {
      try {
        const updates = await getUpdates(cfg.token, state.offset);
        if (updates.length > 0) {
          const texts: string[] = [];
          for (const u of updates) {
            state.offset = Math.max(state.offset, u.update_id + 1);
            const uid = String(u.update_id);
            if (state.seen.includes(uid)) continue; // already injected pre-crash
            state.seen.push(uid);
            const msg = u.message;
            const from = msg?.from;
            const text = msg?.text?.trim();
            if (!from || !text) continue; // service msgs, reactions, media
            if (!cfg.allowed.includes(String(from.id))) {
              pi.logger.warn(`[telegram-bridge] drop message from non-allowlisted user ${from.id}`);
              continue;
            }
            const name = from.username ? `@${from.username}` : from.first_name ?? "user";
            const ts = new Date().toISOString();
            const chatId = msg.chat?.id ?? from.id;
            texts.push(
              `[Telegram ${name} (chat ${chatId}) ${ts}] ${text}\n` +
                `— the user is away from the terminal: this is a Telegram instruction; ` +
                `treat it as authoritative, and deliver your reply via telegram_send (chat ${chatId}).`,
            );
          }
          if (texts.length > 0) {
            pi.sendUserMessage(texts.join("\n"));
            pi.logger.info(`[telegram-bridge] injected ${texts.length} inbound message(s)`);
          }
          saveState();
        }
      } catch (err) {
        // Network hiccup / brief 409 on session-switch handoff: log, retry.
        // A dead connection never kills the poller — each round is a fresh
        // fetch, which is why we own the polling instead of an MCP process.
        pi.logger.warn(`[telegram-bridge] poll error: ${errMsg(err)}`);
        await delay(3000);
        continue;
      }
      await delay(1000);
    }
    pi.logger.info("[telegram-bridge] polling stopped");
  })();
}

export default function telegramBridge(pi: ExtensionAPI): void {
  const log = pi.logger;

  if (!cfg.token || cfg.allowed.length === 0) {
    log.error(`[telegram-bridge] DISABLED: set TELEGRAM_BOT_TOKEN (or "token" in ${CONFIG_PATH}) and "allowed_user_ids"`);
    pi.registerTool({
      name: "telegram_send",
      label: "Telegram",
      description: "Disabled: missing bot token or allowlist.",
      parameters: pi.zod.object({}),
      loadMode: "essential",
      approval: "read",
      async execute() {
        return {
          content: [{ type: "text", text: "Telegram bridge is not configured (token/allowlist missing)." }],
          isError: true,
        };
      },
    });
    return;
  }

  log.info(`[telegram-bridge] loaded; allowlist=[${cfg.allowed.join(",")}]`);

  pi.on("session_start", () => {
    startPoller(pi);
  });
  pi.on("session_shutdown", () => {
    saveState();
  });

  const sendSchema = pi.zod.object({
    text: pi.zod.string().min(1).describe("Message body (plain text; >4000 chars is auto-chunked)"),
    chat_id: pi.zod.string().optional().describe("Optional Telegram chat id; defaults to the allowlisted user"),
  });

  // "read" (not "write"/"exec") on purpose: the point is unattended delivery
  // while the user is away, so it must not block waiting for an approval we
  // can't grant remotely. The allowlist is the real boundary.
  pi.registerTool({
    name: "telegram_send",
    label: "Telegram send",
    description:
      "Send a message to the user via Telegram (the allowlisted chat). Use to report " +
      "progress or results while the user is away from the computer.",
    parameters: sendSchema,
    loadMode: "essential",
    approval: "read",
    async execute(_id, params, _onUpdate, _ctx, _signal) {
      const text = params.text?.trim();
      if (!text) {
        return {
          content: [{ type: "text", text: "telegram_send: `text` must be a non-empty string." }],
          isError: true,
        };
      }
      const chatId = params.chat_id?.trim() || cfg.allowed[0];
      if (!/^\d+$/.test(chatId)) {
        return {
          content: [{ type: "text", text: `telegram_send: chat_id must be numeric, got ${JSON.stringify(chatId)}.` }],
          isError: true,
        };
      }
      try {
        const id = await sendTelegramText(pi, chatId, text);
        return { content: [{ type: "text", text: `Delivered to Telegram chat ${chatId} (message_id=${id}).` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `telegram_send failed: ${errMsg(err)}` }],
          isError: true,
        };
      }
    },
  });
}
