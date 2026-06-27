// server/services/lmStudio.js

/**
 * Sends a chat completion request to LM Studio (OpenAI-compatible API).
 * Use stream: false for tool-calling loops; stream: true for the final text response.
 */
export async function callLMStudio({ messages, tools = [], model, lmStudioUrl, stream = false, temperature = 0.4, maxTokens = 2048 }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`LM Studio Fehler (${response.status}): ${errText}`);
  }

  if (stream) {
    return response; // return raw response for streaming
  }

  return response.json();
}
