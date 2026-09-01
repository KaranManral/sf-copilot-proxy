// Local proxy: GitHub Copilot (native Anthropic Messages API) <-> Salesforce
// Models API (Bedrock invoke shape + auto-refreshed OrgJWT).
//
// Copilot's Custom Endpoint sends:  POST /v1/messages  with body {model, messages, ...}
// Salesforce expects:               POST /model/<alias>/invoke[-with-response-stream]
//                                   with body {anthropic_version:"bedrock-2023-05-31", ...}
//                                   and header Authorization: Bearer <OrgJWT>.
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { config, resolveModel, resolveGptModel, MODEL_MAP, GPT_MODEL_MAP } from "./config.ts";
import { TokenProvider } from "./token.ts";
import { EventStreamDecoder, extractAnthropicEvent } from "./eventstream.ts";
import {
  toGenerationsBody,
  toOpenAICompletion,
  SseBlockParser,
  sfBlockToOpenAIDelta,
  isSfDone,
  openAIChunk,
} from "./openai.ts";

const tokens = new TokenProvider(config.instanceUrl, config.clientId, config.clientSecret);

const BEDROCK_VERSION = "bedrock-2023-05-31";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// This org's Bedrock backend rejects `thinking`/`redacted_thinking` content
// blocks with a 502 "No user context has been created!". Copilot echoes those
// blocks back inside the assistant turns of the message history on every
// follow-up, so turn 2+ of any conversation fails. Strip them from history
// while preserving text/tool_use/tool_result, and drop any message left empty.
function stripThinkingFromMessages(messages: any): any {
  if (!Array.isArray(messages)) return messages;
  const out: any[] = [];
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const content = msg.content.filter(
      (b: any) => !b || (b.type !== "thinking" && b.type !== "redacted_thinking"),
    );
    // Drop a message whose content became empty only if it had blocks to begin
    // with (i.e. it was thinking-only); never drop an already-empty message.
    if (content.length === 0 && msg.content.length > 0) continue;
    out.push({ ...msg, content });
  }
  return out;
}

// Build the Salesforce body from the incoming native Anthropic body.
function toBedrockBody(incoming: any): { body: any; stream: boolean } {
  const stream = incoming.stream === true;
  const body: any = { ...incoming };
  delete body.model; // model goes in the URL for Bedrock
  delete body.stream; // implied by the endpoint chosen
  body.anthropic_version = BEDROCK_VERSION;
  if (config.stripThinking) {
    delete body.thinking;
    body.messages = stripThinkingFromMessages(body.messages);
  }
  return { body, stream };
}

function sfHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-client-feature-id": config.featureId,
    "x-sfdc-app-context": config.appContext,
  };
}

