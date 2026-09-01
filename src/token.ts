// Mints and caches a short-lived Salesforce OrgJWT via the OAuth 2.0
// client_credentials flow, refreshing it before expiry. This is the piece
// GitHub Copilot's BYOK cannot do on its own (it only holds a static key).

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Decode a JWT's `exp` (seconds since epoch) without verifying the signature.
function jwtExpMs(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class TokenProvider {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  // Refresh when within this many ms of expiry.
  private static readonly SKEW_MS = 5 * 60 * 1000;

  private readonly instanceUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(instanceUrl: string, clientId: string, clientSecret: string) {
    this.instanceUrl = instanceUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  async get(): Promise<string> {
    const now = Date.now();
    if (this.cached && now < this.cached.expiresAtMs - TokenProvider.SKEW_MS) {
      return this.cached.token;
    }
    // Collapse concurrent refreshes into one network call.
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async mint(): Promise<string> {
    const url = `${this.instanceUrl.replace(/\/+$/, "")}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = (await resp.json().catch(() => ({}))) as TokenResponse;
    if (!resp.ok || !data.access_token) {
      const reason = data.error_description || data.error || `HTTP ${resp.status}`;
      throw new Error(`OrgJWT mint failed: ${reason}`);
    }

    const token = data.access_token;
    const expFromJwt = jwtExpMs(token);
    const expFromResp = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
    const expiresAtMs = expFromJwt ?? expFromResp ?? Date.now() + 60 * 60 * 1000;

    this.cached = { token, expiresAtMs };
    const mins = Math.round((expiresAtMs - Date.now()) / 60000);
    console.log(`[token] minted OrgJWT, valid ~${mins} min`);
    return token;
  }
}
