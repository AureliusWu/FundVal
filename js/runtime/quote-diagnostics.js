export function renderQuoteDiagnostics(presentation, esc) {
  var sourceTime = presentation.sourceTimeLabel !== '--'
    ? presentation.sourceTimeLabel
    : (presentation.officialNavDate || '--');
  var rows = [
    ['显示含义', presentation.kindLabel],
    ['收益区间', presentation.periodDatesLabel],
    ['收益含义', presentation.periodLabel],
    ['数据等级', presentation.statusLabel],
    ['源时间', sourceTime],
    ['获取时间', presentation.fetchedTimeLabel],
    ['数据来源', presentation.sourceLabel],
    ['市场', presentation.marketLabel],
  ];
  if (presentation.cacheLabel) rows.push(['缓存状态', presentation.cacheLabel]);
  if (presentation.originalSourceLabel) rows.push(['原始来源', presentation.originalSourceLabel]);
  if (presentation.coverageLabel != null) rows.push(['覆盖率', presentation.coverageLabel]);
  if (presentation.confidenceLabel != null) rows.push(['置信度', presentation.confidenceLabel]);
  if (presentation.targetNavLabel) rows.push(['目标净值', presentation.targetNavLabel]);
  if (presentation.modelVersion) rows.push(['模型版本', presentation.modelVersion]);
  rows.push(['状态说明', presentation.reasonSummary]);

  return '<section class="quote-diagnostics" aria-label="数据说明">'
    + '<div class="quote-diagnostics-title">数据说明</div>'
    + '<div class="quote-diagnostics-grid">'
    + rows.map(function(row) {
      return '<div class="quote-diagnostics-row"><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong></div>';
    }).join('')
    + '</div></section>';
}
