/**
 * Example usage of Gemini client with OAuth
 * 
 * Run with: bun run src/gemini/example.ts
 */

import { GeminiClient } from "./client.js";
import { GeminiOAuthProvider } from "./oauth.js";

async function main() {
  const workspaceDir = process.env.WORKSPACE_DIR || "./workspace";
  
  try {
    const oauthProvider = new GeminiOAuthProvider(workspaceDir);
    
    const client = new GeminiClient({
      getAccessToken: () => oauthProvider.getAccessToken(),
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash-exp",
    });

    console.log("🔮 Gemini Client Example (OAuth)\n");

    // Simple query
    console.log("Query: What is the capital of France?");
    const response1 = await client.generate({
      prompt: "What is the capital of France? Answer in one sentence.",
    });

    if (response1.error) {
      console.error("❌ Error:", response1.error);
    } else {
      console.log("✅ Response:", response1.content);
    }

    console.log("\n---\n");

    // Query with history
    console.log("Query with history:");
    const response2 = await client.generate({
      prompt: "What is its population?",
      history: [
        { role: "user", content: "What is the capital of France?" },
        { role: "assistant", content: "The capital of France is Paris." },
      ],
    });

    if (response2.error) {
      console.error("❌ Error:", response2.error);
    } else {
      console.log("✅ Response:", response2.content);
    }

    console.log("\n✨ Done!");
  } catch (err) {
    console.error("❌ Failed to initialize:", err instanceof Error ? err.message : err);
    console.error("\nMake sure workspace/.gemini-oauth.json exists with your OAuth token.");
    process.exit(1);
  }
}

main().catch(console.error);
