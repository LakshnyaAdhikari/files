// Turns a plain-English goal into a structured tool call, same shape
// as the reference repo's planner.js.

const REFUND_MCP_TOOLS = [
  { name: 'get_order', description: 'Fetch an order by id (args: { order_id })' },
  { name: 'check_payment_history', description: 'Fetch customer risk profile (args: { customer_id })' },
];

const GEMINI_MODEL = 'gemini-3.6-flash';

function extractJsonArray(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    throw new Error('Gemini did not return a JSON tool-call array.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function planWithGemini(goal, geminiApiKey, retries = 3) {
  const prompt = `Convert this goal into a refund-desk MCP tool call.
Available tools: ${JSON.stringify(REFUND_MCP_TOOLS)}
Goal: "${goal}"
Return ONLY a JSON array like [{ "name": "tool_name", "args": {} }]. No markdown, no extra text.`;

  if (!geminiApiKey) throw new Error('GEMINI_API_KEY is required to plan tool calls.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const data = await response.json().catch(() => ({}));
      
      if (!response.ok) {
        if (response.status === 429) {
          if (attempt === retries) throw new Error(`Gemini request failed (429): Quota exceeded.`);
          // Backoff dynamically or use a fixed 30s fallback
          const delayMs = attempt * 30000;
          console.log(`\n  [PLANNER] ⚠️ Gemini rate limit (429) hit. Retrying attempt ${attempt + 1}/${retries} in ${delayMs / 1000}s...`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(`Gemini request failed (${response.status}): ${data.error?.message ?? response.statusText}`);
      }

      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error('Gemini returned no tool-call content.');
      }

      const parsed = extractJsonArray(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Gemini returned an empty tool-call plan.');
      }
      return parsed;
    } catch (error) {
      if (attempt === retries) {
        throw new Error(`Unable to plan refund-desk tool call: ${error.message}`);
      }
      // Only 429s are caught by the loop's continue; other network errors will bubble up here
      // We could retry network errors too, but for now we throw unless it's a handled 429.
      throw new Error(`Unable to plan refund-desk tool call: ${error.message}`);
    }
  }
}

/**
 * `overrides` carries values the ticket-intake code already knows for
 * certain (e.g. the order_id the ticket was filed against) and ALWAYS
 * wins over anything the LLM extracted from free text.
 *
 * IMPORTANT: for the read-only lookup steps (get_order,
 * check_payment_history) we deliberately do NOT override order_id --
 * this is what lets the order-binding demo ticket actually reach the
 * LLM's free-text extraction and attempt to drift toward the wrong
 * order. The refund *execution* step, by contrast, must always use
 * the order_id that was bound into the originally captured plan, not
 * whatever the LLM most recently extracted -- that's the distinction
 * plan-conformance is there to enforce.
 */
export async function planWithLlm(goal, overrides = {}, allowedTools = REFUND_MCP_TOOLS.map(({ name }) => name)) {
  const [call] = await planWithGemini(goal, process.env.GEMINI_API_KEY);
  if (!call || typeof call.name !== 'string' || !allowedTools.includes(call.name)) {
    throw new Error(`Planner returned disallowed tool: ${call?.name ?? 'missing tool name'}.`);
  }
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new Error(`Planner returned invalid arguments for ${call.name}.`);
  }
  return [{ ...call, args: { ...call.args, ...overrides } }];
}
