import { z } from "zod";
import { preflightClaudeSubscription } from "./claudeSubscription.ts";
import { parseCodexAuthBody } from "./codexOAuth.ts";
import { verifyCredential } from "./credentialCheck.ts";
import type { SubscriptionName } from "./subscriptionCredentials.ts";
import { parseXaiAuthBody } from "./xaiOAuth.ts";

const identitySchema = z.object({
  email: z.string().email().optional(),
  sub: z.string().optional(),
  user_id: z.string().optional(),
  account_id: z.string().optional(),
  email_verified: z.boolean().optional(),
});
const codexUsageSchema = z.object({
  rate_limit: z.object({ allowed: z.boolean(), limit_reached: z.boolean() }).optional(),
});

export class SubscriptionCredentialError extends Error {}

export async function subscriptionIdentity(input: { name: SubscriptionName; value: string }) {
  const empty = { email: null, subject: null };
  if (input.name === "CLAUDE_CODE_OAUTH_TOKEN") return empty;
  const codex = input.name === "CODEX_AUTH_JSON" ? parseCodexAuthBody(input.value) : null;
  const grok = input.name === "GROK_AUTH_JSON" ? parseXaiAuthBody(input.value) : null;
  const token = codex?.tokens.access_token ?? grok?.tokens.access_token;
  if (!token) throw new SubscriptionCredentialError("invalid subscription credential");
  const response = await readSubscriptionEndpoint({
    url: codex ? "https://chatgpt.com/backend-api/wham/usage" : "https://auth.x.ai/oauth2/userinfo",
    token,
    accountId: codex?.tokens.account_id,
  });
  if (response?.status === 401)
    throw new SubscriptionCredentialError("subscription credential was rejected");
  if (!response?.ok) return empty;
  const parsed = identitySchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return empty;
  const subject = parsed.data.sub ?? parsed.data.user_id;
  return {
    email: parsed.data.email_verified === false ? null : (parsed.data.email ?? null),
    subject: subject ? `${subject}:${parsed.data.account_id ?? ""}` : null,
  };
}

async function readSubscriptionEndpoint(input: {
  url: string;
  token: string;
  accountId?: string | undefined;
  grokBilling?: boolean;
}) {
  const headers = new Headers({ authorization: `Bearer ${input.token}` });
  if (input.accountId) headers.set("ChatGPT-Account-Id", input.accountId);
  if (input.grokBilling) headers.set("x-xai-token-auth", "xai-grok-cli");
  return fetch(input.url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
}

/** unknown quota is not a reason to skip a credential or change who pays. */
export async function probeSubscription(input: {
  name: SubscriptionName;
  value: string;
  model?: string | undefined;
}): Promise<"usable" | "rejected" | "unknown"> {
  if (input.name === "CLAUDE_CODE_OAUTH_TOKEN") {
    const result = await preflightClaudeSubscription({ token: input.value, model: input.model });
    return result.usable ? "usable" : "rejected";
  }
  const codex = input.name === "CODEX_AUTH_JSON" ? parseCodexAuthBody(input.value) : null;
  const grok = input.name === "GROK_AUTH_JSON" ? parseXaiAuthBody(input.value) : null;
  const auth = codex ?? grok;
  if (!auth || auth.refresh_rejected_at) return "rejected";
  if (grok && input.model)
    return probeInference({
      name: "XAI_API_KEY",
      value: grok.tokens.access_token,
      model: input.model,
    });
  const response = await readSubscriptionEndpoint({
    url: codex
      ? "https://chatgpt.com/backend-api/wham/usage"
      : "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    token: auth.tokens.access_token,
    accountId: codex?.tokens.account_id,
    grokBilling: !!grok,
  });
  if (response?.status === 401) return "rejected";
  if (!response?.ok) return "unknown";
  const body: unknown = await response.json().catch(() => null);
  if (codex) {
    const parsed = codexUsageSchema.safeParse(body);
    const limit = parsed.success ? parsed.data.rate_limit : undefined;
    if (!limit) return "unknown";
    return limit.allowed && !limit.limit_reached ? "usable" : "rejected";
  }
  // billing balance is not the subscription's remaining allowance.
  return "unknown";
}

/** probe the chosen model, not a models-list permission a restricted key may lack. */
export async function probeInference(input: {
  name: string;
  value: string;
  model: string;
}): Promise<"usable" | "rejected" | "unknown"> {
  const anthropic = input.name === "ANTHROPIC_API_KEY";
  const openai = input.name === "OPENAI_API_KEY";
  if (!anthropic && !openai && input.name !== "XAI_API_KEY") {
    const result = await verifyCredential({ envVar: input.name, value: input.value });
    return result === "dead" ? "rejected" : result === "alive" ? "usable" : "unknown";
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (anthropic) {
    headers.set("x-api-key", input.value);
    headers.set("anthropic-version", "2023-06-01");
  } else headers.set("authorization", `Bearer ${input.value}`);
  const response = await fetch(
    anthropic
      ? "https://api.anthropic.com/v1/messages"
      : openai
        ? "https://api.openai.com/v1/responses"
        : "https://api.x.ai/v1/chat/completions",
    {
      method: "POST",
      headers,
      body: JSON.stringify(
        openai
          ? { model: input.model, input: "Reply OK.", max_output_tokens: 16, store: false }
          : {
              model: input.model,
              messages: [{ role: "user", content: "Reply OK." }],
              max_tokens: 1,
            }
      ),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }
  ).catch(() => null);
  if (response?.status === 400 && input.name === "XAI_API_KEY") {
    const error = z
      .object({ error: z.string() })
      .safeParse(await response.json().catch(() => null));
    return error.success && error.data.error.startsWith("Incorrect API key provided.")
      ? "rejected"
      : "unknown";
  }
  await response?.body?.cancel();
  if (!response) return "unknown";
  if (response.ok) return "usable";
  return [401, 402, 403, 429].includes(response.status) ? "rejected" : "unknown";
}
