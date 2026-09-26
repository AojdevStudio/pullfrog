import { autoSelectModel } from "../agents/opencodeShared.ts";
import {
  getModelEnvVars,
  getModelProvider,
  getProviderGatewayUrl,
  modelAliases,
  stripProviderPrefix,
} from "../models.ts";
import * as yes from "../yes/index.ts";
import { resolveAgent } from "./agent.ts";
import { apiFetch } from "./apiFetch.ts";
import { log } from "./cli.ts";
import { clearInstalledSubscription, installCodexAuth, installXaiAuth } from "./codexHome.ts";
import { sanitizeSecret } from "./normalizeEnv.ts";
import type { RunContextData } from "./runContextData.ts";
import { maskSecret, saveSecretState } from "./secretCommands.ts";
import {
  type CredentialAccess,
  type CredentialCandidate,
  selectedCredentialSchema,
  subscriptionNameSchema,
} from "./subscriptionCredentials.ts";
import { probeInference, probeSubscription } from "./subscriptionProbe.ts";

const receipts: Record<string, string> = {};
const workflowCredentials: Record<string, string> = {};

function saveReceipts() {
  for (const receipt of Object.values(receipts)) maskSecret(receipt);
  saveSecretState("credential_receipts", JSON.stringify(receipts));
}

const select = yes.op(
  async (input: { access: CredentialAccess; candidate: CredentialCandidate }) => {
    const response = await apiFetch({
      path: "/api/runtime/credentials",
      method: "POST",
      headers: {
        authorization: `Bearer ${input.access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: input.candidate.id }),
      signal: AbortSignal.timeout(35_000),
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error("could not load a configured credential; no fallback was charged", {
        cause: response.status,
      });
    return selectedCredentialSchema.parse(await response.json());
  },
  {
    retries: [250, 1000],
    bail: (error) =>
      error instanceof Error &&
      typeof error.cause === "number" &&
      error.cause >= 400 &&
      error.cause < 500,
  }
);

function subscriptionForModel(model: string) {
  if (!model.includes("/")) return null;
  const provider = getModelProvider(model);
  return provider === "anthropic"
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : provider === "openai"
      ? "CODEX_AUTH_JSON"
      : provider === "xai"
        ? "GROK_AUTH_JSON"
        : null;
}

/** load one subscription per provider for model discovery; keep the pool unflattened. */
export async function initializeCredentialPool(ctx: RunContextData, model?: string) {
  const access = ctx.credentialAccess;
  if (!access) return;
  maskSecret(access.token);
  const names = new Set([
    ...access.candidates.map((candidate) => candidate.name),
    ...subscriptionNameSchema.options,
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
  ]);
  for (const name of names) {
    const value = process.env[name];
    if (value) workflowCredentials[name] = value;
  }
  for (const name of subscriptionNameSchema.options) {
    if (model && subscriptionForModel(model) !== name) continue;
    if (workflowCredentials[name]) continue;
    const candidate = access.candidates.find((item) => item.name === name);
    if (!candidate) continue;
    const selected = await select({ access, candidate }).catch(() => {
      log.warning(`» could not load ${name} for model discovery; selection will retry if needed`);
      return null;
    });
    if (!selected) continue;
    const value = sanitizeSecret(name, selected.value);
    if (!value) continue;
    process.env[name] = value;
    receipts[name] = selected.receipt;
  }
  saveReceipts();
}

export function resolvePoolModel(input: { codexAgent: boolean }) {
  const agent = resolveAgent({
    model: undefined,
    proxyModel: undefined,
    codexAgent: input.codexAgent,
  });
  if (agent.name === "opencode") return autoSelectModel();
  const provider = agent.name === "claude" ? "anthropic" : "openai";
  return modelAliases.find(
    (alias) =>
      alias.provider === provider &&
      alias.preferred &&
      !alias.hidden &&
      !alias.fallback &&
      !alias.routing
  )?.resolve;
}

export async function selectConfiguredCredential(input: {
  ctx: RunContextData;
  model: string | undefined;
}) {
  const access = input.ctx.credentialAccess;
  const model = input.model;
  if (!access || !model?.includes("/") || getProviderGatewayUrl(model)) return false;
  const subscription = subscriptionForModel(model);
  const names = getModelEnvVars(model).filter((name) => name !== subscription);
  if (subscription) names.unshift(subscription);
  const candidates = access.candidates.filter((candidate) => names.includes(candidate.name));
  const workflow = names.filter((name) => workflowCredentials[name]);
  if (!candidates.length && !workflow.length) return false;
  for (const name of workflow) {
    const value = workflowCredentials[name];
    if (await usable({ name, value, model })) {
      activate({ names, name, value, receipt: undefined });
      return true;
    }
  }
  for (const candidate of candidates) {
    const selected = await select({ access, candidate });
    if (!selected) continue;
    if (await usable({ ...selected, model })) {
      activate({ names, ...selected });
      log.info(`» selected ${candidate.name} from ${candidate.source} scope`);
      return true;
    }
    log.info(
      `» ${candidate.name} from ${candidate.source} scope unavailable; trying the next credential`
    );
  }
  throw new Error(
    `all configured credentials for ${model} were rejected or exhausted; no other model or provider was selected`
  );
}

async function usable(input: { name: string; value: string; model: string }) {
  const subscription = subscriptionNameSchema.safeParse(input.name);
  if (subscription.success)
    return (
      (await probeSubscription({
        name: subscription.data,
        value: input.value,
        model: stripProviderPrefix(input.model),
      })) !== "rejected"
    );
  return (
    (await probeInference({ ...input, model: stripProviderPrefix(input.model) })) !== "rejected"
  );
}

function activate(input: {
  names: string[];
  name: string;
  value: string;
  receipt: string | undefined;
}) {
  for (const name of input.names) {
    delete process.env[name];
    delete receipts[name];
    if (name === "CODEX_AUTH_JSON" || name === "GROK_AUTH_JSON") clearInstalledSubscription(name);
  }
  const value = sanitizeSecret(input.name, input.value);
  if (!value) throw new Error("configured credential was empty");
  process.env[input.name] = value;
  if (input.receipt) receipts[input.name] = input.receipt;
  installCodexAuth();
  installXaiAuth();
  saveReceipts();
}
