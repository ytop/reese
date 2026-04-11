import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface OAuthCreds {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;   // ms epoch (used by gemini CLI)
  expires_at?: number;    // ms epoch (legacy)
  client_id?: string;
  client_secret?: string;
}

const CREDS_PATH = join(homedir(), ".gemini", "oauth_creds.json");

// Google's token endpoint
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Gemini CLI uses a fixed public client
const DEFAULT_CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty";

export class GeminiOAuthProvider {
  private cachedToken: string | null = null;
  private cacheExpiry: number = 0;

  constructor(_workspaceDir: string) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cacheExpiry - 60_000) return this.cachedToken;

    if (!existsSync(CREDS_PATH)) throw new Error(`Gemini OAuth creds not found at ${CREDS_PATH}`);

    const creds: OAuthCreds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
    const expiry = creds.expiry_date ?? creds.expires_at ?? 0;

    // Token still valid
    if (creds.access_token && now < expiry - 60_000) {
      this.cachedToken = creds.access_token;
      this.cacheExpiry = expiry;
      return creds.access_token;
    }

    // Refresh
    if (!creds.refresh_token) throw new Error("Gemini token expired and no refresh_token available");

    const client_id = creds.client_id ?? DEFAULT_CLIENT_ID;
    const client_secret = creds.client_secret ?? DEFAULT_CLIENT_SECRET;

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refresh_token,
        client_id,
        client_secret,
      }),
    });

    if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);

    const data: any = await res.json();
    const newExpiry = Date.now() + data.expires_in * 1000;

    // Persist updated creds
    const updated = { ...creds, access_token: data.access_token, expiry_date: newExpiry };
    writeFileSync(CREDS_PATH, JSON.stringify(updated, null, 2));

    this.cachedToken = data.access_token;
    this.cacheExpiry = newExpiry;
    return data.access_token;
  }
}
