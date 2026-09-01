// Translation layer: OpenAI Chat Completions <-> Salesforce Models API
// "/chat/generations" (the Geo-aware openai-responses path used for GPT models).
//
// Copilot's OpenAI provider sends:  POST /v1/chat/completions
//   body {model, messages:[{role,content}], stream?, max_tokens?, temperature?, ...}
// Salesforce expects:               POST /ai/gpt/v1/chat/generations[/stream]
//   body {messages, generation_settings:{...}, model, system_prompt_strategy}
//   -> non-stream response: {id, generation_details:{generations:[{role,content,parameters:{finish_reason}}], parameters:{usage}}}
//   -> stream: SSE `event: generation` frames whose `content` is a DELTA, plus
//      scoringStarted/scores/scoringCompleted events (ignored), ending `data: [DONE]`.

// ---- Incoming: OpenAI body -> Salesforce /chat/generations body ----

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  // OpenAI allows an array of content parts; concatenate text parts.
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "",
      )
      .join("");
  }
  return "";
}

export function toGenerationsBody(incoming: any, alias: string): any {
  const messages = Array.isArray(incoming.messages)
    ? incoming.messages.map((m: any) => {
        const out: any = { role: m.role, content: messageContentToString(m.content) };
        // SF's schema names assistant tool calls `tool_invocations`, not the
        // OpenAI `tool_calls`. Without the rename, SF drops the field and the
        // following `tool` message has no antecedent -> 400 ("must be a response
        // to ... tool_calls"). Field shape is otherwise identical.
        if (Array.isArray(m.tool_calls)) out.tool_invocations = m.tool_calls;
        if (m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
        if (m.name != null) out.name = m.name;
        return out;
      })
    : [];

  const gs: Record<string, unknown> = {};
  if (incoming.max_tokens != null) gs.max_tokens = incoming.max_tokens;
  else if (incoming.max_completion_tokens != null) gs.max_tokens = incoming.max_completion_tokens;
  if (incoming.temperature != null) gs.temperature = incoming.temperature;
  if (incoming.stop != null) {
    gs.stop_sequences = Array.isArray(incoming.stop) ? incoming.stop : [incoming.stop];
  }
  if (incoming.frequency_penalty != null) gs.frequency_penalty = incoming.frequency_penalty;
  if (incoming.presence_penalty != null) gs.presence_penalty = incoming.presence_penalty;

  const body: any = {
    messages,
    generation_settings: gs,
    model: alias,
    system_prompt_strategy: "use_model_parameter",
  };
  // Pass through tool definitions so the model can emit new tool calls.
  if (Array.isArray(incoming.tools)) body.tools = incoming.tools;
  if (incoming.tool_choice != null) body.tool_choice = incoming.tool_choice;
  return body;
}

// ---- Outgoing (non-stream): generations response -> OpenAI chat.completion ----

function mapFinishReason(sf: string | null | undefined): string | null {
  if (!sf) return null;
  if (sf === "stop" || sf === "length" || sf === "content_filter") return sf;
  if (sf === "tool_calls" || sf === "tool_use") return "tool_calls";
  return "stop";
}

export function toOpenAICompletion(sf: any, requestedModel: string): any {
  const gen = sf?.generation_details?.generations?.[0];
  const usage = sf?.generation_details?.parameters?.usage;
  const finish = mapFinishReason(gen?.parameters?.finish_reason) ?? "stop";
  const created = sf?.generation_details?.parameters?.created || 0;

  const message: any = { role: "assistant", content: gen?.content ?? "" };
  // SF returns tool calls as `tool_invocations`; OpenAI clients expect
  // `tool_calls` on the message (with content null when it's a pure tool call).
  if (Array.isArray(gen?.tool_invocations) && gen.tool_invocations.length > 0) {
    message.tool_calls = gen.tool_invocations.map((t: any, i: number) => ({
      id: t.id,
      type: t.type || "function",
      function: t.function,
      index: t.index ?? i,
    }));
    if (!message.content) message.content = null;
  }
  const out: any = {
    id: sf?.id || "chatcmpl-proxy",
    object: "chat.completion",
    created,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish,
      },
    ],
  };
  if (usage) {
    out.usage = {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    };
  }
  return out;
}

// ---- Outgoing (stream): parse SF SSE, emit OpenAI chat.completion.chunk ----

// Minimal SSE parser: yields {event, data} per `\n\n`-delimited block.
export class SseBlockParser {
  private buf = "";

  push(text: string): Array<{ event: string; data: string }> {
    this.buf += text;
    const out: Array<{ event: string; data: string }> = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const raw of block.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      out.push({ event, data: dataLines.join("\n") });
    }
    return out;
  }
}

// Translate one SF SSE block into zero or one OpenAI chunk delta objects.
// Returns {delta?, finish?} — only `generation` events carrying a real content
// delta or a finish_reason produce output; scoring events are ignored.
export function sfBlockToOpenAIDelta(
  block: { event: string; data: string },
): { content?: string; toolCalls?: any[]; finish?: string | null } | null {
  if (block.event !== "generation") return null;
  const data = block.data.trim();
  if (!data || data === "[DONE]") return null;

  let obj: any;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  const gen = obj?.generation_details?.generations?.[0];
  if (!gen) return null; // usage-only / bookkeeping frame

  const content: string = typeof gen.content === "string" ? gen.content : "";
  const finish = mapFinishReason(gen.parameters?.finish_reason);
  // SF streams tool calls as `tool_invocations` deltas: the first frame carries
  // id+name, later frames stream `arguments` fragments keyed by `index`. Shape
  // matches OpenAI's `tool_calls` delta, so rename and pass the fragments through.
  const inv = Array.isArray(gen.tool_invocations) ? gen.tool_invocations : null;
  const toolCalls = inv && inv.length > 0
    ? inv.map((t: any, i: number) => ({
        index: t.index ?? i,
        ...(t.id != null ? { id: t.id } : {}),
        ...(t.type != null ? { type: t.type } : {}),
        ...(t.function != null ? { function: t.function } : {}),
      }))
    : undefined;
  if (!content && !toolCalls && !finish) return null;
  return { content: content || undefined, toolCalls, finish: finish ?? undefined };
}

export function isSfDone(block: { event: string; data: string }): boolean {
  return block.event === "generation" && block.data.trim() === "[DONE]";
}

export function openAIChunk(
  id: string,
  model: string,
  created: number,
  delta: { role?: string; content?: string; tool_calls?: any[] },
  finish_reason: string | null,
): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
