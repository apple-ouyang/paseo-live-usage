/**
 * A real droid session tree in a throwaway HOME, for the tests.
 *
 * droid appends one `{type:"message", timestamp, message:{role, content[]}}`
 * record per line under `~/.factory/sessions/<encoded-cwd>/<sid>.jsonl`, and
 * rewrites `<sid>.settings.json` after every call with cumulative
 * `tokenUsage` / `inclusiveTokenUsage` and `lastCallTokenUsage`. Writing the
 * files exactly like the CLI does exercises the real parser end to end.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fixed epoch so every assertion can be an exact number. */
export const T0 = 1_790_000_000_000;

function at(ms: number): string {
  return new Date(ms).toISOString();
}

export interface DroidTokenUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
  factoryCredits?: number;
}

export function newDroidSession(sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") {
  const home = mkdtempSync(join(tmpdir(), "live-usage-droid-"));
  const dir = join(home, ".factory", "sessions", "-tmp-work");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];

  /** Record id of the last prompt/taskCompletion — the turnId outcomes carry. */
  let lastPromptId = "";
  /** Records chain through `parentId`, like droid writes them. */
  let lastRecordId: string | undefined;
  const message = (
    ms: number,
    body: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    parent?: string,
  ) => {
    const id = (extra.id as string | undefined) ?? `m-${lines.length}`;
    const parentId = parent ?? lastRecordId;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        ...(parentId !== undefined ? { parentId } : {}),
        timestamp: at(ms),
        message: body,
        ...extra,
      }),
    );
    lastRecordId = id;
    return id;
  };

  return {
    home,
    sessionId,
    path,
    lines,
    /** A real user prompt: plain text with `interactionMode`, no visibility. */
    prompt(ms: number, text = "do the thing", id = `turn-${ms}`) {
      lastPromptId = message(ms, {
        role: "user",
        content: [{ type: "text", text }],
        interactionMode: "auto",
      }, { id });
      return lastPromptId;
    },
    /** `task-completion:*` wake-ups are `llm_only` but still open a real turn. */
    taskCompletion(ms: number, id = `task-completion:${ms}`) {
      lastPromptId = message(
        ms,
        {
          role: "user",
          content: [{ type: "text", text: "# Task Tool Invocation\nSubagent type: worker" }],
          visibility: "llm_only",
          interactionMode: "auto",
        },
        { id },
      );
      return lastPromptId;
    },
    /** Error notices (`BYOK Error:`, timeouts) never reach the model. */
    errorNotice(ms: number) {
      message(ms, {
        role: "user",
        content: [{ type: "text", text: "BYOK Error: Factory: connection lost mid-reply" }],
        visibility: "user_only",
      });
    },
    /** `<system-reminder>` injections are `llm_only` bookkeeping. */
    reminder(ms: number) {
      message(ms, {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>note</system-reminder>" }],
        visibility: "llm_only",
      });
    },
    /** Injected context blocks arrive as ordinary user records starting with "<". */
    contextBlock(ms: number) {
      message(ms, {
        role: "user",
        content: [{ type: "text", text: "<chat-history-summary>\nold chat\n" }],
      });
    },
    /** Hook firings carry `hookEventName` and empty content. */
    hook(ms: number) {
      message(ms, {
        role: "user",
        content: [],
        visibility: "user_only",
        hookEventName: "SessionStart",
      });
    },
    assistant(
      ms: number,
      parts: Record<string, unknown>[] = [{ type: "text", text: "done" }],
      parent?: string,
    ) {
      return message(ms, { role: "assistant", content: parts }, {}, parent);
    },
    toolCall(ms: number, id = "toolu_1", parent?: string) {
      return message(
        ms,
        { role: "assistant", content: [{ type: "tool_use", id, name: "Execute", input: {} }] },
        {},
        parent,
      );
    },
    toolResult(ms: number, id = "toolu_1", parent?: string) {
      return message(
        ms,
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" }],
        },
        {},
        parent,
      );
    },
    /** `turnId` is the record id of the message that opened the turn. */
    turnOutcome(ms: number, turnId?: string) {
      lines.push(
        JSON.stringify({
          type: "agent_turn_outcome",
          turnId: turnId ?? lastPromptId,
          reason: "completed",
          resultKind: "text",
        }),
      );
    },
    todo(ms: number) {
      lines.push(JSON.stringify({ type: "todo_state", timestamp: at(ms), items: [] }));
    },
    /** Rewrite `<sid>.settings.json` the way droid does after each call. */
    settings(input: {
      tokenUsage?: DroidTokenUsageInput;
      inclusiveTokenUsage?: DroidTokenUsageInput;
      lastCallTokenUsage?: DroidTokenUsageInput;
    }) {
      writeFileSync(join(dir, `${sessionId}.settings.json`), JSON.stringify(input));
    },
    settingsBak(input: Record<string, unknown>) {
      writeFileSync(join(dir, `${sessionId}.settings.json.bak`), JSON.stringify(input));
    },
    write() {
      writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
      lines.length = 0;
    },
    /** Append is how the CLI grows the file; the reader must pick up new bytes. */
    append() {
      appendFileSync(path, `${lines.join("\n")}\n`);
      lines.length = 0;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
