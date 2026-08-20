# ArmorIQ Refund Desk Agent

Single-agent refund desk built on the plan -> check -> execute -> report
loop from the ArmorIQ GitHub agent reference guide, adapted to a
Stripe-backed refund domain.

## What it demonstrates

1. **Routine refunds flow through untouched.** `ticket_1` is a small,
   low-risk refund for an established customer -- allowed automatically.
2. **Dynamic, code-computed threshold holds a large refund.**
   `ticket_2` is a first-time customer's $650 refund -- the ceiling is
   computed per-customer in `src/policy.js` (never a hardcoded global
   number, never something the LLM reasons about), routes to
   `apply_refund_elevated`, and should hold in the dashboard.
3. **Order-binding plan-conformance.** `ticket_3` contains an embedded
   instruction trying to redirect the refund to a different customer's
   order. This isn't caught by any threshold -- it has to be caught by
   the plan/token layer refusing to execute against an order that
   wasn't part of what was originally captured.

## Setup

```bash
npm install
cp .env.example .env   # fill in ARMORIQ_API_KEY, STRIPE_SECRET_KEY (test mode), GEMINI_API_KEY
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

Approve the held `ticket_2` refund from the dashboard, then re-run or
extend the agent to poll/`await_approval` and confirm it resumes and
completes the Stripe refund.

## Open questions to verify before demo day

- **Does `session.check()` evaluate on `args` values (e.g. amount), or
  only on tool/MCP name?** This build assumes name-based policy and
  routes around it via two tool names (`apply_refund_standard` /
  `apply_refund_elevated`) decided in code. If value-based rules exist,
  that's a cleaner alternative -- test both.
- **Does the SDK actually reject `ticket_3`'s order mismatch?** The
  reference repo's session pattern is coarse (one call at a time).
  Whether it holds a full multi-step plan hash the way `agent.js`
  assumes (order_id pinned at capture time, re-checked at execute time)
  needs to be run and watched, not assumed. If it doesn't reject it
  out of the box, the fallback is to bind order_id into the plan's
  step arguments explicitly at `startPlan()` time so the executed call
  must match it exactly.
- **`ArmorIQClient`, `bootstrap()`, `forUser().startSession()` method
  names** are taken directly from the reference repo -- confirm no
  version drift against your installed `@armoriq/sdk` version.
