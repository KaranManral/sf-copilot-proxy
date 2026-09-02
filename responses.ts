// Translation layer: OpenAI Chat Completions <-> Salesforce Models API
// "/responses" (the OpenAI Responses API path the Vibes extension uses for GPT
// models on a non-gov org). This is the reasoning-capable path: `/chat/generations`
// silently ignores reasoning_effort (0 reasoning tokens), whereas `/responses`
// honors `reasoning:{effort}` and returns reasoning tokens.
//
// Copilot's OpenAI provider sends:  POST /v1/chat/completions
//   body {model, messages:[{role,content|tool_calls}], stream?, max_tokens?, ...}
// Salesforce expects:               POST /ai/gpt/v1/responses
//   body {model, input:[...items], max_output_tokens?, reasoning:{effort}?, tools?, ...}
//   -> non-stream: {status, output:[{type:"message",content:[{type:"output_text",text}]}
//                   | {type:"function_call",call_id,name,arguments}], usage}
//   -> stream: SSE `event: response.*` frames (output_text.delta,
//      function_call_arguments.delta, output_item.added/done, response.completed).

// ---- helpers ----

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "",
      )
      .join("");
  }
  return "";
}

// ---- Incoming: OpenAI Chat Completions body -> Responses body ----

// Convert OpenAI chat `messages` into the Responses `input` item array.
// Message roles carry text; assistant `tool_calls` become `function_call` items;
// `tool` messages become `function_call_output` items keyed by call_id.
function messagesToInput(messages: any[]): any[] {
  const input: any[] = [];
  for (const m of messages) {
    if (!m || typeof m.role !== "string") continue;

    if (m.role === "tool") {
      // Tool result -> function_call_output. Content must be a string.
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: contentToText(m.content),
      });
      continue;
    }

    if (m.role === "assistant") {
      const text = contentToText(m.content);
      // Responses input uses output_text for assistant message content.
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      // Assistant tool calls -> function_call items.
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function?.name,
            arguments:
              typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {}),
          });
        }
      }
      continue;
    }

    // system / developer / user -> message with input_text content.
    const text = contentToText(m.content);
    input.push({
      type: "message",
      role: m.role,
      content: [{ type: "input_text", text }],
    });
  }
  return input;
}

// OpenAI tools ({type:"function",function:{name,description,parameters}}) ->
// Responses tools ({type:"function",name,description,parameters}). The Responses
// API flattens the function fields to the top level.
function toolsToResponses(tools: any[]): any[] {
  return tools
    .filter((t) => t?.type === "function" && t.function)
    .map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      ...(t.function.strict != null ? { strict: t.function.strict } : {}),
    }));
}

// Copilot may send `reasoning_effort` (string) or a `reasoning:{effort}` object.
function extractEffort(incoming: any): string | undefined {
  if (typeof incoming.reasoning_effort === "string") return incoming.reasoning_effort;
  if (incoming.reasoning && typeof incoming.reasoning.effort === "string") {
    return incoming.reasoning.effort;
  }
  return undefined;
}

// The SF /responses backend rejects effort="max" ("Unexpected value 'max'",
// 400) on every GPT model tested; "xhigh" is the highest tier it accepts.
// Copilot's model picker still offers "max", so clamp it to "xhigh" rather than
// let the whole turn 400. Logged (not silent) so the substitution is visible.
export function clampEffort(effort: string | undefined): string | undefined {
  if (effort === "max") {
    console.log('[proxy] reasoning effort "max" not supported by backend; clamping to "xhigh"');
    return "xhigh";
  }
  return effort;
}

export function toResponsesBody(incoming: any, alias: string): any {
  const messages: any[] = Array.isArray(incoming.messages) ? incoming.messages : [];
  const body: any = {
    model: alias,
    input: messagesToInput(messages),
  };

  const maxOut = incoming.max_completion_tokens ?? incoming.max_tokens;
  if (maxOut != null) body.max_output_tokens = maxOut;
  // Reasoning models on this path reject temperature/top_p; only forward them
  // when reasoning is NOT requested.
  const effort = clampEffort(extractEffort(incoming));
  if (effort != null && effort !== "none") {
    body.reasoning = { effort };
  } else {
    if (incoming.temperature != null) body.temperature = incoming.temperature;
    if (incoming.top_p != null) body.top_p = incoming.top_p;
  }

  if (Array.isArray(incoming.tools) && incoming.tools.length > 0) {
    body.tools = toolsToResponses(incoming.tools);
  }
  if (incoming.tool_choice != null) body.tool_choice = incoming.tool_choice;
  if (incoming.parallel_tool_calls != null) {
    body.parallel_tool_calls = incoming.parallel_tool_calls;
  }
  return body;
}

// ---- Native passthrough: inbound OpenAI Responses body -> SF Responses body ----

