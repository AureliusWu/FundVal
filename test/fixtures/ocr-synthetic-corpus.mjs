// Public fund identities plus independently authored synthetic accounting data.
// This is a pixel-input definition, not OCR output or a replacement recognizer.
const IDENTITIES = Object.freeze([
  ['000001', '华夏成长混合'], ['000011', '华夏大盘精选混合A'], ['000031', '华夏复兴混合A'],
  ['000041', '华夏全球股票(QDII)(人民币)'], ['000083', '汇添富消费行业混合'], ['000854', '鹏华养老产业股票'],
  ['001156', '申万菱信新能源汽车主题灵活配置混合A'], ['005827', '易方达蓝筹精选混合'],
  ['110011', '易方达优质精选混合(QDII)'], ['110022', '易方达消费行业股票'],
  ['161725', '招商中证白酒指数(LOF)A'], ['163406', '兴全合润混合A'],
  ['006228', '中欧医疗创新股票A'], ['006229', '中欧医疗创新股票C'],
]);
export const CORPUS_RELATIVE_DIRECTORY = 'test/fixtures/ocr';
export function makeSyntheticAlipayCorpus(catalog) {
  if (!Array.isArray(catalog)) throw new Error('Synthetic catalog required');
  for (const [code, name] of IDENTITIES) {
    if (!catalog.some(fund => fund.code === code && fund.name === name)) throw new Error('Public corpus identity changed');
  }
  const ambiguousName = '中欧医疗创新股票';
  const ambiguousCandidates = catalog.filter(fund => fund.name.startsWith(ambiguousName)
    && /^[A-Z]$/.test(fund.name.slice(ambiguousName.length))).map(fund => ({ code: fund.code, name: fund.name }));
  if (ambiguousCandidates.length < 2) throw new Error('Synthetic A/C ambiguity requires public alternatives');
  const round = value => Number(value.toFixed(2));
  const rows = [...IDENTITIES, [null, ambiguousName]].map(([code, name], index) => {
    const n = index + 1, amount = round(1000 + n * 137.11);
    const profit = n === 1 ? 0 : round((n % 2 === 0 ? -1 : 1) * (10 + n * 7.31));
    return { rowId: `synthetic-${String(n).padStart(2, '0')}`, code, name, top: 1370 + index * 520,
      holdingAmount: amount, dailyProfit: n === 1 ? 0 : round((n % 2 === 0 ? -1 : 1) * (n * 1.07 + 0.13)),
      holdingProfit: n === 5 ? null : profit,
      holdingProfitRate: n === 5 ? null : round(profit / (amount - profit) * 100),
      expectedAmbiguous: code === null, expectedDefaultSkip: code === null,
      allowedCandidateCodes: code === null ? ambiguousCandidates.map(fund => fund.code) : [code],
      seamCase: n === 1 ? 'top_and_bottom_numbers_straddle_first_core_boundary_1420' : null,
    };
  });
  return { schema: 1, corpusId: 'synthetic-alipay-1440x9317-v1', provenance: 'authored_synthetic_amounts_public_fund_identities_no_user_screenshot',
    width: 1440, height: 9317, fontFamily: 'Microsoft YaHei', nameFontPx: 46, numericFontPx: 50,
    unknownDisplay: '—', expectedCandidateCount: 15, requiredAutomaticMatches: 12,
    requiredWrongAutomaticMatches: 0, requiredAcClassMismatch: 0, ambiguousCandidates, rows };
}

// Intentionally self-contained for Playwright serialization. Rendering produces
// pixels/boxes from the authored definition BEFORE any OCR is invoked.
export async function renderSyntheticAlipayCorpus(corpus) {
  const canvas = document.createElement('canvas'); canvas.width = corpus.width; canvas.height = corpus.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const font = size => `${size}px "${corpus.fontFamily}", sans-serif`;
  ctx.fillStyle = '#f5f6f8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1677ff'; ctx.fillRect(0, 0, canvas.width, 640);
  ctx.fillStyle = '#ffffff'; ctx.font = font(76); ctx.fillText('支付宝', 74, 145);
  ctx.font = font(54); ctx.fillText('基金持有', 74, 270);
  ctx.font = font(40); ctx.fillText('合成回归样本 · 非真实账户', 74, 390);
  ctx.fillText('全部金额均为人工构造，仅用于本地测试', 74, 490);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(40, 740, 1360, 8190);
  ctx.fillStyle = '#1f2329'; ctx.font = font(54); ctx.fillText('我的持有', 80, 895);
  ctx.font = font(36); ctx.fillStyle = '#76808c'; ctx.fillText('全部', 80, 1015); ctx.fillText('偏股', 300, 1015);
  ctx.fillText('债券', 520, 1015); ctx.fillText('指数', 740, 1015); ctx.fillText('全球', 960, 1015);
  ctx.fillStyle = '#69727c'; ctx.font = font(38);
  ctx.fillText('名称', 80, 1200); ctx.fillText('金额/昨日收益', 720, 1200); ctx.fillText('持有收益/率', 1080, 1200);
  ctx.strokeStyle = '#dce1e8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(70, 1260); ctx.lineTo(1370, 1260); ctx.stroke();
  const format = (value, signed = false, percent = false) => {
    if (value === null) return corpus.unknownDisplay;
    return (signed && value >= 0 ? '+' : '') + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + (percent ? '%' : '');
  };
  const annotations = [];
  for (const row of corpus.rows) {
    const nameLines = []; let line = '';
    ctx.font = font(corpus.nameFontPx);
    for (const char of row.name) {
      if (line && ctx.measureText(line + char).width > 570) { nameLines.push(line); line = char; } else line += char;
    }
    if (line) nameLines.push(line);
    if (nameLines.length > 3) throw new Error('Synthetic name exceeds designed row');
    ctx.fillStyle = '#20252d';
    nameLines.forEach((text, index) => ctx.fillText(text, 80, row.top + 52 + index * 58));
    const boxes = {};
    const numeric = (key, value, right, baseline, signed = false, percent = false) => {
      const text = format(value, signed, percent); ctx.font = font(corpus.numericFontPx);
      ctx.fillStyle = value === null ? '#9098a3' : value < 0 ? '#00845b' : value > 0 && signed ? '#d53831' : '#262b33';
      const width = ctx.measureText(text).width; ctx.fillText(text, right - width, baseline);
      boxes[key] = { text, value, x0: right - width, y0: baseline - corpus.numericFontPx, x1: right, y1: baseline + 10 };
    };
    numeric('holdingAmount', row.holdingAmount, 1005, row.top + 52);
    numeric('dailyProfit', row.dailyProfit, 1005, row.top + 140, true);
    numeric('holdingProfit', row.holdingProfit, 1360, row.top + 52, true);
    numeric('holdingProfitRate', row.holdingProfitRate, 1360, row.top + 140, true, true);
    ctx.strokeStyle = '#e5e8ed'; ctx.beginPath(); ctx.moveTo(80, row.top + 390); ctx.lineTo(1360, row.top + 390); ctx.stroke();
    annotations.push({ ...row, nameLines, nameBox: { x0: 80, y0: row.top, x1: 650, y1: row.top + nameLines.length * 58 }, boxes });
  }
  ctx.fillStyle = '#76808c'; ctx.font = font(34); ctx.fillText('纯合成样本，不代表任何个人账户或投资建议', 80, 9150);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  canvas.width = canvas.height = 0;
  return { bytes, annotations };
}
