// Incremental decoder for the AWS event-stream (vnd.amazon.eventstream) binary
// framing that Bedrock's invoke-with-response-stream returns.
//
// Each message frame:
//   [4] total length (big-endian)
//   [4] headers length (big-endian)
//   [4] prelude CRC
//   [headers-length] headers
//   [payload]  (total - headers - 16)
//   [4] message CRC
//
// The payload for a Bedrock stream chunk is JSON: {"bytes":"<base64>"} where the
// decoded base64 is the actual Anthropic streaming event JSON. Some frames are
// exception/error frames (surfaced via the :exception-type header).

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Buffer;
}

export class EventStreamDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): EventStreamMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: EventStreamMessage[] = [];

    while (this.buf.length >= 12) {
      const totalLen = this.buf.readUInt32BE(0);
      if (totalLen < 16 || totalLen > 64 * 1024 * 1024) {
        // Corrupt framing — drop the buffer to avoid an infinite loop.
        this.buf = Buffer.alloc(0);
        break;
      }
      if (this.buf.length < totalLen) break; // wait for the rest of the frame

      const headersLen = this.buf.readUInt32BE(4);
      const headersStart = 12;
      const headersEnd = headersStart + headersLen;
      const payloadEnd = totalLen - 4;

      const headers = this.parseHeaders(this.buf.subarray(headersStart, headersEnd));
      const payload = this.buf.subarray(headersEnd, payloadEnd);

      out.push({ headers, payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(totalLen);
    }
    return out;
  }

  private parseHeaders(b: Buffer): Record<string, string> {
    const headers: Record<string, string> = {};
    let i = 0;
    while (i < b.length) {
      const nameLen = b.readUInt8(i);
      i += 1;
      const name = b.subarray(i, i + nameLen).toString("utf8");
      i += nameLen;
      const type = b.readUInt8(i);
      i += 1;
      // type 7 = string (the only type used by these headers)
      if (type === 7) {
        const valLen = b.readUInt16BE(i);
        i += 2;
        headers[name] = b.subarray(i, i + valLen).toString("utf8");
        i += valLen;
      } else {
        // Skip other header value types we don't need.
        break;
      }
    }
    return headers;
  }
}

// Extract the inner Anthropic event JSON from a Bedrock stream frame payload.
// Returns the parsed event object, or null if this frame carries no event.
export function extractAnthropicEvent(msg: EventStreamMessage): any | null {
  const text = msg.payload.toString("utf8").trim();
  if (!text) return null;
  let outer: any;
  try {
    outer = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof outer?.bytes === "string") {
    try {
      return JSON.parse(Buffer.from(outer.bytes, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  // Error/exception frames come through as plain JSON without a bytes wrapper.
  return outer;
}
