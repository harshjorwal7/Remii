/**
 * Memory tunables, read from the environment with sane defaults.
 *
 * One place, so the recall gate, the write budgets and the sweeps cannot
 * drift into three different ideas of "too much". All optional: unset means
 * the human-scale defaults below, which suit one person's deployment and can
 * stay untouched.
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const memoryConfig = {
  /** Top-k facts injected when the recall gate fires. */
  recallTopK: intFromEnv("MEMORY_RECALL_TOP_K", 5),
  /** Fresh daemon/explicit saves allowed per user per UTC day. */
  dailySaveBudget: intFromEnv("MEMORY_DAILY_SAVE_BUDGET", 50),
  /** Rows older than this with no signal are sweep-eligible (days). */
  sweepAfterDays: intFromEnv("MEMORY_SWEEP_AFTER_DAYS", 90),
  /** Recall-hit retention for the events trail (days). */
  eventsRetentionDays: intFromEnv("MEMORY_EVENTS_RETENTION_DAYS", 90),
} as const;

/**
 * Default expiry by category, applied when a save names none.
 *
 * Working context rots fast ("preparing slides for Friday"); identity and
 * safety facts do not ("allergic to peanuts", "mother's name"). Null means
 * no expiry: the row lives until superseded, swept, or deleted by its owner.
 */
export const CATEGORY_EXPIRY_DAYS: Readonly<Record<string, number | null>> = {
  preference: null,
  identity: null,
  safety: null,
  relationship: null,
  work: 180,
  project: 180,
  task: 14,
  trip: 60,
  transient: 7,
};
