// Loads configuration from a .env file (simple KEY=VALUE, no shell execution)
// and process.env. Deliberately dependency-free.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // .env does not override a value already set in the real environment.
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(join(ROOT, ".env"));

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[config] missing required env var: ${key} (set it in .env)`);
    process.exit(1);
  }
  return v;
}

// Model alias map: friendly id (what Copilot sends) -> Salesforce sfdc_ai__ alias
// (what the Bedrock path expects). Only the routes verified to work on this org
// are enabled by default. Copilot may also send an sfdc_ai__ id directly, which
// passes through unchanged.
export const MODEL_MAP: Record<string, string> = {
  "claude-opus-4-8": "sfdc_ai__DefaultBedrockAnthropicClaude48Opus",
  "claude-opus-4-7": "sfdc_ai__DefaultBedrockAnthropicClaude47Opus",
  "claude-opus-4-6": "sfdc_ai__DefaultBedrockAnthropicClaude46Opus",
  "claude-sonnet-5": "sfdc_ai__DefaultBedrockAnthropicClaude5Sonnet",
  "claude-sonnet-4-6": "sfdc_ai__DefaultBedrockAnthropicClaude46Sonnet",
};

export function resolveModel(id: string): string {
  if (MODEL_MAP[id]) return MODEL_MAP[id];
  if (id.startsWith("sfdc_ai__")) return id; // pass-through for full aliases
  // Unknown id: default to the safest working model.
  return MODEL_MAP["claude-sonnet-5"];
}

// OpenAI/GPT model map: friendly id (what Copilot's OpenAI provider sends) ->
// Salesforce sfdc_ai__DefaultGPT* alias. These route through the Geo-aware
// /chat/generations endpoint, NOT the Bedrock invoke path. Copilot may also send
// an sfdc_ai__DefaultGPT* id directly, which passes through unchanged.
export const GPT_MODEL_MAP: Record<string, string> = {
  "gpt-5.6-luna": "sfdc_ai__DefaultGPT56Luna",
  "gpt-5.6-sol": "sfdc_ai__DefaultGPT56Sol",
  "gpt-5.6-terra": "sfdc_ai__DefaultGPT56Terra",
  "gpt-5.5": "sfdc_ai__DefaultGPT55",
  "gpt-5.4": "sfdc_ai__DefaultGPT54",
  "gpt-5.2": "sfdc_ai__DefaultGPT52",
  "gpt-5.1": "sfdc_ai__DefaultGPT51",
  "gpt-5": "sfdc_ai__DefaultGPT5",
};

export function resolveGptModel(id: string): string {
  if (GPT_MODEL_MAP[id]) return GPT_MODEL_MAP[id];
  if (id.startsWith("sfdc_ai__")) return id; // pass-through for full aliases
  // Unknown id: default to the latest general GPT model.
  return GPT_MODEL_MAP["gpt-5.4"];
}

export const config = {
  instanceUrl: required("SF_INSTANCE_URL"),
  clientId: required("SF_CLIENT_ID"),
  clientSecret: required("SF_CLIENT_SECRET"),
  modelsBaseUrl:
    process.env.SF_MODELS_BASE_URL?.replace(/\/+$/, "") ||
    "https://api.salesforce.com/ai/gpt/v1",
  featureId: process.env.SF_FEATURE_ID || "ai-platform-models-connected-app",
  appContext: process.env.SF_APP_CONTEXT || "EinsteinGPT",
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  // Local shared secret Copilot must send as the API key. Optional but
  // recommended so nothing else on the machine can use your Salesforce quota.
  proxyKey: process.env.PROXY_API_KEY || "",
  // The Salesforce Bedrock backend rejects Sonnet/Opus requests carrying a
  // `thinking` block (502 "No user context has been created"). Strip it by
  // default; set STRIP_THINKING=0 only if the backend later supports it.
  stripThinking: process.env.STRIP_THINKING !== "0",
} as const;
