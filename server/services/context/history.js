import { Chat, ChatMessage } from "@lmstudio/sdk";
import { buildView } from "./core/viewBuilder.js";
import { stripReasoningMarkers } from "./core/reasoning.js";

export function eventOf(m) {
  if (m.event) return m.event;
  if (m.role === "tool") {
    try {
      return JSON.parse(m.content);
    } catch {}
  }
  return null;
}

// This is the source history. Summaries and UI reports are never fed back as
// original conversation. Tool results carry content once, not also as text.
export function modelHistory(session) {
  return (session.messages || [])
    .flatMap((m) => {
      if (m.role === "event") {
        const e = m.event;
        if (e?.type === "ask_question")
          return [
            {
              id: m.id,
              role: "assistant",
              text: `${e.question}\n${(e.options || []).join(" / ")}${e.answer ? `\nAntwort: ${e.answer}` : ""}`,
            },
          ];
        if (e?.type === "update_learning_plan")
          return [
            {
              id: m.id,
              role: "assistant",
              text: `Gespeicherte Lernplanänderung des Nutzers: ${JSON.stringify({ goal: e.goal, topics: e.topics })}`,
            },
          ];
        return [];
      }
      if (!["user", "assistant", "tool"].includes(m.role)) return [];
      return [
        {
          id: m.id,
          role: m.role,
          text:
            m.role === "tool"
              ? ""
              : m.role === "assistant"
                ? stripReasoningMarkers(m.content || "")
                : m.content || "",
          ...(m.tool_calls?.length
            ? {
                toolCalls: m.tool_calls.map((c) => ({
                  id: c.id,
                  name: c.function.name,
                  args: c.function.arguments,
                })),
              }
            : {}),
          ...(m.role === "tool"
            ? {
                toolResults: [
                  { toolCallId: m.tool_call_id, content: m.content || "" },
                ],
              }
            : {}),
        },
      ];
    })
    .filter(
      (m) => m.role !== "assistant" || m.text.trim() || m.toolCalls?.length,
    );
}

export function toSDK(m) {
  const content = [];
  if (m.text) content.push({ type: "text", text: m.text });
  for (const c of m.toolCalls || [])
    content.push({
      type: "toolCallRequest",
      toolCallRequest: {
        type: "function",
        id: c.id,
        name: c.name,
        arguments: JSON.parse(c.args || "{}"),
      },
    });
  for (const r of m.toolResults || [])
    content.push({
      type: "toolCallResult",
      toolCallId: r.toolCallId,
      content: r.content,
    });
  if (!content.length) content.push({ type: "text", text: "" });
  return ChatMessage.from({ role: m.role, content });
}

export function makeView(system, source, covered, strategy) {
  return buildView(
    system,
    source.map((m) => ({ canon: m, raw: toSDK(m) })),
    covered,
    strategy,
  );
}

export function plainChat(system, strategy = "system") {
  return Chat.from(
    strategy === "system"
      ? [
          { role: "system", content: system },
          { role: "user", content: "Kontextprüfung." },
        ]
      : [{ role: "user", content: `${system}\n\nKontextprüfung.` }],
  );
}
