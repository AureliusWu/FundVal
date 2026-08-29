const FUND_CODE_PATTERN = /^\d{6}$/;

export function activeHoldingCodes(holdings) {
  const codes = [];
  const seen = new Set();
  for (const holding of Array.isArray(holdings) ? holdings : []) {
    const code = String(holding?.code ?? holding?.fundCode ?? '').trim();
    if (holding?.deleted === true || holding?.deletedAt || !FUND_CODE_PATTERN.test(code) || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

export function retainActiveFundData(holdings, fundsData) {
  const active = new Set(activeHoldingCodes(holdings));
  return (Array.isArray(fundsData) ? fundsData : []).filter(item => active.has(String(item?.code || '').trim()));
}
