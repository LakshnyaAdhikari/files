// Computes a deterministic Refund Risk Score (0-100) per customer.
// The LLM never sees or decides this risk score; it only sees the permitted tool names.
// 
// High financial risk maps to a HOLD (manual review) rather than a BLOCK (intent mismatch).
// A high-risk refund is still a valid business intent, it just requires human authorization.
// A BLOCK is strictly reserved for cryptographic intent violations (e.g. prompt injections).

export function computeRiskScore(order, customer, refundAmount) {
  const amount = refundAmount || order.amount;
  const WEIGHT_AMOUNT = 0.4;
  const WEIGHT_BEHAVIOR = 0.3;
  const WEIGHT_VELOCITY = 0.3;

  if (!customer || customer.total_orders < 2 || customer.avg_order_value <= 0) {
    // New / Limited History Customer
    const ratio = amount / order.amount; 
    const velocity = customer ? (customer.prior_refund_count || 0) : 0;
    
    const HIGH_VALUE_THRESHOLD = 100; // conservative adjustment for new customers
    const historyPenalty = amount > HIGH_VALUE_THRESHOLD ? 50 : 0;
    
    const riskScore = Math.min(100, (ratio * 40) + (velocity * 20) + historyPenalty);
    return {
      riskScore,
      factors: { customer_type: 'new/limited_history', refund_ratio: ratio, velocity, history_penalty: historyPenalty }
    };
  } else {
    // Established Customer
    const amountRatio = amount / customer.avg_order_value; 
    const behaviorRatio = customer.prior_refund_count / customer.total_orders; 
    
    // We use a fixed recent date to emulate "recent" velocity deterministically in our seeded db context.
    const signup = new Date(customer.signup_date);
    const monthsSinceSignup = Math.max(1, (new Date().getTime() - signup.getTime()) / (1000 * 60 * 60 * 24 * 30));
    const velocity = customer.prior_refund_count / monthsSinceSignup;

    const scoreAmount = Math.min(100, amountRatio * 33.33); 
    const scoreBehavior = Math.min(100, behaviorRatio * 200); 
    const scoreVelocity = Math.min(100, velocity * 50); 

    const riskScore = Math.min(100, (scoreAmount * WEIGHT_AMOUNT) + (scoreBehavior * WEIGHT_BEHAVIOR) + (scoreVelocity * WEIGHT_VELOCITY));
    return {
      riskScore,
      factors: { customer_type: 'established', amount_ratio: amountRatio.toFixed(2), behavior_ratio: behaviorRatio.toFixed(2), velocity: velocity.toFixed(2) }
    };
  }
}

/**
 * Decides which tool name the agent's plan should declare for this refund.
 */
export function selectRefundAction(order, customer) {
  const { riskScore, factors } = computeRiskScore(order, customer);
  const HIGH_RISK_THRESHOLD = 70;
  
  const isElevated = riskScore >= HIGH_RISK_THRESHOLD;
  return {
    action: isElevated ? 'apply_refund_elevated' : 'apply_refund_standard',
    riskScore,
    isElevated,
    factors
  };
}

/**
 * Plain-English reason attached to every hold for the dashboard.
 */
export function explainHold(order, customer, riskScore) {
  return `Refund of $${order.amount} flagged as HIGH RISK (Score: ${Math.round(riskScore)}/100) -- held for manual review.`;
}
