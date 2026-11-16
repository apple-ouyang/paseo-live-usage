Live usage adds a composer pill and expandable detail popover showing real-time decode speed (tokens per second), time to first token (TTFT), phase timings (waiting, thinking, output, and tool execution), cache-hit rate, and session cost.

It reads each agent harness's own local session store incrementally (by byte offset, zstd frame, or SQLite row ID) instead of relying solely on Paseo's normalized usage events, which omit cache buckets and per-call timing breakdowns.

Supported harnesses:
- DeepSeek Harness (dsh): reads `~/.dsh/sessions` zstd logs and projection cache with per-chunk timestamps.
- Pi: reads `~/.pi/agent/sessions` and `statusline-samples.jsonl` for per-call TTFT, decode speed, and provider-reported cost.
- Claude Code: reads `~/.claude/projects` JSONL logs, deduplicating by message ID and reading `totalCostUSD` from `cost-state` entries.
- Codex: reads `~/.codex/sessions` and `~/.codex/archived_sessions` for measured thinking, output, and tool intervals.
- Devin CLI: reads `~/.local/share/devin/cli/sessions.db` for `total_time_ms`, `ttft_ms`, and tool call timings.
- Grok: reads `~/.grok/sessions` `events.jsonl` and `usage.json` for phase timings and `costUsdTicks`.
- Droid: reads `~/.factory/sessions` JSONL and settings files.
- Antigravity CLI (agy): reads `~/.gemini/antigravity-cli/conversations` SQLite databases for TTFT, streaming duration, and step timings.
- Fallback: uses Paseo `agent.lastUsage` for other providers (opencode, copilot, cursor, kimi).

No data leaves the machine; all files are read locally from the daemon host.
