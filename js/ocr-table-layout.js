// Coordinate-only reconstruction for the three-column Ant Fortune holdings
// list.  It deliberately has no DOM, storage, image, or network dependency so
// an OCR engine can pass its recognised tokens straight to this module.
//
// The module is conservative by design:
// - only a caller-provided catalog matcher can create a fund-name anchor;
// - values are parsed only when the whole OCR token is a number;
// - absent values remain null (they are never converted to zero);
// - rows without a verified table schema are preview-only, never importable.

const FIELD_KEYS = Object.freeze([
  'holdingAmount',
  'dailyProfit',
  'holdingProfit',
  'holdingProfitRate'
]);

const DEFAULT_COLUMN_RATIOS = Object.freeze({
  leftMax: 0.53,
  middleMin: 0.46,
  middleMax: 0.78,
  rightMin: 0.74
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u200b\ufeff]/g, '')
    .trim();
}

function canonicalText(value) {
  return cleanText(value)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，]/g, ',')
    .replace(/[．。]/g, '.')
    .replace(/[％]/g, '%');
}

function median(values, fallback = 18) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return fallback;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function tokenCenter(token) {
  return {
    x: (token.x0 + token.x1) / 2,
    y: (token.y0 + token.y1) / 2
  };
}

function compareTokens(left, right) {
  return left.y0 - right.y0 || left.x0 - right.x0 || left.sourceIndex - right.sourceIndex;
}

function scoreOf(token) {
  return Number.isFinite(token.score) ? token.score : Number.NEGATIVE_INFINITY;
}

function intersectionOverMinArea(left, right) {
  const width = Math.max(0, Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0));
  const height = Math.max(0, Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0));
  if (!width || !height) return 0;
  const intersection = width * height;
  const minimum = Math.min((left.x1 - left.x0) * (left.y1 - left.y0), (right.x1 - right.x0) * (right.y1 - right.y0));
  return minimum > 0 ? intersection / minimum : 0;
}

function looksLikeNearbyDuplicate(left, right) {
  if (left.key !== right.key) return false;
  if (intersectionOverMinArea(left, right) >= 0.55) return true;
  const leftCenter = tokenCenter(left);
  const rightCenter = tokenCenter(right);
  const averageWidth = ((left.x1 - left.x0) + (right.x1 - right.x0)) / 2;
  const averageHeight = ((left.y1 - left.y0) + (right.y1 - right.y0)) / 2;
  return Math.abs(leftCenter.x - rightCenter.x) <= Math.max(4, averageWidth * 0.16) &&
    Math.abs(leftCenter.y - rightCenter.y) <= Math.max(4, averageHeight * 0.75);
}

/**
 * Validate the minimal coordinate shape emitted by a detector. Invalid OCR
 * fragments are skipped rather than assigned guessed coordinates.
 */
export function normalizeOcrTableTokens(tokens = []) {
  if (!Array.isArray(tokens)) return [];
  const normalized = [];
  for (let sourceIndex = 0; sourceIndex < tokens.length; sourceIndex += 1) {
    const source = tokens[sourceIndex] || {};
    const text = cleanText(source.text ?? source.value);
    const x0 = finite(source.x0 ?? source.left ?? source.x);
    const y0 = finite(source.y0 ?? source.top ?? source.y);
    const x1 = finite(source.x1 ?? source.right);
    const y1 = finite(source.y1 ?? source.bottom);
    if (!text || x0 == null || y0 == null || x1 == null || y1 == null || x1 <= x0 || y1 <= y0) continue;
    normalized.push({
      text,
      key: canonicalText(text),
      x0,
      y0,
      x1,
      y1,
      score: finite(source.score ?? source.confidence),
      sourceIndex
    });
  }
  return normalized.sort(compareTokens);
}

/**
 * Collapse only spatially-overlapping repeated tokens, which is how a sliding
 * long-image OCR seam appears. Identical text in two different table rows is
 * intentionally retained.
 */
