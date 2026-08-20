// agent.js
//
// Refund desk agent. Follows the same plan -> check -> execute -> report
// loop as the reference GitHub agent guide, adapted for the refund
// domain, plus the two differentiators from the plan:
//   1. Dynamic, code-computed threshold (src/policy.js) -- decides
//      WHICH tool name gets declared, never a number the LLM reasons about.
//   2. Order-binding plan-conformance demo (ticket_3) -- the plan is
//      captured once per ticket with the CORRECT order_id bound in,
//      and the refund execution step is checked against that captured
//      plan rather than re-derived from the LLM's live output. If the
//      ticket's poisoned text drifts the LLM toward a different order,
//      the mismatch should be caught before the tool call lands.
//
// *** VERIFY BEFORE DEMO DAY ***
// The reference repo's session.check()/startPlan() pattern is coarse
// (tool-name + args, evaluated per call). Whether it enforces a
// multi-step plan hash (order_id bound at plan-capture time, checked
// again at execute time) the way this file assumes needs to be
// confirmed against the actual capture_plan()/invoke() primitives in
// the SDK docs -- don't assume this file is correct until you've run
// it against a real mismatch and watched it actually block.

import 'dotenv/config';
import Database from 'better-sqlite3';
import { ArmorIQClient } from '@armoriq/sdk';
import { connectRefundMcp, callTool, disconnectRefundMcp } from './src/mcp.js';
import { planWithLlm } from './src/planner.js';
import { selectRefundAction, explainHold } from './src/policy.js';

const db = new Database(process.env.DB_PATH || './db/refunds.db');
const userEmail = process.env.USER_EMAIL;

async function runReadStep(session, goal, overrides) {
  const [call] = await planWithLlm(goal, overrides);
  await session.startPlan([call], goal);

  const decision = await session.check(call.name, call.args, userEmail);
  if (!decision.allowed) {
    console.log(`  [BLOCKED] ${call.name}: ${decision.reason}`);
    await session.report(call.name, call.args, { status: decision.action, reason: decision.reason });
    return null;
  }

  const result = await callTool(call.name, call.args);
  const data = JSON.parse(result.content[0].text);
  await session.report(call.name, call.args, { status: 'success', result: data });
  return data;
}

/**
 * The refund execution step is intentionally NOT planned from free
 * text. The order_id and amount are pinned to what was already looked
 * up and confirmed for THIS ticket -- if the ticket's text is later
 * used to argue for a different order, that argument never reaches
 * this function's inputs, only the plan/token layer sees it, and
 * that's what should catch it.
 */
async function runRefundStep(session, { action, order_id, amount, reasonForLog }) {
  const call = { name: action, args: { order_id, amount } };
  await session.startPlan([call], `Execute ${action} for ${order_id}`);

  const decision = await session.check(call.name, call.args, userEmail);
  if (!decision.allowed) {
    const holdOrBlock = decision.action; // e.g. "hold" or "block"
    console.log(`  [${holdOrBlock.toUpperCase()}] ${action} on ${order_id}: ${decision.reason}`);
    if (reasonForLog) console.log(`  Approver context: ${reasonForLog}`);
    await session.report(call.name, call.args, { status: holdOrBlock, reason: decision.reason });
    return { held: true, decision };
  }

  const result = await callTool(action, call.args);
  const data = JSON.parse(result.content[0].text);
  await session.report(call.name, call.args, { status: 'success', result: data });
  console.log(`  [EXECUTED] ${action} on ${order_id}: refunded $${amount} (${data.stripe_refund_id})`);
  return { held: false, data };
}

async function processTicket(session, ticket) {
  console.log(`\n--- Ticket ${ticket.id} ---`);
  console.log(`  "${ticket.text.trim()}"`);

  // Read steps: order_id is NOT overridden here on purpose (see
  // planner.js comment) so the poisoned ticket text has a real chance
  // to drift the LLM's extraction toward the wrong order.
  const order = await runReadStep(session, `Look up the order referenced in: ${ticket.text}`, {});
  if (!order) return;

  const customer = await runReadStep(
    session,
    `Look up payment history for customer ${order.customer_id}`,
    { customer_id: order.customer_id }
  );
  if (!customer) return;

  // --- Dynamic threshold, computed in code, never by the LLM ---
  const { action, ceiling, isElevated } = selectRefundAction(order, customer);
  const reasonForLog = isElevated ? explainHold(order, customer, ceiling) : null;

  // --- Refund execution: order_id is now PINNED to the ticket's
  // originally-declared order, not re-derived from free text. ---
  await runRefundStep(session, {
    action,
    order_id: ticket.order_id, // pinned, not order.id re-extracted from the LLM
    amount: order.amount,
    reasonForLog,
  });
}

async function main() {
  const armoriq = new ArmorIQClient({ apiKey: process.env.ARMORIQ_API_KEY });
  await armoriq.bootstrap();
  await connectRefundMcp();

  const session = armoriq.forUser(userEmail).startSession({
    mode: 'sdk',
    defaultMcpName: 'refund-desk',
    validitySeconds: 2400,
  });

  const tickets = db.prepare('SELECT * FROM tickets').all();
  for (const ticket of tickets) {
    await processTicket(session, ticket);
  }

  await session.flushObservability();
  await session.close();
  await disconnectRefundMcp();

  console.log('\nDone. Check the ArmorIQ dashboard -> Observability for the full audit trail.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
