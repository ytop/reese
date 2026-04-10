---
name: google-workspace-oauth-setup
description: Reusable workflow for setting up Google Workspace authentication using a client secret JSON file
category: productivity
---
# Google Workspace OAuth Setup Skill

## Description
Reusable workflow for setting up Google Workspace authentication using a client secret JSON file. This skill handles the OAuth flow to obtain and store credentials for accessing Google services (Gmail, Calendar, Drive, Sheets, Docs, Contacts).

## When to Use
- When you have a Google API client secret JSON file (downloaded from Google Cloud Console)
- When you need to authenticate Reese to access Google Workspace services
- When existing credentials have expired or need renewal

## Prerequisites
1. Google API client secret JSON file (typically named `client_secret_*.json` or similar)
2. The file should contain OAuth 2.0 Client ID credentials for a "Desktop app" or "Installed application"
3. Reese agent with access to file system and ability to make HTTP requests

## Step-by-Step Instructions

### 1. Prepare Client Secret File
- Ensure you have the client secret JSON file from Google Cloud Console ~/.reese/google_client_secret.json

### 2. Check Authentication Status
Use the google-workspace skill to check current status:
- This will show if you're already authenticated or need to proceed

### 3. Initiate OAuth Flow
If not authenticated, the skill will:
- Generate an authorization URL
- Instruct you to open it in a browser
- Guide you through Google's consent screen
- Wait for the redirect back to localhost

### 4. Complete Authorization
1. Copy the full authorization URL provided by the skill
2. Paste it into your browser and press Enter
3. Sign in with your Google account if prompted
4. Review and accept the requested permissions
5. After granting access, your browser will redirect to `http://localhost:1/?code=...` (may show error page)
6. Copy the **full redirect URL** from your browser's address bar
7. Paste it back to the Reese agent

### 5. Verify Authentication
The skill will automatically:
- Exchange the authorization code for access and refresh tokens
- Store the tokens securely in `~/.reese/google_token.json`
- Confirm successful authentication

### 6. Test Access
Try a simple operation to verify:
- List recent Gmail messages
- Check calendar events
- Browse Drive files

## Example Usage Flow
```
Agent: [Copies file to ~/.reese/google_client_secret.json]
Agent: [Checks status - shows NOT AUTHENTICATED]
Agent: [Provides authorization URL]
User: [Opens URL, completes consent, copies redirect URL]
User: [Pastes redirect URL]
Agent: [Exchanges code, stores tokens, confirms AUTHENTICATED]
Agent: [Tests with "Show me 5 recent emails"]
```

## Scopes Requested
By default, this skill requests broad Google Workspace access including:
- Gmail: read, send, modify
- Google Calendar: read/write
- Google Drive: read
- Google Contacts: read
- Google Sheets: read/write
- Google Documents: read

## Token Storage
- Access token and refresh token stored in: `~/.reese/google_token.json`
- Tokens are automatically refreshed when expired using the refresh token
- Store this file securely as it provides access to your Google account

## Troubleshooting
- **"invalid_grant" error**: Authorization code expired or used twice - restart from step 4
- **"access_denied"**: User denied permissions - need to re-consent
- **Token not refreshing**: Delete `~/.reese/google_token.json` and restart
- **Port conflicts**: Ensure nothing else is using port 1 on localhost during OAuth flow

## Notes
- The redirect URI must be `http://localhost` or `http://localhost:1/` as configured in Google Cloud Console
- For production use, consider restricting scopes to minimum required
- This skill assumes the google-workspace skill is available and functional
