// This implementation follows the session-level API pattern from the provided ArmorIQ reference
// implementation, while preserving the same core SDK concepts of plan authorization, intent 
// verification, policy hold, approval, and enforcement.

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

  const goal = `Resolve refund ticket ${ticket.id}: ${ticket.text}`;
  
  // 1. PLAN CREATION / CAPTURE
  // Our session plan creation/capture step represents the same authorization concept as the 
  // SDK's capture_plan(): the agent establishes what actions it is intending/authorized to perform.
  const explicitPlan = {
    steps: calls.map(c => ({
      mcp: 'refund-desk',
      action: c.name,
      params: c.args
    }))
  };
  
  // 2. TOKEN / AUTHORIZATION
  // The session's authorization/token state represents the authorization produced from that plan.
  // We explicitly persist this original plan so that if the token expires, we can request a fresh 
  // token for the *exact same plan* instead of allowing the agent to drift and authorize a new one.
  ticket.originalPlanCapture = session.client.capturePlan('gemini-3.6-flash', goal, explicitPlan);

  return session.startPlan(calls, goal);
}

async function checkWithApproval(session, call, approverContext, originalPlanCapture) {
  const handleDecision = async (dec) => {
    // Token Expiry Recovery
    if (!dec.allowed && dec.reason === 'token-expired') {
      console.log('  🟡 Expired authorization');
      console.log('    "The action is still the same, but the token expired."');
      console.log('    → refresh token (same tool + same arguments) → continue.');
      if (originalPlanCapture) {
        const freshToken = await session.client.getIntentToken(originalPlanCapture, session.currentTokenValue?.policy, session.validitySeconds);
        session.currentToken = freshToken;
      }
      return await session.check(call.name, call.args, userEmail);
    } 
    // 5. BLOCK / INTENT MISMATCH
    // When the requested tool/action/arguments no longer match the authorized plan, the action is 
    // stopped rather than executed. This is the important intent-enforcement behavior behind the 
    // SDK's invocation-time verification. We deliberately do NOT retry or recapture the plan here.
    else if (!dec.allowed && dec.reason && dec.reason.includes('tool-not-in-plan')) {
      console.log('  🔴 Intent drift');
      console.log('    "The agent is now trying something different."');
      console.log('    → block.');
    }
    return dec;
  };

  // 3. SESSION CHECK / ENFORCEMENT
  // Our session.check() is the enforcement boundary before the MCP tool executes.
  // Conceptually this corresponds to the SDK's invocation-time verification:
  // the requested tool + arguments are checked against the authorized plan before execution.
  let decision = await session.check(call.name, call.args, userEmail);
  decision = await handleDecision(decision);
  if (decision.allowed) return decision;

  const holdOrBlock = decision.action;
  if (holdOrBlock === 'hold' && decision.delegationId) {
    console.log('  🟠 Policy hold');
    console.log('    "The action is valid but requires human approval."');
    console.log('    → wait → approve → continue.');
  } else {
    console.log(`  [${holdOrBlock.toUpperCase()}] ${call.name}: ${decision.reason ?? 'policy denied action'}`);
  }

  if (approverContext) console.log(`  Approver context: ${approverContext}`);

  // 6. OBSERVABILITY
  // We record the enforcement decision and relevant action information here so that the ArmorIQ 
  // platform/trace can show what the agent attempted, what was allowed/held/blocked, and why.
  const isHold = holdOrBlock === 'hold';
  await session.report(call.name, call.args, {
    status: holdOrBlock,
    reason: decision.reason,
    approver_context: approverContext,
    delegation_id: decision.delegationId,
  }, { 
    status: isHold ? 'success' : 'failed', 
    errorMessage: isHold ? undefined : (approverContext ?? decision.reason),
    isDelegated: isHold
  });

  // IMPORTANT: Force-flush the trace to the backend BEFORE we hang on awaitApproval.
  // Otherwise, the dashboard won't know we connected or generated a hold!
  await session.flushObservability();

  if (holdOrBlock !== 'hold' || !decision.delegationId) return decision;

  // 4. HOLD / APPROVAL
  // Our session.awaitApproval / approval flow represents the human-gated enforcement behavior 
  // described by the SDK: a valid action can be held instead of automatically executed until 
  // an authorized human approves it. High financial risk maps to a HOLD rather than a BLOCK.
  console.log('  Waiting for ArmorIQ dashboard approval...');
  const outcome = await session.awaitApproval(decision.delegationId, {
    timeout: APPROVAL_WAIT_SECONDS,
    interval: 5,
    userEmail,
  });
  
  if (outcome !== 'approved') {
    console.log(`  Approval ${outcome}; refund was not executed.`);
    decision.outcome = outcome;
    return decision;
  }

  // The approval is final. Do not re-check the policy, or the backend will generate a new duplicate hold!
  decision.allowed = true;
  return decision;
}

