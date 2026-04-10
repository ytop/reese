#!/usr/bin/env node
/**
 * Google Workspace OAuth2 setup for Reese Agent.
 * 
 * Commands:
 *   setup.ts --check                          # Is auth valid? Exit 0 = yes, 1 = no
 *   setup.ts --client-secret /path/to.json    # Store OAuth client credentials
 *   setup.ts --auth-url                       # Print the OAuth URL for user to visit
 *   setup.ts --auth-code CODE                 # Exchange auth code for token
 *   setup.ts --revoke                         # Revoke and delete stored token
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

const REESE_HOME = process.env.REESE_HOME || join(homedir(), '.reese');
const TOKEN_PATH = join(REESE_HOME, 'google_token.json');
const CLIENT_SECRET_PATH = join(REESE_HOME, 'google_client_secret.json');
const PENDING_AUTH_PATH = join(REESE_HOME, 'google_oauth_pending.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents.readonly',
];

const REDIRECT_URI = 'http://localhost:1';

function loadTokenPayload(path = TOKEN_PATH): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function missingScopesFromPayload(payload: any): string[] {
  const raw = payload.scopes || payload.scope;
  if (!raw) return [];
  const granted = new Set(Array.isArray(raw) ? raw : raw.split(' ').filter((s: string) => s.trim()));
  return SCOPES.filter(scope => !granted.has(scope));
}

function formatMissingScopes(missingScopes: string[]): string {
  const bullets = missingScopes.map(s => `  - ${s}`).join('\n');
  return `Token is valid but missing required Google Workspace scopes:\n${bullets}\nRun the Google Workspace setup again from this same Reese profile to refresh consent.`;
}

async function checkAuth(): Promise<boolean> {
  if (!existsSync(TOKEN_PATH)) {
    console.log(`NOT_AUTHENTICATED: No token at ${TOKEN_PATH}`);
    return false;
  }

  try {
    const payload = loadTokenPayload(TOKEN_PATH);
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials(payload);

    const tokenInfo = await oauth2Client.getTokenInfo(payload.access_token);
    const missingScopes = missingScopesFromPayload(payload);
    
    if (missingScopes.length > 0) {
      console.log(`AUTH_SCOPE_MISMATCH: ${formatMissingScopes(missingScopes)}`);
      return false;
    }

    console.log(`AUTHENTICATED: Token valid at ${TOKEN_PATH}`);
    return true;
  } catch (error: any) {
    if (error.message?.includes('invalid_token')) {
      console.log('TOKEN_INVALID: Re-run setup.');
      return false;
    }
    
    // Try to refresh
    try {
      const payload = loadTokenPayload(TOKEN_PATH);
      const oauth2Client = new OAuth2Client();
      oauth2Client.setCredentials(payload);
      const { credentials } = await oauth2Client.refreshAccessToken();
      writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
      
      const missingScopes = missingScopesFromPayload(credentials);
      if (missingScopes.length > 0) {
        console.log(`AUTH_SCOPE_MISMATCH: ${formatMissingScopes(missingScopes)}`);
        return false;
      }
      
      console.log(`AUTHENTICATED: Token refreshed at ${TOKEN_PATH}`);
      return true;
    } catch {
      console.log(`REFRESH_FAILED: ${error.message}`);
      return false;
    }
  }
}

function storeClientSecret(path: string): void {
  if (!existsSync(path)) {
    console.log(`ERROR: File not found: ${path}`);
    process.exit(1);
  }

  let data: any;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    console.log('ERROR: File is not valid JSON.');
    process.exit(1);
  }

  if (!data.installed && !data.web) {
    console.log("ERROR: Not a Google OAuth client secret file (missing 'installed' key).");
    console.log('Download the correct file from: https://console.cloud.google.com/apis/credentials');
    process.exit(1);
  }

  writeFileSync(CLIENT_SECRET_PATH, JSON.stringify(data, null, 2));
  console.log(`OK: Client secret saved to ${CLIENT_SECRET_PATH}`);
}

function savePendingAuth(state: string, codeVerifier: string): void {
  writeFileSync(PENDING_AUTH_PATH, JSON.stringify({ state, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }, null, 2));
}

function loadPendingAuth(): any {
  if (!existsSync(PENDING_AUTH_PATH)) {
    console.log('ERROR: No pending OAuth session found. Run --auth-url first.');
    process.exit(1);
  }

  try {
    const data = JSON.parse(readFileSync(PENDING_AUTH_PATH, 'utf-8'));
    if (!data.state || !data.code_verifier) {
      console.log('ERROR: Pending OAuth session is missing PKCE data.');
      console.log('Run --auth-url again to start a fresh OAuth session.');
      process.exit(1);
    }
    return data;
  } catch (error) {
    console.log(`ERROR: Could not read pending OAuth session: ${error}`);
    console.log('Run --auth-url again to start a fresh OAuth session.');
    process.exit(1);
  }
}

function getAuthUrl(): void {
  if (!existsSync(CLIENT_SECRET_PATH)) {
    console.log('ERROR: No client secret stored. Run --client-secret first.');
    process.exit(1);
  }

  const credentials = JSON.parse(readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;

  const oauth2Client = new OAuth2Client(client_id, client_secret, REDIRECT_URI);
  
  // Generate code verifier for PKCE
  const codeVerifier = Buffer.from(Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)).toString('base64url');
  const codeChallenge = Buffer.from(codeVerifier).toString('base64url');
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    code_challenge_method: 'S256' as any,
    code_challenge: codeChallenge,
  });

  savePendingAuth(authUrl, codeVerifier);
  console.log(authUrl);
}

function extractCodeAndState(codeOrUrl: string): { code: string; state?: string } {
  if (!codeOrUrl.startsWith('http')) {
    return { code: codeOrUrl };
  }

  const url = new URL(codeOrUrl);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code) {
    console.log("ERROR: No 'code' parameter found in URL.");
    process.exit(1);
  }

  return { code, state: state || undefined };
}

async function exchangeAuthCode(codeOrUrl: string): Promise<void> {
  if (!existsSync(CLIENT_SECRET_PATH)) {
    console.log('ERROR: No client secret stored. Run --client-secret first.');
    process.exit(1);
  }

  const pendingAuth = loadPendingAuth();
  const { code } = extractCodeAndState(codeOrUrl);

  const credentials = JSON.parse(readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;

  const oauth2Client = new OAuth2Client(client_id, client_secret, REDIRECT_URI);

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    const missingScopes = missingScopesFromPayload(tokens);
    if (missingScopes.length > 0) {
      console.log(`ERROR: Refusing to save incomplete Google Workspace token. ${formatMissingScopes(missingScopes)}`);
      console.log(`Existing token at ${TOKEN_PATH} was left unchanged.`);
      process.exit(1);
    }

    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    if (existsSync(PENDING_AUTH_PATH)) unlinkSync(PENDING_AUTH_PATH);
    
    console.log(`OK: Authenticated. Token saved to ${TOKEN_PATH}`);
  } catch (error: any) {
    console.log(`ERROR: Token exchange failed: ${error.message}`);
    console.log('The code may have expired. Run --auth-url to get a fresh URL.');
    process.exit(1);
  }
}

async function revoke(): Promise<void> {
  if (!existsSync(TOKEN_PATH)) {
    console.log('No token to revoke.');
    return;
  }

  try {
    const payload = loadTokenPayload(TOKEN_PATH);
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials(payload);
    await oauth2Client.revokeToken(payload.access_token);
    console.log('Token revoked with Google.');
  } catch (error: any) {
    console.log(`Remote revocation failed (token may already be invalid): ${error.message}`);
  }

  if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
  if (existsSync(PENDING_AUTH_PATH)) unlinkSync(PENDING_AUTH_PATH);
  console.log(`Deleted ${TOKEN_PATH}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--check')) {
    const result = await checkAuth();
    process.exit(result ? 0 : 1);
  } else if (args.includes('--client-secret')) {
    const idx = args.indexOf('--client-secret');
    storeClientSecret(args[idx + 1]);
  } else if (args.includes('--auth-url')) {
    getAuthUrl();
  } else if (args.includes('--auth-code')) {
    const idx = args.indexOf('--auth-code');
    await exchangeAuthCode(args[idx + 1]);
  } else if (args.includes('--revoke')) {
    await revoke();
  } else {
    console.log('Usage:');
    console.log('  setup.ts --check');
    console.log('  setup.ts --client-secret /path/to.json');
    console.log('  setup.ts --auth-url');
    console.log('  setup.ts --auth-code CODE');
    console.log('  setup.ts --revoke');
    process.exit(1);
  }
}

main().catch(console.error);