export function dedupeOcrTableTokens(tokens = []) {
  const ordered = normalizeOcrTableTokens(tokens);
  const selected = [];
  for (const token of ordered) {
    const duplicateIndex = selected.findIndex(candidate => looksLikeNearbyDuplicate(candidate, token));
    if (duplicateIndex < 0) {
      selected.push(token);
      continue;
    }
    const existing = selected[duplicateIndex];
    if (scoreOf(token) > scoreOf(existing)) selected[duplicateIndex] = token;
  }
  return selected.sort(compareTokens);
}

/**
 * Parse a complete numeric OCR token. Unlike permissive text parsing, this
 * refuses strings such as "收益-12.3" and never corrects uncertain characters.
 */
export function parseStrictOcrNumber(value, kind = 'amount') {
  const source = canonicalText(value);
  if (!source) return null;
  const amountPattern = /^[¥￥]?[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d{1,2})?$/;
  const percentPattern = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d{1,2})?%$/;
  const pattern = kind === 'percent' ? percentPattern : amountPattern;
  if (!pattern.test(source)) return null;
  const normalized = source.replace(/^[¥￥]/, '').replace(/%$/, '').replace(/,/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function isNumberToken(token) {
  return parseStrictOcrNumber(token.text, 'amount') != null || parseStrictOcrNumber(token.text, 'percent') != null;
}

function isNameLikeToken(token) {
  if (isNumberToken(token)) return false;
  const text = canonicalText(token.text);
  if (!text || /^(?:名称|基金名称|金额|昨日收益|今日收益|持有收益|收益率|全部|持有|我的持有)$/.test(text)) return false;
  return /[\u3400-\u9fffA-Za-z]/.test(text);
}

function groupTokensByLine(tokens, typicalHeight) {
  const tolerance = Math.max(6, typicalHeight * 0.75);
  const lines = [];
  for (const token of [...tokens].sort(compareTokens)) {
    const center = tokenCenter(token).y;
    const last = lines[lines.length - 1];
    if (last && Math.abs(center - last.center) <= tolerance) {
      last.tokens.push(token);
      last.center = (last.center * (last.tokens.length - 1) + center) / last.tokens.length;
      last.y0 = Math.min(last.y0, token.y0);
      last.y1 = Math.max(last.y1, token.y1);
      continue;
    }
    lines.push({ tokens: [token], center, y0: token.y0, y1: token.y1 });
  }
  return lines.map((line, index) => ({
    ...line,
    index,
    tokens: [...line.tokens].sort((left, right) => left.x0 - right.x0 || left.sourceIndex - right.sourceIndex)
  }));
}

function headerFlags(tokens) {
  const text = canonicalText(tokens.map(token => token.text).join(' '));
  return {
    name: /(?:基金)?名称/.test(text),
    middle: /金额.*(?:昨日|今日).*收益|(?:昨日|今日).*收益.*金额/.test(text),
    right: /(?:持有|累计)?收益.*率|率.*(?:持有|累计)?收益/.test(text)
  };
}

function detectHeader(tokens, typicalHeight) {
  const lines = groupTokensByLine(tokens, typicalHeight);
  let best = null;
  for (const line of lines) {
    const flags = headerFlags(line.tokens);
    const count = Number(flags.name) + Number(flags.middle) + Number(flags.right);
    if (!best || count > best.count || (count === best.count && line.y0 < best.y0)) {
      best = { ...line, flags, count };
    }
  }
  if (!best) {
    return { reliable: false, name: false, middle: false, right: false, y0: null, y1: null };
  }
  return {
    reliable: best.count === 3,
    ...best.flags,
    y0: best.y0,
    y1: best.y1
  };
}

function deriveColumns(imageWidth) {
  const width = finite(imageWidth, 0);
  return {
    imageWidth: width,
    left: { x0: 0, x1: width * DEFAULT_COLUMN_RATIOS.leftMax },
    middle: { x0: width * DEFAULT_COLUMN_RATIOS.middleMin, x1: width * DEFAULT_COLUMN_RATIOS.middleMax },
    right: { x0: width * DEFAULT_COLUMN_RATIOS.rightMin, x1: width }
  };
}

function columnForToken(token, columns) {
  const center = tokenCenter(token).x;
  if (center >= columns.right.x0) return 'right';
  if (center >= columns.middle.x0 && center <= columns.middle.x1) return 'middle';
  if (center <= columns.left.x1) return 'left';
  return null;
}

function matchIsUsable(match) {
  if (!match || Array.isArray(match)) return false;
  if (match.status && match.status !== 'matched') return false;
  if (match.matched === false) return false;
  const code = match.code ?? match.fund?.code;
  const name = match.name ?? match.fund?.name;
  return /^\d{6}$/.test(String(code || '')) || Boolean(cleanText(name));
}

function callMatcher(matchFund, text, tokens, bbox) {
  if (typeof matchFund !== 'function') return null;
  try {
    const match = matchFund(text, { tokens, bbox });
    return matchIsUsable(match) ? match : null;
  } catch {
    // A catalog lookup failure must leave this preview row absent instead of
    // turning arbitrary OCR prose into an import candidate.
    return null;
  }
}

function unionBox(tokens) {
  return {
    x0: Math.min(...tokens.map(token => token.x0)),
    y0: Math.min(...tokens.map(token => token.y0)),
    x1: Math.max(...tokens.map(token => token.x1)),
    y1: Math.max(...tokens.map(token => token.y1))
  };
}

function tokenCanContinueFundName(sequence, next, typicalHeight) {
  const first = sequence[0];
  const previous = sequence[sequence.length - 1];
  const previousCenter = tokenCenter(previous);
  const nextCenter = tokenCenter(next);
  const sameLine = Math.abs(nextCenter.y - previousCenter.y) <= typicalHeight * 0.85;
  if (sameLine) {
    const horizontalGap = next.x0 - previous.x1;
    return next.x0 >= first.x0 - typicalHeight && horizontalGap <= typicalHeight * 5;
  }

  const sequenceBottom = Math.max(...sequence.map(token => token.y1));
  const verticalGap = next.y0 - sequenceBottom;
  const verticalSpan = next.y1 - Math.min(...sequence.map(token => token.y0));
  return nextCenter.y > previousCenter.y &&
    verticalGap >= -typicalHeight * 0.5 && verticalGap <= typicalHeight * 2 &&
    verticalSpan <= typicalHeight * 4.8 &&
    Math.abs(next.x0 - first.x0) <= typicalHeight * 3;
}

function buildNameCandidates(tokens, columns, typicalHeight) {
  const nameTokens = tokens
    .filter(token => columnForToken(token, columns) === 'left' && isNameLikeToken(token))
    .sort(compareTokens);
  const candidates = [];
  for (let index = 0; index < nameTokens.length; index += 1) {
    const sequence = [nameTokens[index]];
    candidates.push({ tokens: [...sequence], text: sequence[0].text });
    // Paddle may split one visual fund name into several same-line boxes and
    // another wrapped line.  Build bounded local sequences instead of joining
    // the entire left column; the geometric guard prevents crossing a normal
    // record gap or an advertisement.
    for (let offset = 1; offset < 4 && index + offset < nameTokens.length; offset += 1) {
      const next = nameTokens[index + offset];
      if (!tokenCanContinueFundName(sequence, next, typicalHeight)) break;
      sequence.push(next);
      candidates.push({
        tokens: [...sequence],
        text: sequence.map(token => token.text).join('')
      });
    }
  }
  return candidates.sort((left, right) => left.tokens[0].y0 - right.tokens[0].y0 ||
    right.tokens.length - left.tokens.length || right.text.length - left.text.length || left.tokens[0].sourceIndex - right.tokens[0].sourceIndex);
}

function findAnchors(tokens, columns, typicalHeight, matchFund) {
  const candidates = buildNameCandidates(tokens, columns, typicalHeight);
  const used = new Set();
  const anchors = [];
  for (const candidate of candidates) {
    if (candidate.tokens.some(token => used.has(token.sourceIndex))) continue;
    const bbox = unionBox(candidate.tokens);
    const match = callMatcher(matchFund, candidate.text, candidate.tokens, bbox);
    if (!match) continue;
    candidate.tokens.forEach(token => used.add(token.sourceIndex));
    anchors.push({
      text: candidate.text,
      tokens: candidate.tokens,
      bbox,
      match,
      score: median(candidate.tokens.map(scoreOf).filter(Number.isFinite), null)
    });
  }
  return anchors.sort((left, right) => left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0);
}

function numericEvidence(tokens, column) {
  return tokens
    .filter(token => columnForToken(token, column.columns) === column.name)
    .map(token => {
      const percent = parseStrictOcrNumber(token.text, 'percent');
      const amount = percent == null ? parseStrictOcrNumber(token.text, 'amount') : null;
      return percent == null && amount == null ? null : {
        token,
        kind: percent == null ? 'amount' : 'percent',
        value: percent == null ? amount : percent
      };
    })
    .filter(Boolean)
    .sort((left, right) => compareTokens(left.token, right.token));
}

function numericCenter(item) {
  return tokenCenter(item.token).y;
}

function closestUnused(items, targetY, maximumDistance, used) {
  let best = null;
  for (const item of items) {
    if (used.has(item.token.sourceIndex)) continue;
    const distance = Math.abs(numericCenter(item) - targetY);
    if (distance > maximumDistance) continue;
    if (!best || distance < best.distance) best = { item, distance };
  }
  return best && best.item;
}

// The Ant list always places a cumulative-return percentage on the lower
// visual line of a record. Use that percentage as a geometry anchor, then bind
// the nearest same-row amount and the two middle-column values. This recovers
// a preview row even when the small fund name is unreadable; its identity stays
// empty and the confirmation plan defaults it to skip.
function buildNumericRecords(tokens, columns, typicalHeight) {
  const middle = numericEvidence(tokens, { name: 'middle', columns });
  const right = numericEvidence(tokens, { name: 'right', columns });
  const middleAmounts = middle.filter(item => item.kind === 'amount');
  const rightAmounts = right.filter(item => item.kind === 'amount');
  const rightPercents = right.filter(item => item.kind === 'percent');
  const usedMiddle = new Set();
  const usedRight = new Set();
  const sameLineDistance = Math.max(10, typicalHeight * 1.4);
  const recordLineDistance = Math.max(46, typicalHeight * 4.5);
  const records = [];

  for (const percent of rightPercents) {
    const percentY = numericCenter(percent);
    const bottomMiddle = closestUnused(middleAmounts, percentY, sameLineDistance, usedMiddle);
    const topRightCandidates = rightAmounts.filter(item => numericCenter(item) <= percentY);
    const topRight = closestUnused(topRightCandidates, percentY, recordLineDistance, usedRight);
    if (!bottomMiddle || !topRight) continue;
    const topY = numericCenter(topRight);
    if (percentY - topY < typicalHeight * 0.45) continue;
    const topMiddle = closestUnused(middleAmounts, topY, sameLineDistance, usedMiddle);
    if (!topMiddle || topMiddle === bottomMiddle) continue;
    for (const item of [topMiddle, bottomMiddle]) usedMiddle.add(item.token.sourceIndex);
    for (const item of [topRight, percent]) usedRight.add(item.token.sourceIndex);
    const items = [topMiddle, bottomMiddle, topRight, percent];
    records.push({
      y0: Math.min(...items.map(item => item.token.y0)),
      y1: Math.max(...items.map(item => item.token.y1)),
      topY,
      middle: [topMiddle, bottomMiddle].sort((left, rightItem) => compareTokens(left.token, rightItem.token)),
      right: [topRight, percent].sort((left, rightItem) => compareTokens(left.token, rightItem.token)),
    });
  }
  return records.sort((left, rightItem) => left.topY - rightItem.topY);
}

function buildRowDrafts(tokens, anchors, columns, typicalHeight, imageWidth) {
  const records = buildNumericRecords(tokens, columns, typicalHeight);
  const unusedAnchors = new Set(anchors);
  const drafts = records.map(record => {
    let anchor = null;
    let distance = Infinity;
    for (const candidate of unusedAnchors) {
      const anchorY = (candidate.bbox.y0 + candidate.bbox.y1) / 2;
      const candidateDistance = Math.abs(anchorY - record.topY);
      if (candidateDistance < distance) {
        anchor = candidate;
        distance = candidateDistance;
      }
    }
    if (distance > Math.max(70, typicalHeight * 4.5)) anchor = null;
    if (anchor) unusedAnchors.delete(anchor);
    const y0 = Math.max(0, record.y0 - typicalHeight * 0.8);
    const y1 = record.y1 + typicalHeight * 0.8;
    return {
      name: anchor?.text || '',
      match: anchor?.match || null,
      bbox: anchor?.bbox || { x0: 0, y0, x1: columns.left.x1, y1 },
      band: { y0, y1 },
      _middle: record.middle,
      _right: record.right,
      _imageWidth: imageWidth
    };
  });

  for (const anchor of unusedAnchors) {
    const y0 = Math.max(0, anchor.bbox.y0 - typicalHeight * 0.55);
    const y1 = anchor.bbox.y1 + typicalHeight * 0.8;
    drafts.push({
      name: anchor.text,
      match: anchor.match,
      bbox: anchor.bbox,
      band: { y0, y1 },
      _middle: [],
      _right: [],
      _imageWidth: imageWidth
    });
  }

  return drafts
    .sort((left, rightItem) => left.band.y0 - rightItem.band.y0 || left.bbox.x0 - rightItem.bbox.x0)
    .map((row, index) => ({ ...row, index }));
}

function inspectGeometry(rows, imageWidth, columns) {
  const rowsWithBothColumns = rows.filter(row => row._middle.length && row._right.length).length;
  const middleTokenCount = rows.reduce((count, row) => count + row._middle.length, 0);
  const rightTokenCount = rows.reduce((count, row) => count + row._right.length, 0);
  const anchorCount = rows.length;
  // Two matched rows with values in both separated numeric columns is enough
  // to establish the visual grid independently of OCR text labels. It is still
  // preview-only until the header confirms the field semantics.
  const reliable = imageWidth >= 240 && anchorCount >= 2 && rowsWithBothColumns >= 2 &&
    middleTokenCount >= 2 && rightTokenCount >= 2 && columns.middle.x1 < columns.right.x1;
  return { reliable, anchorCount, rowsWithBothColumns, middleTokenCount, rightTokenCount };
}

function blankFields() {
  return Object.fromEntries(FIELD_KEYS.map(key => [key, null]));
}

function fieldsFromEvidence(row, allowed) {
  const fields = blankFields();
  if (!allowed) return fields;

  const middleAmounts = row._middle.filter(item => item.kind === 'amount');
  const rightAmounts = row._right.filter(item => item.kind === 'amount');
  const rightPercents = row._right.filter(item => item.kind === 'percent');

  // Assign only unambiguous visual slots. A third numeric token is evidence of
  // an ad/noise/merged row, so that column remains missing for human review.
  if (middleAmounts.length === 1) fields.holdingAmount = middleAmounts[0].value;
  if (middleAmounts.length === 2) {
    fields.holdingAmount = middleAmounts[0].value;
    fields.dailyProfit = middleAmounts[1].value;
  }
  if (rightAmounts.length === 1) fields.holdingProfit = rightAmounts[0].value;
  if (rightPercents.length === 1) fields.holdingProfitRate = rightPercents[0].value;
  return fields;
}

function publicNumericToken(item) {
  return {
    kind: item.kind,
    value: item.value,
    x0: item.token.x0,
    y0: item.token.y0,
    x1: item.token.x1,
    y1: item.token.y1,
    score: item.token.score
  };
}

function clusterNumericEvidence(items, typicalHeight) {
  const tolerance = Math.max(6, typicalHeight * 0.75);
  const clusters = [];
  for (const item of items) {
    const center = tokenCenter(item.token).y;
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(center - last.center) <= tolerance) {
      last.items.push(item);
      last.center = (last.center * (last.items.length - 1) + center) / last.items.length;
      last.y0 = Math.min(last.y0, item.token.y0);
      last.y1 = Math.max(last.y1, item.token.y1);
      continue;
    }
    clusters.push({ center, y0: item.token.y0, y1: item.token.y1, items: [item] });
  }
  return clusters.map(cluster => ({
    y0: cluster.y0,
    y1: cluster.y1,
    tokens: cluster.items.map(publicNumericToken)
  }));
}

