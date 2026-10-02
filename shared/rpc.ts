import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const StepUsageSchema = z.object({
  /** dsh's own turn/step counters; null when the provider has no such counter. */
  turn: z.number().int().nullable(),
  step: z.number().int().nullable(),
  /** Output tokens for that call, reasoning included. */
  output: z.number(),
  reasoning: z.number(),
  /** Ordinary (uncached) prompt tokens. */
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /**
   * Wall time of the call: request anchor -> committed message. For claude the
   * anchor is the entry preceding the FIRST content block of the message;
   * for the others it is the previous countable entry.
   */
  stepMs: z.number().nullable(),
  tokensPerSecond: z.number().nullable(),
  /** cacheRead / (input + cacheRead + cacheWrite), percent. */
  hitPct: z.number().nullable(),
  /** Epoch ms of the call's committed message. */
  endedAt: z.number().nullable(),
});

const TotalsSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  /**
   * Σ reasoning tokens (a subset of `output`); absent when the provider's totals
   * store does not report it — the client then falls back to the last call.
   */
  reasoning: z.number().optional(),
  hitPct: z.number().nullable(),
});

const ContextSchema = z.object({
  used: z.number(),
  window: z.number(),
  pressure: z.number().nullable(),
});

/**
 * dsh's decode accounting, mirrored from `dsh-tui`'s trajectory aggregate: the
 * wait for the first streamed chunk is TTFT, the rest of the call is the decode
 * window, and tool execution sits outside both.
 */
const DecodeFields = {
  /** Σ output tokens over the calls. */
  output: z.number(),
  /** Σ (first chunk − step/start). */
  ttftMs: z.number(),
  /** Σ (message landed − first chunk). */
  decodeMs: z.number(),
  /** Calls that actually streamed, i.e. contributed TTFT and a decode span. */
  samples: z.number().int(),
  /** output ÷ decodeMs — dsh's "输出速度 (TPS)". */
  tokensPerSecond: z.number().nullable(),
  /** Σ reasoning-generation window; null when no call streamed thinking. */
  thinkMs: z.number().nullable(),
  /**
   * `decodeMs − thinkMs`: everything generated after the first token that is not
   * thinking — the reply plus the tool-call arguments. Null without think data.
   */
  outMs: z.number().nullable(),
};

const TurnSpeedSchema = z.object({
  ...DecodeFields,
  /** dsh's turn counter; null when the provider has no such counter. */
  turn: z.number().int().nullable(),
  /** TTFT + decode: the model-side wall clock. */
  modelMs: z.number(),
});

const SpeedTotalsSchema = z.object({
  ...DecodeFields,
  turns: z.number().int(),
  steps: z.number().int(),
  modelMs: z.number(),
  /** Tool wall clock, parallel batches counted once. */
  toolMs: z.number(),
  /** ttftMs ÷ samples — dsh's "首 token 平均 (TTFT)". */
  ttftAvgMs: z.number().nullable(),
});

const TimingSchema = z.object({
  totalMs: z.number(),
  toolMs: z.number(),
  requestMs: z.number(),
  otherMs: z.number(),
});

/** Cost exactly as the provider reports it; this plugin never derives one. */
const CostSchema = z.object({
  value: z.number(),
  currency: z.enum(["USD", "CNY"]),
});

const SupportedSchema = z.object({
  supported: z.literal(true),
  provider: z.string(),
  sessionId: z.string().nullable(),
  /** Which store the numbers came from. */
  source: z.enum([
    "dsh-log",
    "pi-session",
    "claude-session",
    "codex-session",
    "devin-db",
    "paseo-usage",
  ]),
  observedAt: z.number(),
  /** Age of the freshest backing file, ms (0 for the Paseo-usage fallback). */
  sourceAgeMs: z.number(),
  /** A model call is in flight right now. */
  inFlight: z.boolean(),
  last: StepUsageSchema.nullable(),
  totals: TotalsSchema.nullable(),
  context: ContextSchema.nullable(),
  cost: CostSchema.nullable(),
  timing: TimingSchema.nullable(),
  /**
   * dsh's own decode accounting. Present for dsh (its log timestamps every
   * streamed chunk); absent for providers whose store cannot group calls into
   * turns — the client then hides these rows instead of faking them.
   */
  turnSpeed: TurnSpeedSchema.nullable().optional(),
  speed: SpeedTotalsSchema.nullable().optional(),
});

const UnsupportedSchema = z.object({
  supported: z.literal(false),
  reason: z.string(),
});

const OutputSchema = z.discriminatedUnion("supported", [SupportedSchema, UnsupportedSchema]);

export const liveUsageGet = defineRpc({
  name: "live-usage.get",
  input: z.object({
    agentId: z.string().min(1),
    /** Client-known values; the daemon side resolves them when absent. */
    provider: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
  }),
  output: OutputSchema,
});

export type LiveUsageResult = z.infer<typeof OutputSchema>;
export type LiveUsageSupported = z.infer<typeof SupportedSchema>;
export type LiveUsageStep = z.infer<typeof StepUsageSchema>;
export type LiveUsageTotals = z.infer<typeof TotalsSchema>;
export type LiveUsageContext = z.infer<typeof ContextSchema>;
export type LiveUsageCost = z.infer<typeof CostSchema>;
export type LiveUsageTiming = z.infer<typeof TimingSchema>;
export type LiveUsageTurnSpeed = z.infer<typeof TurnSpeedSchema>;
export type LiveUsageSpeed = z.infer<typeof SpeedTotalsSchema>;