function authorized(req: IncomingMessage): boolean {
  if (!config.proxyKey) return true; // no local key configured
  const auth = req.headers["authorization"];
  const xkey = req.headers["x-api-key"];
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";
  return bearer === config.proxyKey || xkey === config.proxyKey;
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let incoming: any;
  try {
    incoming = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON body" } });
  }

  const requestedModel = String(incoming.model || "");
  const alias = resolveModel(requestedModel);
  const { body, stream } = toBedrockBody(incoming);
  console.log(
    `[req] /v1/messages model=${requestedModel} -> ${alias} stream=${stream} msgs=${Array.isArray(incoming.messages) ? incoming.messages.length : 0}`,
  );
  const token = await tokens.get();
  const path = stream ? "invoke-with-response-stream" : "invoke";
  const url = `${config.modelsBaseUrl}/model/${alias}/${path}`;

  const upstream = await fetch(url, {
    method: "POST",
    headers: sfHeaders(token),
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    console.error(`[proxy] upstream ${upstream.status} for ${alias}: ${text.slice(0, 200)}`);
    return sendJson(res, upstream.status, {
      type: "error",
      error: {
        type: "api_error",
        message: `Salesforce Models API ${upstream.status}: ${text.slice(0, 500)}`,
      },
    });
  }

  if (!stream) {
    // Non-stream: Bedrock invoke returns a single Anthropic message JSON.
    const json = await upstream.json();
    return sendJson(res, 200, json);
  }

  // Guard: a 200 streaming response is expected to be a binary AWS event-stream.
  // Under load Salesforce/Bedrock can instead return 200 with a JSON (or text)
  // error body. The binary decoder would find no frames and emit nothing -> the
  // client sees an empty stream ("no choices"). Detect that up front.
  const upstreamCt = upstream.headers.get("content-type") || "";
  if (!/eventstream|event-stream|octet-stream/i.test(upstreamCt)) {
    const text = await upstream.text().catch(() => "");
    console.error(
      `[proxy] stream got non-eventstream 200 for ${alias} (content-type="${upstreamCt}"): ${text.slice(0, 500)}`,
    );
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: error\n`);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `Salesforce Models API returned a non-stream 200 (${upstreamCt}): ${text.slice(0, 500)}` } })}\n\n`,
    );
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    return res.end();
  }

  // Stream: translate AWS event-stream frames -> Anthropic SSE.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const decoder = new EventStreamDecoder();
  const reader = upstream.body!.getReader();
  let rawBytes = 0;
  let frameCount = 0;

  const writeEvent = (evt: any) => {
    if (evt && typeof evt.type === "string") {
      res.write(`event: ${evt.type}\n`);
    }
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // Emit a well-formed Anthropic SSE error + terminator so the client gets a
  // coherent signal instead of a truncated stream ("Response contained no
  // choices"). Bedrock surfaces mid-stream failures (throttling, timeouts,
  // internal errors) as event-stream *exception* frames that carry no Anthropic
  // `type`, which would otherwise pass through as an opaque, unusable frame.
  const writeErrorAndClose = (message: string) => {
    writeEvent({ type: "error", error: { type: "api_error", message } });
    res.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  };

  let sawContent = false;
  let errored = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) rawBytes += value.length;
      for (const msg of decoder.push(Buffer.from(value))) {
        frameCount++;
        const msgType = msg.headers[":message-type"];
        // Bedrock exception/error frames: log the real reason and surface it.
        if (msgType === "exception" || msgType === "error") {
          const excType =
            msg.headers[":exception-type"] || msg.headers[":error-code"] || "unknown";
          const payload = msg.payload.toString("utf8").slice(0, 500);
          console.error(
            `[proxy] stream exception for ${alias}: ${excType} :: ${payload}`,
          );
          errored = true;
          writeErrorAndClose(`Salesforce Models API stream ${excType}: ${payload}`);
          continue;
        }
        const evt = extractAnthropicEvent(msg);
        if (!evt) continue;
        // An error payload can also arrive without an exception header.
        if (evt.type === "error" || evt.error) {
          console.error(
            `[proxy] stream error frame for ${alias}: ${JSON.stringify(evt).slice(0, 500)}`,
          );
          errored = true;
        }
        if (evt.type === "content_block_delta" || evt.type === "content_block_start") {
          sawContent = true;
        }
        writeEvent(evt);
      }
    }
    // A 200 stream that produced no content and no error is the silent
    // "no choices" case — log it so it is no longer invisible.
    if (!sawContent && !errored) {
      console.error(
        `[proxy] stream for ${alias} ended with no content blocks (empty response); rawBytes=${rawBytes} frames=${frameCount}`,
      );
      writeErrorAndClose("Salesforce Models API returned an empty stream (no content)");
    } else {
      console.log(`[req] stream done for ${alias}: content=${sawContent} frames=${frameCount} bytes=${rawBytes}`);
    }
  } catch (err) {
    console.error("[proxy] stream error:", err);
    if (!res.writableEnded) writeErrorAndClose(String((err as any)?.message || err));
  } finally {
    res.end();
  }
}