function toPreviewRow(row, fields, semanticReliable, typicalHeight) {
  return {
    index: row.index,
    name: row.name,
    match: row.match,
    bbox: row.bbox,
    band: row.band,
    ...fields,
    semanticReliable,
    // Geometry-preserving numeric evidence lets a confirmation UI show why a
    // field is missing without retaining complete OCR source text.
    numericTokens: {
      middle: clusterNumericEvidence(row._middle, typicalHeight),
      right: clusterNumericEvidence(row._right, typicalHeight)
    },
    evidence: {
      middle: row._middle.length,
      right: row._right.length
    }
  };
}

/**
 * Rebuild a long, three-column holdings screenshot from OCR word/line boxes.
 *
 * `matchFund(name, context)` is the only identity authority. It must return a
 * single matched catalog entry (for example `{ status: 'matched', code }`) or
 * a falsey/ambiguous value. The result is a preview; callers must still ask for
 * true share quantities before any holding can be saved.
 */
export function reconstructOcrTableLayout({ tokens = [], imageWidth, matchFund } = {}) {
  const normalized = dedupeOcrTableTokens(tokens);
  const width = finite(imageWidth, 0);
  const typicalHeight = median(normalized.map(token => token.y1 - token.y0).filter(height => height > 0), 18);
  const columns = deriveColumns(width);
  const header = detectHeader(normalized, typicalHeight);
  const anchors = width > 0 ? findAnchors(normalized, columns, typicalHeight, matchFund) : [];
  const drafts = width > 0 ? buildRowDrafts(normalized, anchors, columns, typicalHeight, width) : [];
  const geometry = inspectGeometry(drafts, width, columns);
  const semanticReliable = header.reliable || geometry.reliable;
  const previewRows = drafts.map(row => toPreviewRow(row, fieldsFromEvidence(row, semanticReliable), semanticReliable, typicalHeight));
  const importable = header.reliable && geometry.reliable && previewRows.length > 0;

  return {
    schema: {
      reliable: header.reliable && geometry.reliable,
      importable,
      semanticReliable,
      header,
      geometry,
      columns
    },
    anchors: anchors.map(anchor => ({ text: anchor.text, bbox: anchor.bbox, match: anchor.match, score: anchor.score })),
    previewRows,
    // `rows` keeps the result convenient for consumers that do not distinguish
    // between a preview and its layout metadata. Both references are immutable
    // by convention; no data is persisted by this module.
    rows: previewRows,
    tokenCount: normalized.length
  };
}

export const reconstructOcrThreeColumnTable = reconstructOcrTableLayout;
