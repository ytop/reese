import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface GeminiOAuthConfig {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

export class GeminiOAuthProvider {
  private configPath: string;
  private cachedToken: string | null = null;
  private cacheExpiry: number = 0;

  constructor(_workspaceDir: string) {
    this.configPath = join(homedir(), ".gemini", "oauth_creds.json");
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    
    // Return cached token if still valid
    if (this.cachedToken && now < this.cacheExpiry) {
      return this.cachedToken;
    }

    // Read token from config file
    if (!existsSync(this.configPath)) {
      throw new Error(`Gemini OAuth config not found at ${this.configPath}`);
    }

    const config: GeminiOAuthConfig = JSON.parse(readFileSync(this.configPath, "utf-8"));
    
    if (!config.access_token) {
      throw new Error("No access_token in Gemini OAuth config");
    }

    // Cache token (default 1 hour if no expiry specified)
    this.cachedToken = config.access_token;
    this.cacheExpiry = config.expires_at || (now + 3600000);

    return config.access_token;
  }
}
