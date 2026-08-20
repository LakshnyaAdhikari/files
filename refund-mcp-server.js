// refund-mcp-server.js
//
// A minimal, self-contained MCP server for the refund desk domain.
// No official "refund desk" MCP exists, so this is the mock server the
// track rules explicitly permit -- enforcement is what's judged, not
// integration polish.
//
// Exposes four tools:
//   get_order(order_id)                 -- read-only, always allowed
//   check_payment_history(customer_id)  -- read-only, always allowed
//   apply_refund_standard(order_id, amount)   -- low-risk refund path
//   apply_refund_elevated(order_id, amount)   -- high-risk refund path
//
// Standard vs elevated are the SAME underlying action (issue a Stripe
// refund). They are exposed as two distinct tool names on purpose --
// the calling agent's policy.js decides which name to declare in its
// plan, based on a threshold computed in deterministic code, never by
// the LLM. That split is what lets the ArmorIQ dashboard policy hold
// "elevated" refunds without touching a single line of agent code.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import Stripe from 'stripe';
import 'dotenv/config';

const db = new Database(process.env.DB_PATH || './db/refunds.db');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const server = new Server(
  { name: 'refund-desk', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'get_order',
    description: 'Fetch an order by id (args: { order_id })',
  },
  {
    name: 'check_payment_history',
    description: 'Fetch a customer risk/history profile (args: { customer_id })',
  },
  {
    name: 'apply_refund_standard',
    description: 'Issue a low-risk refund (args: { order_id, amount })',
  },
  {
    name: 'apply_refund_elevated',
    description: 'Issue a refund requiring elevated approval (args: { order_id, amount })',
  },
];

server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));

server.setRequestHandler('tools/call', async (req) => {
  const { name, arguments: args } = req.params;
  const respond = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

  if (name === 'get_order') {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(args.order_id);
    if (!order) return respond({ error: 'order_not_found' });
    return respond(order);
  }

  if (name === 'check_payment_history') {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(args.customer_id);
    if (!c) return respond({ error: 'customer_not_found' });
    return respond(c);
  }

  if (name === 'apply_refund_standard' || name === 'apply_refund_elevated') {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(args.order_id);
    if (!order) return respond({ error: 'order_not_found' });

    // Real Stripe test-mode refund -- an actual reversible charge in
    // the sandbox, not a log line claiming it happened.
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_charge_id,
      amount: Math.round(Number(args.amount) * 100),
    });

    return respond({
      status: 'refunded',
      order_id: args.order_id,
      amount: args.amount,
      stripe_refund_id: refund.id,
      via_tool: name,
    });
  }

  return respond({ error: 'unknown_tool' });
});

const transport = new StdioServerTransport();
await server.connect(transport);
