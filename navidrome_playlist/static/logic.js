const DEFAULT_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function compareValues(a, b, type, collator = DEFAULT_COLLATOR) {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return emptyA && emptyB ? 0 : emptyA ? 1 : -1;
  if (type === 'number') return Number(a) - Number(b);
  if (type === 'date') {
    const left = String(a), right = String(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return collator.compare(String(a), String(b));
}

function normalizedSortKeys(sort) {
  if (Array.isArray(sort)) return sort.filter(item => item?.key && (item.direction === 'asc' || item.direction === 'desc'));
  if (sort?.key && (sort.direction === 'asc' || sort.direction === 'desc')) return [{ ...sort }];
  return Object.entries(sort || {})
    .filter(([, direction]) => direction === 'asc' || direction === 'desc')
    .map(([key, direction]) => ({ key, direction }));
}

function membershipValues(memberships, key, sortKey) {
  if (sortKey.membership) return sortKey.membership;
  return memberships?.[key] || memberships?.[key.slice('playlist:'.length)] || {};
}

function isEmpty(value) { return value === null || value === undefined || value === ''; }

export function sortRows(rows, sort, fieldsByKey = {}, memberships = {}) {
  const sortKeys = normalizedSortKeys(sort);
  if (!sortKeys.length) return [...rows];
  const collator = DEFAULT_COLLATOR;
  const preparedKeys = sortKeys.map(sortKey => {
    const field = fieldsByKey[sortKey.key] || {};
    const playlist = Boolean(sortKey.playlist || field.playlist || sortKey.key.startsWith('playlist:'));
    const values = playlist ? membershipValues(memberships, sortKey.key, sortKey) : null;
    const valueFor = row => playlist ? (values?.[String(row.id)] || 0) : row[sortKey.key];
    const prepareValue = value => {
      if (isEmpty(value)) return value;
      if (field.type === 'number' || playlist) return Number(value);
      return String(value);
    };
    return {
      direction: sortKey.direction === 'desc' ? -1 : 1,
      type: playlist ? 'number' : field.type || 'text',
      values: row => prepareValue(valueFor(row)),
    };
  });

  // Decorate once so the comparator does not repeatedly read or convert row values.
  return rows.map((row, index) => ({
    row,
    index,
    values: preparedKeys.map(sortKey => sortKey.values(row)),
  })).sort((left, right) => {
    for (let index = 0; index < preparedKeys.length; index++) {
      const sortKey = preparedKeys[index];
      const leftValue = left.values[index], rightValue = right.values[index];
      const comparison = compareValues(leftValue, rightValue, sortKey.type, collator);
      if (comparison) {
        // Empty values remain last in either direction; this matches the table's current behavior.
        if (isEmpty(leftValue) || isEmpty(rightValue)) return comparison;
        return comparison * sortKey.direction;
      }
    }
    return left.index - right.index;
  }).map(item => item.row);
}

function lower(value) { return String(value ?? '').toLocaleLowerCase('ja'); }

export function conditionMatches(value, condition, type = 'text', preparedLower = null) {
  const op = condition?.op;
  const empty = value === null || value === undefined || value === '';
  if (op === 'empty' || op === 'is empty') return empty;
  if (op === 'not-empty' || op === 'is not empty') return !empty;
  if (empty) return false;
  if (type === 'number') {
    const left = Number(value), right = Number(condition.value);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return ({ eq: left === right, ne: left !== right, lt: left < right, lte: left <= right, gt: left > right, gte: left >= right })[op] ?? false;
  }
  if (type === 'date') {
    const right = String(condition.value ?? '');
    if (!right) return false;
    // The condition controls the precision: '= 2015' matches an ISO date in 2015.
    const left = String(value).slice(0, right.length);
    return ({ eq: left === right, ne: left !== right, lt: left < right, lte: left <= right, gt: left > right, gte: left >= right })[op] ?? false;
  }
  const left = preparedLower ?? lower(value), right = lower(condition.value);
  return ({
    contains: left.includes(right), 'not-contains': !left.includes(right),
    eq: left === right, ne: left !== right, starts: left.startsWith(right),
  })[op] ?? false;
}

function groupMatches(row, item, memberships) {
  const value = item.field.playlist ? (memberships[item.key]?.[String(row.id)] || 0) : row[item.key];
  const results = item.field.playlist
    ? item.conditions.map(condition => condition.op === 'in' ? value > 0 : value === 0)
    : item.conditions.map(condition => conditionMatches(value, condition, item.field.type, row.__lower?.[item.key]));
  return item.combineOr ? results.some(Boolean) : results.every(Boolean);
}

export function filterRow(row, filters, fieldsByKey = {}, memberships = {}) {
  return Object.entries(filters || {}).every(([key, group]) => {
    const field = fieldsByKey[key] || { type: 'text' };
    const conditions = group?.items || group || [];
    if (!conditions.length) return true;
    return groupMatches(row, { key, field, conditions, combineOr: (group?.combine || 'and').toLowerCase() === 'or' }, memberships);
  });
}

export function filterRows(rows, filters, fieldsByKey = {}, memberships = {}) {
  const prepared = Object.entries(filters || {}).map(([key, group]) => {
    const field = fieldsByKey[key] || { type: 'text' };
    const conditions = group?.items || group || [];
    return { key, field, conditions, combineOr: (group?.combine || 'and').toLowerCase() === 'or' };
  }).filter(item => item.conditions.length);
  if (!prepared.length) return rows.slice();
  return rows.filter(row => prepared.every(item => groupMatches(row, item, memberships)));
}

export function prepareRows(fields, songs) {
  return songs.map(values => {
    const row = {}, lowerValues = {};
    fields.forEach((field, index) => {
      const value = values[index] ?? '';
      row[field.key] = value;
      if (field.type === 'text') lowerValues[field.key] = lower(value);
    });
    row.__lower = lowerValues;
    return row;
  });
}

export function recomputeRows(rows, filters, sort, fieldsByKey, memberships = {}) {
  return sortRows(filterRows(rows, filters, fieldsByKey, memberships), sort, fieldsByKey, memberships);
}

export function moveColumn(columns, fromKey, toIndex) {
  const fromIndex = columns.indexOf(fromKey);
  if (fromIndex < 0) return columns.slice();
  const result = columns.filter(key => key !== fromKey);
  const index = Math.max(0, Math.min(result.length, Number.isFinite(toIndex) ? toIndex : result.length));
  result.splice(index, 0, fromKey);
  return result;
}

export function membershipCount(memberships, playlistId, songId) {
  return memberships?.[playlistId]?.[String(songId)] || 0;
}

export class SelectionModel {
  constructor() { this.selected = new Set(); this.anchor = null; this.indexById = new Map(); }
  setIndexMap(idsOrMap) { this.indexById = idsOrMap instanceof Map ? idsOrMap : new Map(idsOrMap.map((id, index) => [String(id), index])); }
  toggle(id) {
    const key = String(id);
    if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
    this.anchor = key;
  }
  range(idsOrMap, id, additive = true) {
    const indexById = idsOrMap instanceof Map ? idsOrMap : new Map(idsOrMap.map((item, index) => [String(item), index]));
    const target = String(id), end = indexById.get(target), anchorIndex = this.anchor === null ? end : indexById.get(String(this.anchor));
    if (end === undefined) return;
    if (anchorIndex === undefined) { this.toggle(target); return; }
    const [lo, hi] = anchorIndex < end ? [anchorIndex, end] : [end, anchorIndex];
    if (!additive) this.selected.clear();
    for (const [key, index] of indexById) if (index >= lo && index <= hi) this.selected.add(key);
    this.anchor = target;
  }
  selectAll(ids) { for (const id of ids) this.selected.add(String(id)); }
  clear(ids = null) { if (ids === null) this.selected.clear(); else for (const id of ids) this.selected.delete(String(id)); }
  invert(ids) { for (const id of ids) { const key = String(id); if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key); } }
  has(id) { return this.selected.has(String(id)); }
  get size() { return this.selected.size; }
}

function selectionIndexMap(idsOrMap) {
  return idsOrMap instanceof Map ? idsOrMap : new Map(idsOrMap.map((id, index) => [String(id), index]));
}

export function beginGesture({ selected, anchor = null, clickedId, shiftKey = false, indexById }) {
  const index = selectionIndexMap(indexById);
  const clicked = String(clickedId);
  const next = new Set([...selected].map(String));
  let paintStart = clicked;
  let mode = 'select';

  if (shiftKey) {
    const anchorKey = anchor === null ? null : String(anchor);
    const anchorIndex = anchorKey === null ? undefined : index.get(anchorKey);
    const clickedIndex = index.get(clicked);
    if (anchorIndex !== undefined && clickedIndex !== undefined) {
      const [lo, hi] = anchorIndex < clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
      for (const [key, rowIndex] of index) if (rowIndex >= lo && rowIndex <= hi) next.add(key);
      paintStart = anchorKey;
    } else {
      next.add(clicked);
    }
  } else if (next.has(clicked)) {
    next.delete(clicked);
    mode = 'deselect';
  } else {
    next.add(clicked);
  }

  return {
    selected: next,
    anchor: clicked,
    drag: { clickedId: clicked, paintStart, baseline: new Set(next), mode },
  };
}

function rangeFrom(idsOrMap, startId, currentId) {
  const indexById = selectionIndexMap(idsOrMap);
  const start = indexById.get(String(startId)), current = indexById.get(String(currentId));
  if (start === undefined || current === undefined) return null;
  return { indexById, lo: Math.min(start, current), hi: Math.max(start, current) };
}

export function dragPaint(idsOrMap, startId, currentId, initialSelected, mode = null) {
  const range = rangeFrom(idsOrMap, startId, currentId);
  const result = new Set(initialSelected);
  if (!range) return result;
  const paintMode = mode || (result.has(String(startId)) ? 'deselect' : 'select');
  for (const [key, index] of range.indexById) {
    if (index < range.lo || index > range.hi) continue;
    if (paintMode === 'select') result.add(key); else result.delete(key);
  }
  return result;
}

export function filterChipData(filters, fieldsByKey = {}) {
  return Object.entries(filters || {}).filter(([, group]) => group?.items?.length).map(([key, group]) => ({
    key, label: fieldsByKey[key]?.label || key, combine: (group.combine || 'and').toLowerCase(),
    conditions: group.items.map(condition => ({ ...condition })),
  }));
}
