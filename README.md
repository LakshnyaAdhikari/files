# ArmorIQ Refund Desk Agent

Single-agent refund desk built on the plan -> check -> execute -> report
loop from the ArmorIQ GitHub agent reference guide, adapted to a
Stripe-backed refund domain.

## What it demonstrates

1. **Routine refunds flow through untouched.** `ticket_1` is a small,
   low-risk refund for an established customer -- allowed automatically.
2. **Dynamic, code-computed threshold holds a large refund.**
   `ticket_2` is a first-time customer's $650 refund -- the ceiling is
   computed per-customer in `policy.js` (never a hardcoded global
   number, never something the LLM reasons about), routes to
   `apply_refund_elevated`, and should hold in the dashboard.
3. **Order-binding plan-conformance.** `ticket_3` contains an embedded
   instruction trying to redirect the refund to a different customer's
   order. This isn't caught by any threshold -- it has to be caught by
   the plan/token layer refusing to execute against an order that
   wasn't part of what was originally captured.

## Setup

```bash
npm ci
cp .env.example .env   # fill in ARMORIQ_API_KEY, STRIPE_SECRET_KEY (test mode), GEMINI_API_KEY
npm run test:mcp        # raw MCP protocol smoke test; no Stripe operation is made
npm run seed            # creates db/refunds.db and 3 real Stripe test-mode charges
```

## Before running: dashboard setup (do this in the ArmorIQ console)

1. **Register the MCP server**: name it `refund-desk` (the code assumes
   this exact name).
2. **Write the policy**:
   - Default enforcement action: `block`.
   - Allow: `get_order`, `check_payment_history`, `apply_refund_standard`.
   - Hold: `apply_refund_elevated` (requires manual approval).
3. Confirm the policy is applied to your org/API key before running.

## Run

```bash
npm start
```

Approve the held `ticket_2` refund from the dashboard. The running process
polls ArmorIQ for that specific delegation, re-checks the signed plan, and
then completes the Stripe refund without a second `npm start`.

Use `npm ci` on every demo machine. Do not copy `node_modules`: the native
`better-sqlite3` module must be installed for that machine's Node ABI.

## Demo verification

- **Verify `ticket_3` in the configured ArmorIQ organization.** Its initial
  LLM-directed lookup must be blocked or held because the captured plan binds
  the intake order (`order_C1`) while the poisoned lookup attempts `order_C2`.
  This requires the dashboard MCP registration and policy to be active.
- **Verify the approval window.** Leave ticket 2 pending for several minutes,
  approve it in the dashboard, and confirm the original `npm start` process
  retries its signed-plan check and creates exactly one Stripe refund.
