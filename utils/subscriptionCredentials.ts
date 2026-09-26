import { z } from "zod";

export const subscriptionNameSchema = z.enum([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_AUTH_JSON",
  "GROK_AUTH_JSON",
]);
export type SubscriptionName = z.infer<typeof subscriptionNameSchema>;

export const subscriptionSchema = z.object({
  id: z.string(),
  credentialId: z.string(),
  name: subscriptionNameSchema,
  label: z.string(),
  owner: z.string(),
  inherited: z.boolean(),
  shared: z.boolean(),
  registeredAt: z.string(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const subscriptionListSchema = z.object({
  subscriptions: z.array(subscriptionSchema),
  writable: z.boolean(),
});

export const subscriptionInputSchema = z.object({
  name: subscriptionNameSchema,
  value: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 49152),
  replaceId: z.string().optional(),
});

export const credentialCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.enum(["repo", "account", "personal"]),
});
export type CredentialCandidate = z.infer<typeof credentialCandidateSchema>;
export const credentialAccessSchema = z.object({
  token: z.string(),
  candidates: z.array(credentialCandidateSchema),
});
export type CredentialAccess = z.infer<typeof credentialAccessSchema>;

export const selectedCredentialSchema = z.object({
  name: z.string(),
  value: z.string(),
  receipt: z.string(),
});

export function subscriptionLabel(input: { email: string | null; suffix: string }) {
  return input.email ?? `•••• ${input.suffix}`;
}
