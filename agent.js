// Refund desk agent: one immutable, three-step ArmorIQ plan per ticket.
//
// The ticket record provides the canonical order binding when the plan is
// captured.  It is deliberately never substituted into an MCP invocation:
// every invocation uses the value returned by the preceding step.  Therefore,
// a poisoned LLM extraction is presented to ArmorIQ as-is and fails the signed
// plan instead of being silently corrected by application code.

import 'dotenv/config';
import Database from 'better-sqlite3';
import { ArmorIQClient } from '@armoriq/sdk';
import { connectRefundMcp, callTool, disconnectRefundMcp } from './mcp.js';
import { planWithLlm } from './planner.js';
import { selectRefundAction, explainHold } from './policy.js';

const db = new Database(process.env.DB_PATH || './db/refunds.db');
const userEmail = process.env.USER_EMAIL;
const APPROVAL_WAIT_SECONDS = 30 * 60;

function parseToolResult(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('MCP tool returned no text result.');
  return JSON.parse(text);
}

function assertToolArguments(call, required) {
  if (!call?.args || typeof call.args !== 'object') {
    throw new Error(`Planner returned invalid arguments for ${call?.name ?? 'unknown tool'}.`);
  }
  for (const key of required) {
    if (call.args[key] === undefined || call.args[key] === null || call.args[key] === '') {
      throw new Error(`Planner omitted ${key} for ${call.name}.`);
    }
  }
}

function captureTicketPlan(session, ticket) {
  // This is the trusted ticket-to-order binding recorded at intake.  We only
  // use it to declare the signed plan; the runtime calls below use LLM/MCP
  // outputs, never ticket.order_id.  Do not read ticket.customer_id here.
  const expectedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.order_id);
  if (!expectedOrder) throw new Error(`Ticket ${ticket.id} references missing order ${ticket.order_id}.`);
  const expectedCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(expectedOrder.customer_id);
  if (!expectedCustomer) throw new Error(`Order ${expectedOrder.id} references a missing customer.`);

  const expectedRefund = selectRefundAction(expectedOrder, expectedCustomer);
  const calls = [
    { name: 'get_order', args: { order_id: expectedOrder.id } },
    { name: 'check_payment_history', args: { customer_id: expectedCustomer.id } },
    {
      name: expectedRefund.action,
      args: { order_id: expectedOrder.id, amount: expectedOrder.amount },
    },
  ];

  return session.startPlan(calls, `Resolve refund ticket ${ticket.id}: ${ticket.text}`);
}

async function checkWithApproval(session, call, approverContext) {
  let decision = await session.check(call.name, call.args, userEmail);
  if (decision.allowed) return decision;

  const holdOrBlock = decision.action;
  console.log(`  [${holdOrBlock.toUpperCase()}] ${call.name}: ${decision.reason ?? 'policy denied action'}`);
  if (approverContext) console.log(`  Approver context: ${approverContext}`);

  // `result` is persisted in the ArmorIQ report payload, so the dashboard
  // carries the plain-English reason the approver needs, not just the terminal.
  await session.report(call.name, call.args, {
    status: holdOrBlock,
    reason: decision.reason,
    approver_context: approverContext,
    delegation_id: decision.delegationId,
  }, { status: 'failed', errorMessage: approverContext ?? decision.reason });

  if (holdOrBlock !== 'hold' || !decision.delegationId) return decision;

  console.log('  Waiting for ArmorIQ dashboard approval...');
  const outcome = await session.awaitApproval(decision.delegationId, {
    timeout: APPROVAL_WAIT_SECONDS,
    interval: 5,
    userEmail,
  });
  if (outcome !== 'approved') {
    console.log(`  Approval ${outcome}; refund was not executed.`);
    return decision;
  }

  // Approval changes policy state, but we still re-run the exact signed-plan
  // check before the local MCP call. This stays fail-closed if the token aged
  // out while a human was reviewing the request.
  decision = await session.check(call.name, call.args, userEmail);
  if (!decision.allowed) {
    console.log(`  [${decision.action.toUpperCase()}] approval did not authorize retry: ${decision.reason}`);
  }
  return decision;
}

async function runReadStep(session, goal, overrides, allowedTools, approverContext) {
  const [call] = await planWithLlm(goal, overrides, allowedTools);
  assertToolArguments(call, call.name === 'get_order' ? ['order_id'] : ['customer_id']);

  const decision = await checkWithApproval(session, call, approverContext);
  if (!decision.allowed) return null;

  const data = parseToolResult(await callTool(call.name, call.args));
  await session.report(call.name, call.args, data, { status: data.error ? 'failed' : 'success' });
  return data.error ? null : data;
}

async function runRefundStep(session, { action, order_id, amount, reasonForLog }) {
  const call = { name: action, args: { order_id, amount } };
  const decision = await checkWithApproval(session, call, reasonForLog);
  if (!decision.allowed) return { held: decision.action === 'hold', decision };

  const data = parseToolResult(await callTool(call.name, call.args));
  await session.report(call.name, call.args, data, { status: data.error ? 'failed' : 'success' });
  if (data.error) throw new Error(`${call.name} failed: ${data.message ?? data.error}`);
  console.log(`  [EXECUTED] ${action} on ${order_id}: refunded $${amount} (${data.stripe_refund_id})`);
  return { held: false, data };
}

async function processTicket(session, ticket) {
  console.log(`\n--- Ticket ${ticket.id} ---`);
  console.log(`  "${ticket.text.trim()}"`);

  // Exactly one capture for this ticket: read order, read customer, refund.
  // startPlan signs all three calls before any external action can run.
  await captureTicketPlan(session, ticket);

  const order = await runReadStep(
    session,
    `Look up the order referenced in: ${ticket.text}`,
    {},
    ['get_order']
  );
  if (!order) return;

  const customer = await runReadStep(
    session,
    `Look up payment history for customer ${order.customer_id}`,
    { customer_id: order.customer_id },
    ['check_payment_history']
  );
  if (!customer) return;

  const { action, ceiling, isElevated } = selectRefundAction(order, customer);
  const reasonForLog = isElevated ? explainHold(order, customer, ceiling) : null;

  // IMPORTANT: this remains the LLM-driven lookup result, not ticket.order_id.
  // Any poisoned order id therefore reaches ArmorIQ's signed-plan check.
  await runRefundStep(session, {
    action,
    order_id: order.id,
    amount: order.amount,
    reasonForLog,
  });
}

async function main() {
  if (!userEmail) throw new Error('USER_EMAIL is required for per-user ArmorIQ enforcement.');

  const armoriq = new ArmorIQClient({ apiKey: process.env.ARMORIQ_API_KEY });
  let session;
  let mcpConnected = false;
  try {
    await armoriq.bootstrap();
    await connectRefundMcp();
    mcpConnected = true;

    session = armoriq.forUser(userEmail).startSession({
      mode: 'sdk',
      defaultMcpName: 'refund-desk',
      llm: 'gemini-3.6-flash',
      // Must exceed the 30-minute dashboard approval poll plus retry time.
      validitySeconds: 2400,
    });

    const tickets = db.prepare('SELECT * FROM tickets').all();
    for (const ticket of tickets) {
      try {
        await processTicket(session, ticket);
      } catch (error) {
        console.error(`Ticket ${ticket.id} failed:`, error);
      }
    }
  } finally {
    if (session) {
      await session.flushObservability();
      await session.close();
    }
    if (mcpConnected) await disconnectRefundMcp();
    armoriq.close();
  }

  console.log('\nDone. Check the ArmorIQ dashboard -> Observability for the full audit trail.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
