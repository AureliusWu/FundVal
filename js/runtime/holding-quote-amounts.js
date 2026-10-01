import { calculateHolding, resolveQuoteBaseNav } from '../calculator.js';
import { createValuationPeriod } from './valuation-period.js';
import { quoteIsUsable } from './quote-contract.js';

// Always project the current repository holding onto an unchanged source quote.
// Neither a cache nor a pending network refresh owns shares/cost.
export function holdingQuoteAmounts(quote, holding = {}, now = Date.now()) {
  const shares = holding.shares ?? 0;
  const cost = holding.cost ?? null;
  const period = createValuationPeriod(quote, { shares, now });
  const trusted = quoteIsUsable(quote) ? quote : null;
  const amounts = calculateHolding(shares, cost, trusted?.value, resolveQuoteBaseNav({}, trusted));
  return { shares, cost, period, today_profit: period.profitAmount,
    curr_value: amounts.value, total_profit: amounts.totalProfit, total_profit_rate: amounts.totalProfitRate };
}
