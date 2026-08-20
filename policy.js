// This is the "dynamic, not hardcoded" piece. There is no flat
// `if (amount > 500)` anywhere in this codebase. The routing threshold
// is computed per-customer from real signal, and the LLM never sees
// or decides this comparison -- it only ever sees the two possible
// tool names, never the logic that picks between them. That's what
// keeps this un-jailbreakable: a prompt injection can talk the agent
// into *wanting* to call apply_refund_standard, but it can't talk this
// function into returning a different answer, because it never runs
// inside the LLM's reasoning at all.

/**
 * Computes a per-customer risk-adjusted refund ceiling below which a
 * refund is considered routine.
 *
 * First-time / low-history customers get a low ceiling regardless of
 * amount, because there's no track record to trust yet. Established
 * customers get a ceiling relative to their own historical spend, not
 * an arbitrary global number -- a $600 refund is business-as-usual for
 * someone who orders $2,000/month and mildly alarming for someone on
 * their first order.
 */
export function computeCeiling(customer) {
  const NEW_CUSTOMER_CEILING = 50; // no history yet -> stay conservative
  const MULTIPLIER = 3; // routine refunds can run up to 3x avg order value

  if (!customer || customer.total_orders < 2) {
    return NEW_CUSTOMER_CEILING;
  }
  const avg = Number(customer.avg_order_value);
  if (!Number.isFinite(avg) || avg <= 0) return NEW_CUSTOMER_CEILING;
  return avg * MULTIPLIER;
}

/**
 * Decides which tool name the agent's plan should declare for this
 * refund. This return value -- not a number -- is the only thing that
 * ever reaches the plan/LLM layer.
 */
export function selectRefundAction(order, customer) {
  const ceiling = computeCeiling(customer);
  const isElevated = order.amount > ceiling;
  return {
    action: isElevated ? 'apply_refund_elevated' : 'apply_refund_standard',
    ceiling,
    isElevated,
  };
}

/**
 * Cheap, high-value addition: a one-line plain-English reason attached
 * to every hold, so the human approver isn't just looking at a bare
 * amount -- they're a user of this system too.
 */
export function explainHold(order, customer, ceiling) {
  if (!customer || customer.total_orders < 2) {
    return `First-time or low-history customer (${customer?.total_orders ?? 0} prior orders) -- refund of $${order.amount} held for manual review.`;
  }
  return `Refund of $${order.amount} exceeds this customer's routine ceiling of $${ceiling.toFixed(2)} (3x their $${customer.avg_order_value} average order) -- held for manual review.`;
}
