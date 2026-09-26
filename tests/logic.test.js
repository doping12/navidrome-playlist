import test from 'node:test';
import assert from 'node:assert/strict';
import { beginGesture, conditionMatches, filterRows, sortRows, SelectionModel, dragPaint, filterChipData } from '../navidrome_playlist/static/logic.js';

const fields = { title: { type: 'text' }, year: { type: 'number' }, date: { type: 'date' }, 'playlist:p': { type: 'number', playlist: true } };
const rows = [{ id: '1', title: 'Alpha 2', year: 10, date: '2015' }, { id: '2', title: 'beta', year: 2, date: '2015-07-23' }, { id: '3', title: '', year: 20, date: '' }];

test('text, numeric and date operators', () => {
  assert.equal(conditionMatches('Hello World', { op: 'contains', value: 'WORLD' }), true);
  assert.equal(conditionMatches('Hello', { op: 'not-contains', value: 'x' }), true);
  assert.equal(conditionMatches('Hello', { op: 'starts', value: 'he' }), true);
  assert.equal(conditionMatches(10, { op: 'gte', value: '10' }, 'number'), true);
  assert.equal(conditionMatches('2015', { op: 'lt', value: '2016' }, 'date'), true);
  assert.equal(conditionMatches('2015-07-23', { op: 'eq', value: '2015' }, 'date'), true);
  assert.equal(conditionMatches('2015-07-23', { op: 'gte', value: '2015-07' }, 'date'), true);
  assert.equal(conditionMatches('2015-07-23', { op: 'lt', value: '2016' }, 'date'), true);
  assert.equal(conditionMatches('2015-07-23', { op: 'ne', value: '2014' }, 'date'), true);
  assert.equal(conditionMatches('', { op: 'empty' }), true);
});

test('AND/OR filters across columns and playlist membership', () => {
  assert.deepEqual(filterRows(rows, { title: { combine: 'or', items: [{ op: 'contains', value: 'alpha' }, { op: 'empty' }] }, year: { items: [{ op: 'gte', value: 10 }] } }, fields).map(r => r.id), ['1', '3']);
  const memberships = { p: { '1': 2 } };
  assert.deepEqual(filterRows(rows, { 'playlist:p': { items: [{ op: 'in' }] } }, fields, { 'playlist:p': memberships.p }).map(r => r.id), ['1']);
  assert.deepEqual(filterRows(rows, { 'playlist:p': { items: [{ op: 'not-in' }] } }, fields, { 'playlist:p': memberships.p }).map(r => r.id), ['2', '3']);
});

test('sort uses numeric values and empty values last', () => {
  assert.deepEqual(sortRows(rows, { key: 'year', direction: 'asc' }, fields).map(r => r.id), ['2', '1', '3']);
  assert.deepEqual(sortRows(rows, { key: 'title', direction: 'asc' }, fields).map(r => r.id), ['1', '2', '3']);
  assert.deepEqual(sortRows(rows, { key: 'date', direction: 'asc' }, fields).map(r => r.id), ['1', '2', '3']);
});

test('selection toggle, additive range and invert', () => {
  const selection = new SelectionModel(); selection.toggle('2'); selection.setIndexMap(new Map([['1', 0], ['2', 1], ['3', 2], ['4', 3]])); selection.range(selection.indexById, '4');
  assert.deepEqual([...selection.selected].sort(), ['2', '3', '4']); selection.invert(['1', '2', '3']); assert.deepEqual([...selection.selected].sort(), ['1', '4']);
});

test('shift click baseline is retained for a drag and chips expose hidden-column filters', () => {
  const selection = new SelectionModel();
  selection.toggle('2');
  const index = new Map([['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4]]);
  selection.range(index, '4', true);
  const afterShiftClick = new Set(selection.selected);
  assert.deepEqual([...dragPaint(index, '2', '2', afterShiftClick, 'select')].sort(), ['2', '3', '4']);
  assert.deepEqual(filterChipData({ hidden: { combine: 'or', items: [{ op: 'contains', value: 'x' }] } }, { hidden: { label: '非表示列' } }), [{ key: 'hidden', label: '非表示列', combine: 'or', conditions: [{ op: 'contains', value: 'x' }] }]);
});

test('drag paint selects/deselects contiguous range and restores outside range', () => {
  assert.deepEqual([...dragPaint(['1', '2', '3', '4', '5'], '2', '4', new Set(['1']), 'select')].sort(), ['1', '2', '3', '4']);
  assert.deepEqual([...dragPaint(['1', '2', '3', '4', '5'], '3', '1', new Set(['1', '2', '3', '5']), 'deselect')].sort(), ['5']);
});

test('beginGesture toggles plain clicks and adds shift ranges', () => {
  const indexById = new Map([['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4]]);
  const plain = beginGesture({ selected: new Set(['2']), anchor: null, clickedId: '2', shiftKey: false, indexById });
  assert.deepEqual([...plain.selected], []);
  assert.equal(plain.drag.mode, 'deselect');
  const plainSelect = beginGesture({ selected: new Set(), anchor: null, clickedId: '3', shiftKey: false, indexById });
  assert.deepEqual([...plainSelect.selected], ['3']);
  assert.equal(plainSelect.drag.mode, 'select');

  const shift = beginGesture({ selected: new Set(['1']), anchor: '1', clickedId: '4', shiftKey: true, indexById });
  assert.deepEqual([...shift.selected].sort(), ['1', '2', '3', '4']);
  assert.equal(shift.drag.mode, 'select');
  assert.equal(shift.drag.paintStart, '1');
});

test('shift on selected row remains additive and drag extends from anchor', () => {
  const indexById = new Map([['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4]]);
  const gesture = beginGesture({ selected: new Set(['1', '2', '3']), anchor: '2', clickedId: '3', shiftKey: true, indexById });
  assert.deepEqual([...gesture.selected].sort(), ['1', '2', '3']);
  assert.equal(gesture.drag.mode, 'select');
  assert.deepEqual([...dragPaint(indexById, gesture.drag.paintStart, '5', gesture.drag.baseline, gesture.drag.mode)].sort(), ['1', '2', '3', '4', '5']);
});

test('plain drag from a selected row deselects its sweep and restores outside rows', () => {
  const indexById = new Map([['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4]]);
  const gesture = beginGesture({ selected: new Set(['1', '2', '3', '5']), anchor: null, clickedId: '3', shiftKey: false, indexById });
  assert.equal(gesture.drag.mode, 'deselect');
  assert.deepEqual([...dragPaint(indexById, gesture.drag.paintStart, '1', gesture.drag.baseline, gesture.drag.mode)].sort(), ['5']);
  assert.deepEqual([...dragPaint(indexById, gesture.drag.paintStart, '4', gesture.drag.baseline, gesture.drag.mode)].sort(), ['1', '2', '5']);
});
