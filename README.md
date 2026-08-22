# ArmorIQ Refund Desk Agent

A single-agent refund desk demonstrating the `plan -> check -> execute -> report` loop using the ArmorIQ SDK. It handles Stripe-backed refunds and delegates high-risk or unauthorized actions appropriately.

## What it Demonstrates

1. **Autonomous Low-Risk Execution:** `ticket_1` processes a small refund for an established customer. The calculated Risk Score is low, so the agent is **Allowed** to execute it automatically.
2. **Dynamic Risk-Based Holds:** `ticket_2` attempts a large refund for a brand-new customer. A high Risk Score automatically flags this for manual review (`apply_refund_elevated`), placing it on **Hold** in the ArmorIQ dashboard.
3. **Cryptographic Intent Enforcement:** `ticket_3` is a prompt-injection trap attempting to redirect a refund to a different customer's order. ArmorIQ strictly enforces the original authorized plan, so this mismatch is **Blocked** regardless of financial risk.
4. **Token Expiry & Recovery:** `ticket_4` triggers a hold that is deliberately allowed to time out, demonstrating how the agent recovers by requesting a fresh token for the *exact same plan* without drifting.

## Setup

```bash
npm ci
cp .env.example .env   # Fill in ARMORIQ_API_KEY, STRIPE_SECRET_KEY, GEMINI_API_KEY, and AGENT_ID
npm run test:mcp       # Raw MCP protocol smoke test (no Stripe operation made)
npm run seed           # Creates db/refunds.db and seeds Stripe test charges
```

## Dashboard Setup

Before running the agent, configure the following in the ArmorIQ console:
1. **Register the MCP server**: Name it exactly `refund-desk`.
2. **Onboard an Agent**: Generate an Agent ID and paste it into your `.env` file (`AGENT_ID`).
3. **Write the Policy**:
   - Default enforcement action: `block`.
   - Allow: `get_order`, `check_payment_history`, `apply_refund_standard`.
   - Hold: `apply_refund_elevated` (requires manual approval).

## Run

```bash
npm start
```

When the script pauses on `ticket_2` and `ticket_4`, go to the ArmorIQ dashboard's **"Needs You"** tab to manually Approve or Reject the holds. The agent will automatically resume execution based on your decision.
