// src/planner.js
// Turns a plain-English goal into a structured tool call, same shape
// as the reference repo's planner.js.

const REFUND_MCP_TOOLS = [
  { name: 'get_order', description: 'Fetch an order by id (args: { order_id })' },
  { name: 'check_payment_history', description: 'Fetch customer risk profile (args: { customer_id })' },
];

async function planWithGemini(goal, geminiApiKey) {
  const prompt = `Convert this goal into a refund-desk MCP tool call.
Available tools: ${JSON.stringify(REFUND_MCP_TOOLS)}
Goal: "${goal}"
Return ONLY a JSON array like [{ "name": "tool_name", "args": {} }]. No markdown, no extra text.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiApiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
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
export async function planWithLlm(goal, overrides = {}) {
  const [call] = await planWithGemini(goal, process.env.GEMINI_API_KEY);
  return [{ ...call, args: { ...call.args, ...overrides } }];
}