async function runReadStep(session, goal, overrides, allowedTools, approverContext, originalPlanCapture) {
  const [call] = await planWithLlm(goal, overrides, allowedTools);
  assertToolArguments(call, call.name === 'get_order' ? ['order_id'] : ['customer_id']);

  const decision = await checkWithApproval(session, call, approverContext, originalPlanCapture);
  if (!decision.allowed) return null;

  // The MCP tool is executed ONLY after the ArmorIQ check allows it.
  const data = parseToolResult(await callTool(call.name, call.args));
  await session.report(call.name, call.args, data, { status: data.error ? 'failed' : 'success' });
  return data.error ? null : data;
}

async function runRefundStep(session, { action, order_id, amount, reasonForLog }, originalPlanCapture) {
  const call = { name: action, args: { order_id, amount } };
  const decision = await checkWithApproval(session, call, reasonForLog, originalPlanCapture);
  if (!decision.allowed) return { held: decision.action === 'hold', decision };

  // The MCP tool is executed ONLY after the ArmorIQ check allows it.
  const data = parseToolResult(await callTool(call.name, call.args));
  await session.report(call.name, call.args, data, { status: data.error ? 'failed' : 'success' });
  if (data.error) throw new Error(`${call.name} failed: ${data.message ?? data.error}`);
  console.log(`  [EXECUTED] ${action} on ${order_id}: refunded $${amount} (${data.stripe_refund_id})`);
  return { held: false, data };
}

async function processTicket(session, ticket) {
  console.log(`\n--- Ticket ${ticket.id} ---`);
  console.log(`  "${ticket.text.trim()}"`);

  await captureTicketPlan(session, ticket);

  const order = await runReadStep(
    session,
    `Look up the order referenced in: ${ticket.text}`,
    {},
    ['get_order'],
    undefined,
    ticket.originalPlanCapture
  );
  if (!order) return;

  const customer = await runReadStep(
    session,
    `Look up payment history for customer ${order.customer_id}`,
    { customer_id: order.customer_id },
    ['check_payment_history'],
    undefined,
    ticket.originalPlanCapture
  );
  if (!customer) return;

  const { action, riskScore, isElevated, factors } = selectRefundAction(order, customer);
  console.log(`  [RISK ASSESSMENT] Score: ${Math.round(riskScore)}/100. Factors: ${JSON.stringify(factors)}`);
  const reasonForLog = isElevated ? explainHold(order, customer, riskScore) : null;

  const res = await runRefundStep(session, {
    action,
    order_id: order.id,
    amount: order.amount,
    reasonForLog,
  }, ticket.originalPlanCapture);

  if (!res.decision) return;

  if (res.decision.allowed) {
    console.log(`\n  💬 [Ticket Resolved] Message to customer: "Your refund of $${order.amount} has been successfully processed."`);
  } else if (res.decision.action === 'block') {
    console.log(`\n  💬 [Ticket Escalated] Message to customer: "We are experiencing a system error processing your request. Your ticket has been escalated to our support team for manual review."`);
    console.log(`  🚨 [Internal Note] System error: Intent mismatch detected. Automated resolution aborted.`);
  } else if (res.decision.action === 'hold') {
    if (res.decision.outcome === 'rejected') {
      console.log(`\n  💬 [Ticket Resolved] Message to customer: "Refund denied unfortunately. If you are not satisfied, please feel free to escalate to xyzcustomercare@gmail.com."`);
    } else {
      console.log(`\n  💬 [Ticket Pending] Message to customer: "Your refund request requires further manual review. We will update you once a decision is made."`);
    }
  }
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
      validitySeconds: 2400,
    });

    const tickets = db.prepare('SELECT * FROM tickets').all();
    const TICKET_DELAY_MS = process.env.TICKET_DELAY_MS ? parseInt(process.env.TICKET_DELAY_MS, 10) : 60000;
    
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      console.log(`\n[QUEUE] Processing Ticket ${i + 1}/${tickets.length} (${ticket.id})...`);
      
      try {
        await processTicket(session, ticket);
        console.log(`[QUEUE] ${ticket.id} completed.`);
      } catch (error) {
        console.error(`[QUEUE] ${ticket.id} failed:`, error);
      }

      if (i < tickets.length - 1) {
        // Ticket pacing: Wait before processing the next ticket to avoid Gemini free-tier limits
        console.log(`[QUEUE] Waiting ${TICKET_DELAY_MS / 1000}s before processing next ticket to respect Gemini rate limits...`);
        await new Promise(resolve => setTimeout(resolve, TICKET_DELAY_MS));
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
