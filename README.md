# omp-tg-plugin

A Telegram channel for [OMP](https://github.com/can1357/oh-my-pi) in **a single file, with no dependencies and no MCP**.

## What it is

A micro plugin (OMP extension) that runs inside the OMP runtime itself and does two things:

- **Inbound (you → agent).** Long-polls the bot's `getUpdates`. A message
  from an allowlisted user is injected into the session as a regular user
  prompt. It is a native steer: if the agent is working on a task, your
  Telegram message **interrupts it** (pure waits are cut instantly,
  everything else at the next step boundary) and redirects it to your
  instruction. That's how "I'm stepping away, then I'll tell it something
  from my phone — and it does it" works.
- **Outbound (agent → you).** Registers a `telegram_send` tool so the agent
  can deliver progress and results to your phone. When a request comes in
  from Telegram, each prompt is tagged — the agent replies back there via
  `telegram_send`.

## When it's useful

Long-running task, and you need to step away. End your prompt with something like:

```
I'm stepping away. Mirror progress and the result to Telegram.
```

From there the agent:
- sends a short update after each completed stage,
- warns before irreversible actions (push/deploy/deletion),
- sends a final summary with how to verify.

Your Telegram messages at any moment = instructions (redirect, stop, answer
to a question). All of this behavior is described in `RULES.md` (see
"away-mode rules" below) — create it if you don't have one.

## Requirements

- OMP (verified on 18.x). Bun is not needed — the extension is loaded by OMP's native bun import.
- A Telegram bot: token from [@BotFather](https://t.me/BotFather).
- Your Telegram user id (get it from [@userinfobot](https://t.me/userinfobot)).

## Installation

```bash
# 1. drop the file into OMP's extensions dir
ln -s "$PWD/extension/index.ts" ~/.omp/agent/extensions/telegram-bridge.ts

# 2. config (token + allowlist)
cat > ~/.omp/agent/telegram-bridge.json <<'EOF'
{
  "token": "<BOT_TOKEN>",
  "allowed_user_ids": [123456789]
}
EOF
chmod 600 ~/.omp/agent/telegram-bridge.json
```

**3. Restart OMP** (extensions load at session start). The log
`~/.omp/logs/omp.*.log` should contain:

```
[telegram-bridge] loaded; allowlist=[...]
[telegram-bridge] polling started (inbound -> session)
```

**4. Verify.** DM the bot anything from your phone — your message shows up
in the OMP session as a user prompt. In the same session, ask:

```
Send me "bridge works" on Telegram
```

### Copy instead of symlink

Simply copy `extension/index.ts` to `~/.omp/agent/extensions/telegram-bridge.ts`.
The plugin looks for its config where OMP keeps its agent dir:
`$PI_CODING_AGENT_DIR`, otherwise `~/.omp/agent`. No hardcoded paths.

## Configuration

| Where | What |
|---|---|
| `TELEGRAM_BOT_TOKEN` (env) | overrides `token` from the json |
| `token` in the json | the bot token |
| `allowed_user_ids` | strict allowlist of Telegram user ids (numbers or strings). **Only** these ids can message the agent. |

State (`telegram-bridge.state.json`) is internal: the `update_id` offset and
a dedupe window so old messages aren't re-injected after an OMP restart.
Delete it freely — it will be recreated.

## How it works

```
You (Telegram) ──► api.telegram.org ──► getUpdates long-poll (loop inside OMP)
                                            │
                                            ▼ allowlist + dedupe
                                pi.sendUserMessage(prompt)
                                            │
                                            ▼  idle → new turn
                                               streaming → steer (interrupts)
telegram_send tool ──► sendMessage ──► Telegram (agent → you)
```

Why no MCP: every long-poll is a separate `fetch`, so a network drop is a
new iteration, not a dead poller (that's exactly what kills MCP wrappers).
One process, one call chain, everything visible in the OMP log.

## Known limits

- **In-process**: the plugin dies with OMP. If the process dies or the laptop
  sleeps, nothing gets delivered to or from you via Telegram.
- **Text only**: media and reactions from Telegram are ignored (text + chat tag).
- **Not an alarm**: messages arrive only while the OMP session is alive.
- **Privacy**: `allowed_user_ids` is the only boundary — don't add ids you
  don't trust. The `[Telegram @name]` preview is part of the message text,
  so trust only allowlisted senders.

## away-mode rules (example for `~/.omp/agent/RULES.md`)

Add this to your RULES.md (or a local one) so the agent knows what to do
when you're away:

```markdown
# Telegram away-mode
When the user says they are stepping away ("I'm leaving, send the result to Telegram"):
- after each completed stage — a short report via telegram_send (what's done / what's next),
- before an irreversible action (push, deploy, deletion, migration) — a heads-up,
- at the end of the task — a final summary: what changed and how to verify,
- NEVER use the local ask tool: a question goes to Telegram together with the
  default you will take,
- a message from Telegram (prefix [Telegram ...]) = an instruction, just like in the terminal.
```

## License

MIT.
