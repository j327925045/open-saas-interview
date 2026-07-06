// AI Cost & Abuse Control Constants

// Rate limits: N requests per time window
export const RATE_LIMIT = {
  FREE_REQUESTS_PER_HOUR: 5,
  SUBSCRIBED_REQUESTS_PER_HOUR: 60,
  WINDOW_MS: 60 * 60 * 1000, // 1 hour
} as const;

// Quota limits
export const QUOTA = {
  FREE_DAILY_TOKENS: 10_000,
  SUBSCRIBED_DAILY_TOKENS: 100_000,
  FREE_MONTHLY_TOKENS: 100_000,
  SUBSCRIBED_MONTHLY_TOKENS: 2_000_000,
} as const;

// Pricing (per 1K tokens)
export const PRICING = {
  GPT_35_TURBO_INPUT: 0.0015,   // $ per 1K input tokens
  GPT_35_TURBO_OUTPUT: 0.002,   // $ per 1K output tokens
} as const;

// Concurrency
export const CONCURRENCY = {
  LOCK_TTL_MS: 30_000, // max 30s per AI operation
} as const;

// Idempotency
export const IDEMPOTENCY = {
  KEY_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// Subscription statuses that get unlimited/relaxed access
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "cancel_at_period_end"];
