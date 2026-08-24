import { z } from "zod";

export const tierLimitSchema = z.object({
  requestsPerMinute: z.number().int().positive(),
  tokensPerMinute: z.number().int().positive(),
});

export type TierLimit = z.infer<typeof tierLimitSchema>;

export const tierLimitsSchema = z.record(
  z.enum(["free", "pro", "enterprise"]),
  tierLimitSchema,
);

export const DEFAULT_TIER_LIMITS = {
  free: { requestsPerMinute: 20, tokensPerMinute: 100_000 },
  pro: { requestsPerMinute: 600, tokensPerMinute: 2_000_000 },
  enterprise: { requestsPerMinute: 6_000, tokensPerMinute: 20_000_000 },
} as const satisfies z.infer<typeof tierLimitsSchema>;
