# Google Workspace Skill - TypeScript Port

This skill has been ported from Python to TypeScript for the Reese agent.

## Changes from Hermes to Reese

- **Language**: Python → TypeScript
- **Project name**: Hermes → Reese
- **Environment variable**: `HERMES_HOME` → `REESE_HOME` (defaults to `~/.reese`)
- **Dependencies**: Python packages → Node.js packages via npm

## Installation

```bash
cd google-workspace
npm install
```

## Usage

The API remains the same, but scripts are now run with `ts-node`:

```bash
# Setup
npx ts-node scripts/setup.ts --check
npx ts-node scripts/setup.ts --client-secret /path/to/credentials.json
npx ts-node scripts/setup.ts --auth-url
npx ts-node scripts/setup.ts --auth-code CODE

# API calls
npx ts-node scripts/google_api.ts gmail search "is:unread"
npx ts-node scripts/google_api.ts calendar list
npx ts-node scripts/google_api.ts drive search "report"
```

## Dependencies

- `googleapis`: Google APIs Node.js client
- `google-auth-library`: Google authentication library
- `typescript`: TypeScript compiler
- `ts-node`: TypeScript execution engine
- `@types/node`: Node.js type definitions

See `SKILL.md` for complete documentation.