// The Vibes extension (and a Copilot model registered with API type
// "responses") speaks the OpenAI Responses API directly: it POSTs a body that
// is already `{model, input:[...], reasoning?, tools?, ...}`. This is a
// near-passthrough to SF's /responses — we only need to (1) map the friendly
// model id to the sfdc_ai__ alias and (2) drop sampling params the reasoning
// models reject. Everything else (input items, tools, tool_choice, include,
// text/format, metadata) is forwarded verbatim so new Responses features work
// without proxy changes. `stream` is set by the caller, not here.
export function normalizeNativeResponsesBody(incoming: any, alias: string): any {
  const body: any = { ...incoming };
  body.model = alias;
  delete body.stream; // the endpoint/caller decides streaming, not the body echo

  // A reasoning request rejects temperature/top_p on this org's models (same as
  // the chat-completions path). `reasoning:{effort:"none"}` means no reasoning.
  const effort = clampEffort(
    body.reasoning && typeof body.reasoning.effort === "string"
      ? body.reasoning.effort
      : undefined,
  );
  if (effort != null && effort !== "none") {
    body.reasoning = { ...body.reasoning, effort };
    delete body.temperature;
    delete body.top_p;
  } else if (effort === "none") {
    // Normalize an explicit "none" away so the backend doesn't reject it.
    delete body.reasoning;
  }
  return body;
}

// Inspect a parsed SF Responses SSE block to know whether real output flowed and
// whether it carried an error — used by the streaming passthrough to detect the
// silent empty-stream case without altering the frames it forwards.
export function classifyResponsesBlock(block: { event: string; data: string }): {
  sawContent: boolean;
  errored: boolean;
} {
  const e = block.event;
  const sawContent =
    e === "response.output_text.delta" ||
    e === "response.output_item.added" ||
    e === "response.function_call_arguments.delta";
  const errored = e === "error" || e === "response.failed";
  return { sawContent, errored };
}

// ---- Outgoing (non-stream): Responses response -> OpenAI chat.completion ----

function mapResponsesFinish(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasToolCall: boolean,
): string {
  if (hasToolCall) return "tool_calls";
  if (status === "incomplete") {
    return incompleteReason === "max_output_tokens" ? "length" : "stop";
  }
  return "stop";
}

export function responsesToOpenAICompletion(sf: any, requestedModel: string): any {
  const output: any[] = Array.isArray(sf?.output) ? sf.output : [];
  let text = "";
  const toolCalls: any[] = [];

  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "" },
        index: toolCalls.length,
      });
    }
  }

  const message: any = { role: "assistant", content: text };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    if (!text) message.content = null;
  }

  const finish = mapResponsesFinish(
    sf?.status,
    sf?.incomplete_details?.reason,
    toolCalls.length > 0,
  );

  const out: any = {
    id: sf?.id || "chatcmpl-proxy",
    object: "chat.completion",
    created: sf?.created_at || 0,
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
  };

  const u = sf?.usage;
  if (u) {
    out.usage = {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      ...(u.output_tokens_details?.reasoning_tokens != null
        ? {
            completion_tokens_details: {
              reasoning_tokens: u.output_tokens_details.reasoning_tokens,
            },
          }
        : {}),
    };
  }
  return out;
}

// ---- Outgoing (stream): Responses SSE -> OpenAI chat.completion.chunk ----

// Minimal SSE parser: yields {event, data} per `\n\n`-delimited block.
export class ResponsesSseParser {
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

// Stateful translator: turn a stream of Responses SSE events into OpenAI
// chat.completion.chunk deltas. Tracks function_call items by output_index so
// argument fragments map to the right tool_call slot.
export class ResponsesStreamTranslator {
  private toolIndexByOutput = new Map<number, number>();
  private nextToolIndex = 0;
  sawContent = false;

  // Returns an array of delta objects to emit as OpenAI chunks (may be empty).
  translate(event: { event: string; data: string }): Array<{
    role?: string;
    content?: string;
    tool_calls?: any[];
  }> {
    const type = event.event;
    if (!type || !type.startsWith("response.")) return [];
    let obj: any;
    try {
      obj = JSON.parse(event.data);
    } catch {
      return [];
    }

    if (type === "response.output_text.delta") {
      if (typeof obj.delta === "string" && obj.delta.length > 0) {
        this.sawContent = true;
        return [{ content: obj.delta }];
      }
      return [];
    }

    if (type === "response.output_item.added" && obj.item?.type === "function_call") {
      const outIdx = obj.output_index ?? 0;
      const idx = this.nextToolIndex++;
      this.toolIndexByOutput.set(outIdx, idx);
      this.sawContent = true;
      return [
        {
          tool_calls: [
            {
              index: idx,
              id: obj.item.call_id,
              type: "function",
              function: { name: obj.item.name, arguments: "" },
            },
          ],
        },
      ];
    }

    if (type === "response.function_call_arguments.delta") {
      const outIdx = obj.output_index ?? 0;
      const idx = this.toolIndexByOutput.get(outIdx) ?? 0;
      if (typeof obj.delta === "string" && obj.delta.length > 0) {
        return [
          {
            tool_calls: [{ index: idx, function: { arguments: obj.delta } }],
          },
        ];
      }
      return [];
    }

    return [];
  }

  // Determine the finish_reason from the terminal response.completed event.
  finishReason(event: { event: string; data: string }): string | null {
    if (event.event !== "response.completed") return null;
    try {
      const obj = JSON.parse(event.data);
      const resp = obj.response || obj;
      const hasToolCall =
        Array.isArray(resp.output) &&
        resp.output.some((o: any) => o?.type === "function_call");
      return mapResponsesFinish(resp.status, resp.incomplete_details?.reason, hasToolCall);
    } catch {
      return "stop";
    }
  }
}
