import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useApp, render } from "ink";
import TextInput from "ink-text-input";
import type { AgentLoop } from "./agent/loop.js";
import type { MessageBus } from "./bus/queue.js";

// ── Types ────────────────────────────────────────────────────────────────────

type MessageRole = "user" | "assistant" | "system" | "progress";

interface ChatEntry {
  id: number;
  role: MessageRole;
  content: string;
}

// ── Components ───────────────────────────────────────────────────────────────

const COLORS: Record<MessageRole, string> = {
  user: "cyan",
  assistant: "white",
  system: "yellow",
  progress: "gray",
};

const LABELS: Record<MessageRole, string> = {
  user: "You",
  assistant: "Reese",
  system: "System",
  progress: "…",
};

function ChatMessage({ entry }: { entry: ChatEntry }) {
  const color = COLORS[entry.role];
  const label = LABELS[entry.role];
  const isProgress = entry.role === "progress";

  return (
    <Box flexDirection="column" marginBottom={isProgress ? 0 : 1}>
      <Text color={color as any} bold={!isProgress}>
        {label}
      </Text>
      <Text dimColor={isProgress} wrap="wrap">
        {entry.content}
      </Text>
    </Box>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────

interface AppProps {
  loop: AgentLoop;
  bus: MessageBus;
}

function App({ loop, bus }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatEntry[]>([
    {
      id: 0,
      role: "system",
      content:
        'Reese is ready. Type a message, or /help for commands. Ctrl+C to exit.',
    },
  ]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamingId, setStreamingId] = useState<number | null>(null);
  const idRef = useRef(1);

  const nextId = () => idRef.current++;

  // Subscribe to outbound bus messages
  useEffect(() => {
    const unsub = bus.onOutbound((msg) => {
      if (msg.channel !== "cli") return;
      const isProgress = Boolean(msg.metadata?.["_progress"]);
      const isStreamDelta = Boolean(msg.metadata?.["_stream_delta"]);
      const isStreamEnd = Boolean(msg.metadata?.["_stream_end"]);

      if (isStreamDelta && msg.content) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && streamingId === last.id) {
            return [...prev.slice(0, -1), { ...last, content: last.content + msg.content }];
          }
          const id = nextId();
          setStreamingId(id);
          return [...prev, { id, role: "assistant", content: msg.content }];
        });
        return;
      }

      if (isStreamEnd) {
        setStreamingId(null);
        return;
      }

      if (isProgress) {
        // Show progress hint, replace previous if also progress
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "progress") {
            return [...prev.slice(0, -1), { id: last.id, role: "progress", content: msg.content }];
          }
          return [...prev, { id: nextId(), role: "progress", content: msg.content }];
        });
        return;
      }

      // Regular message
      setMessages((prev) => {
        // Remove pending progress messages
        const filtered = prev.filter((m) => m.role !== "progress");
        return [...filtered, { id: nextId(), role: "assistant", content: msg.content }];
      });
      setIsProcessing(false);
    });
    return unsub;
  }, [bus, streamingId]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || isProcessing) return;
    setInput("");
    setIsProcessing(true);

    const msgId = nextId();
    setMessages((prev) => [...prev, { id: msgId, role: "user", content: text }]);

    try {
      const response = await loop.processMessage({
        channel: "cli",
        senderId: "user",
        chatId: "direct",
        content: text,
        timestamp: new Date(),
      });
      if (response) {
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.role !== "progress");
          return [...filtered, { id: nextId(), role: "assistant", content: response.content }];
        });
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev.filter((m) => m.role !== "progress"),
        { id: nextId(), role: "system", content: `Error: ${String(err)}` },
      ]);
    }
    setIsProcessing(false);
  }, [input, isProcessing, loop]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      {/* Chat history */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
        {messages.map((m) => (
          <ChatMessage key={m.id} entry={m} />
        ))}
        {isProcessing && !streamingId && (
          <Text color="gray" dimColor>
            Reese is thinking…
          </Text>
        )}
      </Box>

      {/* Input area */}
      <Box borderStyle="single" paddingX={1}>
        <Text color="cyan" bold>
          {"› "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          placeholder={isProcessing ? "Processing…" : "Type a message…"}
        />
      </Box>
    </Box>
  );
}

/** Launch the interactive Ink CLI. */
export function startCli(loop: AgentLoop, bus: MessageBus): void {
  render(<App loop={loop} bus={bus} />);
}
