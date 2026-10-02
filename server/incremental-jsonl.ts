/**
 * Append-only JSONL reader. Provider session files (pi, claude, codex) are
 * written line by line and can grow to tens of MB, so each poll reads only the
 * bytes appended since the previous call and keeps the trailing partial line.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

interface LineState {
  offset: number;
  /**
   * Undelivered tail bytes. Kept as a Buffer, not a string: the writer can
   * flush mid-line and mid-character, and a half-decoded UTF-8 sequence would
   * corrupt the line permanently (U+FFFD) instead of completing on the next
   * read.
   */
  pending: Buffer;
  size: number;
  mtimeMs: number;
}

const states = new Map<string, LineState>();

export function readAppendedJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }

  let state = states.get(path);
  if (!state || stat.size < state.offset) {
    state = { offset: 0, pending: Buffer.alloc(0), size: 0, mtimeMs: 0 };
    states.set(path, state);
  }
  if (state.size === stat.size && state.mtimeMs === stat.mtimeMs) return [];

  const length = stat.size - state.offset;
  const out: unknown[] = [];
  if (length > 0) {
    const buffer = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const read = readSync(fd, buffer, 0, length, state.offset);
      if (read > 0) {
        state.pending = Buffer.concat([state.pending, buffer.subarray(0, read)]);
        state.offset += read;
      }
    } catch {
      // leave the cursor alone so the next poll retries the same bytes
      return [];
    } finally {
      if (fd !== null) closeSync(fd);
    }

    // 0x0A never appears inside a UTF-8 multibyte sequence, so splitting on the
    // raw byte is safe; only complete lines are decoded.
    let newline = state.pending.indexOf(0x0a);
    while (newline >= 0) {
      const line = state.pending.subarray(0, newline).toString("utf8").trim();
      state.pending = state.pending.subarray(newline + 1);
      if (line.length > 0) {
        try {
          out.push(JSON.parse(line));
        } catch {
          // ignore malformed/half-written lines
        }
      }
      newline = state.pending.indexOf(0x0a);
    }
  }

  if (state.offset === stat.size) {
    // A short read leaves bytes unread; keep the old markers so the next poll
    // retries even if mtime has not moved again.
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
  }
  return out;
}
