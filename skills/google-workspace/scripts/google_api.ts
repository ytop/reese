#!/usr/bin/env node
/**
 * Google Workspace API CLI for Reese Agent.
 * 
 * Usage:
 *   google_api.ts gmail search "is:unread" [--max 10]
 *   google_api.ts gmail get MESSAGE_ID
 *   google_api.ts gmail send --to user@example.com --subject "Hi" --body "Hello"
 *   google_api.ts gmail reply MESSAGE_ID --body "Thanks"
 *   google_api.ts calendar list [--from DATE] [--to DATE] [--calendar primary]
 *   google_api.ts calendar create --summary "Meeting" --start DATETIME --end DATETIME
 *   google_api.ts drive search "budget report" [--max 10]
 *   google_api.ts contacts list [--max 20]
 *   google_api.ts sheets get SHEET_ID RANGE
 *   google_api.ts sheets update SHEET_ID RANGE --values '[[...]]'
 *   google_api.ts sheets append SHEET_ID RANGE --values '[[...]]'
 *   google_api.ts docs get DOC_ID
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const REESE_HOME = process.env.REESE_HOME || join(homedir(), '.reese');
const TOKEN_PATH = join(REESE_HOME, 'google_token.json');

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

function getCredentials(): OAuth2Client {
  if (!existsSync(TOKEN_PATH)) {
    console.error('Not authenticated. Run the setup script first.');
    process.exit(1);
  }

  const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
  const oauth2Client = new OAuth2Client();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

// Gmail
async function gmailSearch(query: string, max = 10) {
  const auth = getCredentials();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
  const messages = res.data.messages || [];
  
  if (messages.length === 0) {
    console.log('No messages found.');
    return;
  }

  const output = [];
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] });
    const headers = Object.fromEntries((detail.data.payload?.headers || []).map(h => [h.name, h.value]));
    output.push({
      id: detail.data.id,
      threadId: detail.data.threadId,
      from: headers.From || '',
      to: headers.To || '',
      subject: headers.Subject || '',
      date: headers.Date || '',
      snippet: detail.data.snippet || '',
      labels: detail.data.labelIds || [],
    });
  }
  console.log(JSON.stringify(output, null, 2));
}

async function gmailGet(messageId: string) {
  const auth = getCredentials();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = Object.fromEntries((msg.data.payload?.headers || []).map(h => [h.name, h.value]));
  
  let body = '';
  const payload = msg.data.payload;
  if (payload?.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
  } else if (payload?.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
        break;
      }
    }
    if (!body) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          break;
        }
      }
    }
  }

  console.log(JSON.stringify({
    id: msg.data.id,
    threadId: msg.data.threadId,
    from: headers.From || '',
    to: headers.To || '',
    subject: headers.Subject || '',
    date: headers.Date || '',
    labels: msg.data.labelIds || [],
    body,
  }, null, 2));
}

async function gmailSend(to: string, subject: string, body: string, options: { cc?: string; html?: boolean; threadId?: string } = {}) {
  const auth = getCredentials();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    options.cc ? `Cc: ${options.cc}` : '',
    `Content-Type: text/${options.html ? 'html' : 'plain'}; charset=utf-8`,
    '',
    body,
  ].filter(Boolean).join('\n');

  const raw = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const requestBody: any = { raw };
  if (options.threadId) requestBody.threadId = options.threadId;

  const result = await gmail.users.messages.send({ userId: 'me', requestBody });
  console.log(JSON.stringify({ status: 'sent', id: result.data.id, threadId: result.data.threadId || '' }, null, 2));
}

async function gmailReply(messageId: string, body: string) {
  const auth = getCredentials();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const original = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Message-ID'] });
  const headers = Object.fromEntries((original.data.payload?.headers || []).map(h => [h.name, h.value]));
  
  let subject = headers.Subject || '';
  if (!subject.startsWith('Re:')) subject = `Re: ${subject}`;

  const message = [
    `To: ${headers.From}`,
    `Subject: ${subject}`,
    headers['Message-ID'] ? `In-Reply-To: ${headers['Message-ID']}` : '',
    headers['Message-ID'] ? `References: ${headers['Message-ID']}` : '',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter(Boolean).join('\n');

  const raw = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: original.data.threadId } });
  console.log(JSON.stringify({ status: 'sent', id: result.data.id, threadId: result.data.threadId || '' }, null, 2));
}

async function gmailLabels() {
  const auth = getCredentials();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const res = await gmail.users.labels.list({ userId: 'me' });
  const labels = (res.data.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type || '' }));
  console.log(JSON.stringify(labels, null, 2));
}

async function gmailModify(messageId: string, addLabels?: string, removeLabels?: string) {
  const auth = getCredentials();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const body: any = {};
  if (addLabels) body.addLabelIds = addLabels.split(',');
  if (removeLabels) body.removeLabelIds = removeLabels.split(',');
  
  const result = await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: body });
  console.log(JSON.stringify({ id: result.data.id, labels: result.data.labelIds || [] }, null, 2));
}

// Calendar
async function calendarList(options: { start?: string; end?: string; max?: number; calendar?: string } = {}) {
  const auth = getCredentials();
  const calendar = google.calendar({ version: 'v3', auth });
  
  const now = new Date();
  const timeMin = options.start || now.toISOString();
  const timeMax = options.end || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: options.calendar || 'primary',
    timeMin,
    timeMax,
    maxResults: options.max || 25,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = (res.data.items || []).map(e => ({
    id: e.id,
    summary: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    location: e.location || '',
    description: e.description || '',
    status: e.status || '',
    htmlLink: e.htmlLink || '',
  }));
  console.log(JSON.stringify(events, null, 2));
}

async function calendarCreate(summary: string, start: string, end: string, options: { location?: string; description?: string; attendees?: string; calendar?: string } = {}) {
  const auth = getCredentials();
  const calendar = google.calendar({ version: 'v3', auth });
  
  const event: any = {
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
  };
  if (options.location) event.location = options.location;
  if (options.description) event.description = options.description;
  if (options.attendees) event.attendees = options.attendees.split(',').map(e => ({ email: e.trim() }));

  const result = await calendar.events.insert({ calendarId: options.calendar || 'primary', requestBody: event });
  console.log(JSON.stringify({ status: 'created', id: result.data.id, summary: result.data.summary || '', htmlLink: result.data.htmlLink || '' }, null, 2));
}

async function calendarDelete(eventId: string, calendarId = 'primary') {
  const auth = getCredentials();
  const calendar = google.calendar({ version: 'v3', auth });
  
  await calendar.events.delete({ calendarId, eventId });
  console.log(JSON.stringify({ status: 'deleted', eventId }));
}

// Drive
async function driveSearch(query: string, max = 10, rawQuery = false) {
  const auth = getCredentials();
  const drive = google.drive({ version: 'v3', auth });
  
  const q = rawQuery ? query : `fullText contains '${query}'`;
  const res = await drive.files.list({ q, pageSize: max, fields: 'files(id, name, mimeType, modifiedTime, webViewLink)' });
  console.log(JSON.stringify(res.data.files || [], null, 2));
}

// Contacts
async function contactsList(max = 50) {
  const auth = getCredentials();
  const people = google.people({ version: 'v1', auth });
  
  const res = await people.people.connections.list({ resourceName: 'people/me', pageSize: max, personFields: 'names,emailAddresses,phoneNumbers' });
  const contacts = (res.data.connections || []).map(person => ({
    name: person.names?.[0]?.displayName || '',
    emails: (person.emailAddresses || []).map(e => e.value || ''),
    phones: (person.phoneNumbers || []).map(p => p.value || ''),
  }));
  console.log(JSON.stringify(contacts, null, 2));
}

// Sheets
async function sheetsGet(sheetId: string, range: string) {
  const auth = getCredentials();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  console.log(JSON.stringify(res.data.values || [], null, 2));
}

async function sheetsUpdate(sheetId: string, range: string, values: string) {
  const auth = getCredentials();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const parsedValues = JSON.parse(values);
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: parsedValues },
  });
  console.log(JSON.stringify({ updatedCells: res.data.updatedCells || 0, updatedRange: res.data.updatedRange || '' }, null, 2));
}

async function sheetsAppend(sheetId: string, range: string, values: string) {
  const auth = getCredentials();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const parsedValues = JSON.parse(values);
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: parsedValues },
  });
  console.log(JSON.stringify({ updatedCells: res.data.updates?.updatedCells || 0 }, null, 2));
}

// Docs
async function docsGet(docId: string) {
  const auth = getCredentials();
  const docs = google.docs({ version: 'v1', auth });
  
  const doc = await docs.documents.get({ documentId: docId });
  const textParts: string[] = [];
  for (const element of doc.data.body?.content || []) {
    for (const pe of element.paragraph?.elements || []) {
      if (pe.textRun?.content) textParts.push(pe.textRun.content);
    }
  }
  console.log(JSON.stringify({ title: doc.data.title || '', documentId: doc.data.documentId || '', body: textParts.join('') }, null, 2));
}

// CLI parser
async function main() {
  const args = process.argv.slice(2);
  const service = args[0];
  const action = args[1];

  if (service === 'gmail') {
    if (action === 'search') {
      const query = args[2];
      const max = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1]) : 10;
      await gmailSearch(query, max);
    } else if (action === 'get') {
      await gmailGet(args[2]);
    } else if (action === 'send') {
      const to = args[args.indexOf('--to') + 1];
      const subject = args[args.indexOf('--subject') + 1];
      const body = args[args.indexOf('--body') + 1];
      const cc = args.includes('--cc') ? args[args.indexOf('--cc') + 1] : undefined;
      const html = args.includes('--html');
      const threadId = args.includes('--thread-id') ? args[args.indexOf('--thread-id') + 1] : undefined;
      await gmailSend(to, subject, body, { cc, html, threadId });
    } else if (action === 'reply') {
      const messageId = args[2];
      const body = args[args.indexOf('--body') + 1];
      await gmailReply(messageId, body);
    } else if (action === 'labels') {
      await gmailLabels();
    } else if (action === 'modify') {
      const messageId = args[2];
      const addLabels = args.includes('--add-labels') ? args[args.indexOf('--add-labels') + 1] : undefined;
      const removeLabels = args.includes('--remove-labels') ? args[args.indexOf('--remove-labels') + 1] : undefined;
      await gmailModify(messageId, addLabels, removeLabels);
    }
  } else if (service === 'calendar') {
    if (action === 'list') {
      const start = args.includes('--start') ? args[args.indexOf('--start') + 1] : undefined;
      const end = args.includes('--end') ? args[args.indexOf('--end') + 1] : undefined;
      const max = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1]) : 25;
      const calendar = args.includes('--calendar') ? args[args.indexOf('--calendar') + 1] : 'primary';
      await calendarList({ start, end, max, calendar });
    } else if (action === 'create') {
      const summary = args[args.indexOf('--summary') + 1];
      const start = args[args.indexOf('--start') + 1];
      const end = args[args.indexOf('--end') + 1];
      const location = args.includes('--location') ? args[args.indexOf('--location') + 1] : undefined;
      const description = args.includes('--description') ? args[args.indexOf('--description') + 1] : undefined;
      const attendees = args.includes('--attendees') ? args[args.indexOf('--attendees') + 1] : undefined;
      const calendar = args.includes('--calendar') ? args[args.indexOf('--calendar') + 1] : 'primary';
      await calendarCreate(summary, start, end, { location, description, attendees, calendar });
    } else if (action === 'delete') {
      const eventId = args[2];
      const calendar = args.includes('--calendar') ? args[args.indexOf('--calendar') + 1] : 'primary';
      await calendarDelete(eventId, calendar);
    }
  } else if (service === 'drive') {
    if (action === 'search') {
      const query = args[2];
      const max = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1]) : 10;
      const rawQuery = args.includes('--raw-query');
      await driveSearch(query, max, rawQuery);
    }
  } else if (service === 'contacts') {
    if (action === 'list') {
      const max = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1]) : 50;
      await contactsList(max);
    }
  } else if (service === 'sheets') {
    if (action === 'get') {
      await sheetsGet(args[2], args[3]);
    } else if (action === 'update') {
      const sheetId = args[2];
      const range = args[3];
      const values = args[args.indexOf('--values') + 1];
      await sheetsUpdate(sheetId, range, values);
    } else if (action === 'append') {
      const sheetId = args[2];
      const range = args[3];
      const values = args[args.indexOf('--values') + 1];
      await sheetsAppend(sheetId, range, values);
    }
  } else if (service === 'docs') {
    if (action === 'get') {
      await docsGet(args[2]);
    }
  } else {
    console.log('Usage: google_api.ts <service> <action> [options]');
    process.exit(1);
  }
}

main().catch(console.error);