// OpenAI Chat Completions -> Salesforce /chat/generations (GPT models).
async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let incoming: any;
  try {
    incoming = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { type: "invalid_request_error", message: "invalid JSON body" } });
  }

  const requestedModel = String(incoming.model || "");
  const alias = resolveGptModel(requestedModel);
  const stream = incoming.stream === true;
  console.log(
    `[req] /v1/chat/completions model=${requestedModel} -> ${alias} stream=${stream} msgs=${Array.isArray(incoming.messages) ? incoming.messages.length : 0}`,
  );
  // A Claude/Anthropic model arriving here means Copilot registered it under the
  // wrong API type (OpenAI instead of Anthropic). /chat/generations only serves
  // GPT; a Claude alias would 400 or silently misbehave. Fail loudly instead.
  if (/claude|anthropic/i.test(requestedModel)) {
    console.error(
      `[proxy] REJECT: Anthropic model "${requestedModel}" sent to the OpenAI endpoint. In Copilot, register this model under the Anthropic Messages API type (it uses /v1/messages), not OpenAI.`,
    );
    return sendJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: `Model "${requestedModel}" is a Claude/Anthropic model and must use the Anthropic Messages API (/v1/messages), not the OpenAI Chat Completions endpoint. In Copilot's model settings, add this model with API type "Anthropic", not "OpenAI".`,
      },
    });
  }
  const body = toGenerationsBody(incoming, alias);
  const token = await tokens.get();
  const path = stream ? "chat/generations/stream" : "chat/generations";
  const url = `${config.modelsBaseUrl}/${path}`;

  const upstream = await fetch(url, {
    method: "POST",
    headers: sfHeaders(token),
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    console.error(`[proxy] gpt upstream ${upstream.status} for ${alias}: ${text.slice(0, 200)}`);
    return sendJson(res, upstream.status, {
      error: { type: "api_error", message: `Salesforce Models API ${upstream.status}: ${text.slice(0, 500)}` },
    });
  }

  if (!stream) {
    const json = await upstream.json();
    return sendJson(res, 200, toOpenAICompletion(json, requestedModel));
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const parser = new SseBlockParser();
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  const chunkId = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let finishSent = false;
  let sawContent = false;

  const flushFinish = (reason: string) => {
    if (finishSent) return;
    finishSent = true;
    res.write(openAIChunk(chunkId, requestedModel, created, {}, reason));
    res.write("data: [DONE]\n\n");
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const block of parser.push(decoder.decode(value, { stream: true }))) {
        if (isSfDone(block)) {
          flushFinish("stop");
          continue;
        }
        // Surface an in-band error frame (SF may stream an error event with 200).
        if (block.event === "error" || /"errorCode"|"error"\s*:/.test(block.data)) {
          console.error(`[proxy] gpt stream error frame for ${alias}: ${block.data.slice(0, 500)}`);
        }
        const d = sfBlockToOpenAIDelta(block);
        if (!d) continue;
        if (d.content || d.toolCalls) {
          sawContent = true;
          const delta: { role?: string; content?: string; tool_calls?: any[] } = {};
          if (d.content) delta.content = d.content;
          if (d.toolCalls) delta.tool_calls = d.toolCalls;
          if (!sentRole) {
            delta.role = "assistant";
            sentRole = true;
          }
          res.write(openAIChunk(chunkId, requestedModel, created, delta, null));
        }
        if (d.finish) flushFinish(d.finish);
      }
    }
    if (!sawContent) {
      console.error(`[proxy] gpt stream for ${alias} produced no content (empty response)`);
    }
    // Safety net if the upstream ended without an explicit [DONE].
    flushFinish("stop");
  } catch (err) {
    console.error("[proxy] gpt stream error:", err);
    if (!finishSent) flushFinish("stop");
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || "";
  const method = req.method || "GET";

  if (method === "GET" && (url === "/health" || url === "/")) {
    return sendJson(res, 200, {
      status: "ok",
      anthropic_models: Object.keys(MODEL_MAP),
      openai_models: Object.keys(GPT_MODEL_MAP),
    });
  }

  // Copilot may probe a models list; list both families.
  if (method === "GET" && url === "/v1/models") {
    return sendJson(res, 200, {
      data: [...Object.keys(MODEL_MAP), ...Object.keys(GPT_MODEL_MAP)].map((id) => ({
        id,
        type: "model",
      })),
    });
  }

  if (method === "POST" && (url === "/v1/messages" || url === "/messages")) {
    if (!authorized(req)) {
      return sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: "bad proxy key" } });
    }
    try {
      return await handleMessages(req, res);
    } catch (err: any) {
      console.error("[proxy] handler error:", err);
      if (!res.headersSent) {
        return sendJson(res, 500, { type: "error", error: { type: "api_error", message: String(err?.message || err) } });
      }
      res.end();
      return;
    }
  }

  if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    if (!authorized(req)) {
      return sendJson(res, 401, { error: { type: "authentication_error", message: "bad proxy key" } });
    }
    try {
      return await handleChatCompletions(req, res);
    } catch (err: any) {
      console.error("[proxy] chat handler error:", err);
      if (!res.headersSent) {
        return sendJson(res, 500, { error: { type: "api_error", message: String(err?.message || err) } });
      }
      res.end();
      return;
    }
  }

  sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: `no route for ${method} ${url}` } });
});

server.listen(config.port, config.host, () => {
  console.log(`sf-copilot-proxy listening on http://${config.host}:${config.port}`);
  console.log(`  /v1/messages         -> ${config.modelsBaseUrl}/model/<alias>/invoke[-with-response-stream]`);
  console.log(`  /v1/chat/completions -> ${config.modelsBaseUrl}/chat/generations[/stream]`);
  console.log(`  anthropic models: ${Object.keys(MODEL_MAP).join(", ")}`);
  console.log(`  openai models: ${Object.keys(GPT_MODEL_MAP).join(", ")}`);
  console.log(`  auth: ${config.proxyKey ? "PROXY_API_KEY required" : "OPEN (no PROXY_API_KEY set)"}`);
  console.log(`  strip thinking: ${config.stripThinking}`);
  // Warm the token so the first Copilot request isn't slowed by a mint.
  tokens.get().catch((e) => console.error("[token] initial mint failed:", e.message));
});
