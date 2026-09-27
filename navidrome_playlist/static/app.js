import { beginGesture, filterChipData, membershipCount, moveColumn, prepareRows, recomputeRows, SelectionModel, dragPaint } from './logic.js';

export const ROW_HEIGHT = 30;
export const HEADER_HEIGHT = 38;
const state = {
  data: null, fields: [], fieldByKey: {}, rows: [], visibleRows: [], visibleIndexById: new Map(),
  visibleColumns: [], widths: {}, sort: {}, filters: {}, selection: new SelectionModel(),
  dragging: null, dragRaf: 0, scrollRaf: 0, resizing: null, reordering: null, reorderRaf: 0,
  suppressSortClick: false, actionsPending: false,
};
const $ = id => document.getElementById(id);
const tableScroll = $('table-scroll');
const table = tableScroll.querySelector('table');

function storageRead(key, fallback) { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function storageWrite(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage-disabled browsers are supported */ } }
function setStatus(message, error = false) { $('status').textContent = message; $('status').style.color = error ? '#ffb4b4' : ''; }
function field(key) { return state.fieldByKey[key] || { key, label: key, type: 'text' }; }
function isPlaylist(key) { return key.startsWith('playlist:'); }
function playlistId(key) { return key.slice('playlist:'.length); }
function playlistFor(key) { return state.data.playlists.find(p => String(p.id) === playlistId(key)); }
function labelFor(key) { return isPlaylist(key) ? playlistFor(key)?.name || key : field(key).label; }
function allColumnKeys() { return state.fields.filter(f => f.key !== 'id').map(f => f.key).concat(state.data.playlists.map(p => `playlist:${p.id}`)); }
function defaultColumnKeys() {
  const preferred = ['title', 'album', 'artist', 'albumArtist', 'releaseDate'];
  return [...preferred.filter(key => state.fieldByKey[key]), ...state.data.playlists.map(p => `playlist:${p.id}`)];
}
function orderedColumnKeys() {
  const defaults = new Set(['title', 'album', 'artist', 'albumArtist', 'releaseDate']);
  const metadata = state.fields.filter(f => f.key !== 'id' && defaults.has(f.key)).map(f => f.key);
  const rest = state.fields.filter(f => f.key !== 'id' && !defaults.has(f.key)).map(f => f.key);
  return [...metadata, ...rest, ...state.data.playlists.map(p => `playlist:${p.id}`)];
}
function rememberPlaylists() {
  const known = new Set((storageRead('ndpl:knownPlaylists', []) || []).map(String));
  state.data.playlists.forEach(playlist => known.add(String(playlist.id)));
  storageWrite('ndpl:knownPlaylists', [...known]);
  return known;
}
function saveColumns() {
  storageWrite('ndpl:columns', state.visibleColumns);
  rememberPlaylists();
}
function normalizeSort(sort) {
  if (sort?.key && (sort.direction === 'asc' || sort.direction === 'desc')) return { [sort.key]: sort.direction };
  return Object.fromEntries(Object.entries(sort || {}).filter(([, direction]) => direction === 'asc' || direction === 'desc'));
}
function keepVisibleSorts() {
  state.sort = Object.fromEntries(Object.entries(state.sort).filter(([key]) => state.visibleColumns.includes(key)));
  storageWrite('ndpl:sort', state.sort);
}
function restorePrefs(preserveCurrent = false) {
  const keys = allColumnKeys(), saved = storageRead('ndpl:columns', null);
  const known = new Set((storageRead('ndpl:knownPlaylists', []) || []).map(String));
  if (preserveCurrent) state.visibleColumns = state.visibleColumns.filter(key => keys.includes(key));
  else state.visibleColumns = Array.isArray(saved) ? saved.filter(key => keys.includes(key)) : defaultColumnKeys();
  if (!state.visibleColumns.length && !preserveCurrent) state.visibleColumns = defaultColumnKeys();
  state.data.playlists.forEach(playlist => {
    if (!known.has(String(playlist.id))) {
      const key = `playlist:${playlist.id}`;
      if (!state.visibleColumns.includes(key)) state.visibleColumns.push(key);
    }
  });
  rememberPlaylists();
  if (!preserveCurrent) {
    state.widths = storageRead('ndpl:widths', {});
    state.sort = normalizeSort(storageRead('ndpl:sort', {}));
    storageWrite('ndpl:sort', state.sort);
  }
}
function membershipsForFiltering() {
  return Object.fromEntries(state.data.playlists.map(p => [`playlist:${p.id}`, state.data.membership[String(p.id)] || {}]));
}
let defaultWidthCache = null, minimumWidthCache = null;
function defaultColumnWidth() {
  if (defaultWidthCache !== null) return defaultWidthCache;
  const style = getComputedStyle(table), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  if (context) { context.font = style.font; defaultWidthCache = Math.ceil(context.measureText('0'.repeat(20)).width + 16); }
  else defaultWidthCache = Math.max(90, parseFloat(style.fontSize || '16') * 10 + 16);
  return defaultWidthCache;
}
function minimumColumnWidth() {
  if (minimumWidthCache !== null) return minimumWidthCache;
  const style = getComputedStyle(table), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  minimumWidthCache = context ? (context.font = style.font, Math.ceil(context.measureText('0'.repeat(3)).width + 16)) : 48;
  return minimumWidthCache;
}
function columnWidth(key) { return Number(state.widths[key]) || defaultColumnWidth(); }

function recompute() {
  const sortKeys = state.visibleColumns.filter(key => state.sort[key]).map(key => ({ key, direction: state.sort[key] }));
  state.visibleRows = recomputeRows(state.rows, state.filters, sortKeys, state.fieldByKey, membershipsForFiltering());
  state.visibleIndexById = new Map(state.visibleRows.map((row, index) => [String(row.id), index]));
  state.selection.setIndexMap(state.visibleIndexById);
  renderFilterSummary();
  renderBody();
  updateCount();
}

function applyColumnWidths() {
  const cols = table.querySelectorAll('col');
  const headers = $('table-head').querySelectorAll('th');
  const widths = state.visibleColumns.map(columnWidth);
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  state.visibleColumns.forEach((key, index) => {
    const width = `${widths[index]}px`;
    if (cols[index]) cols[index].style.width = width;
    if (headers[index]) headers[index].style.width = width;
  });
}
function renderHeader() {
  const scrollTop = tableScroll.scrollTop;
  const head = $('table-head');
  const group = document.createElement('colgroup');
  state.visibleColumns.forEach(key => { const col = document.createElement('col'); col.dataset.key = key; group.append(col); });
  const oldGroup = table.querySelector('colgroup');
  if (oldGroup) oldGroup.replaceWith(group); else table.insertBefore(group, head);
  const row = document.createElement('tr');
  const sortedKeys = state.visibleColumns.filter(key => state.sort[key]);
  for (const key of state.visibleColumns) {
    const th = document.createElement('th'); th.dataset.key = key;
    const direction = state.sort[key];
    if (direction) th.classList.add('selected-sort');
    const priority = direction ? sortedKeys.indexOf(key) + 1 : 0;
    th.append(document.createTextNode(`${labelFor(key)}${direction ? ` ${direction === 'asc' ? '↑' : '↓'}${sortedKeys.length > 1 ? priority : ''}` : ''}`));
    const filter = document.createElement('button'); filter.className = 'filter-btn'; filter.dataset.filter = key; filter.textContent = state.filters[key]?.items?.length ? '●' : '▽'; filter.title = 'フィルター';
    const resize = document.createElement('span'); resize.className = 'resize'; resize.dataset.resize = key; resize.title = '列幅を変更';
    th.append(filter, resize); row.append(th);
  }
  head.replaceChildren(row); applyColumnWidths();
  if (tableScroll.scrollTop !== scrollTop) tableScroll.scrollTop = scrollTop;
}
function displayValue(row, key) {
  if (isPlaylist(key)) { const count = membershipCount(state.data.membership, playlistId(key), row.id); return count ? (count > 1 ? `✓ ${count}` : '✓') : ''; }
  const value = row[key];
  if (key === 'duration' && value !== '') { const total = Math.max(0, Math.round(Number(value))); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; }
  if (key === 'size' && value !== '') return `${(Number(value) / 1024 / 1024).toFixed(1)} MB`;
  return value ?? '';
}
function renderBody() {
  const scrollTop = tableScroll.scrollTop;
  const viewport = Math.max(0, tableScroll.clientHeight - HEADER_HEIGHT);
  const body = $('table-body');
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const count = Math.ceil(viewport / ROW_HEIGHT) + 8;
  const end = Math.min(state.visibleRows.length, start + count);
  const rows = document.createDocumentFragment();
  const top = document.createElement('tr'); top.className = 'virtual-spacer'; top.style.height = `${start * ROW_HEIGHT}px`;
  const topCell = document.createElement('td'); topCell.colSpan = state.visibleColumns.length; top.append(topCell); rows.append(top);
  for (let index = start; index < end; index++) {
    const row = state.visibleRows[index], tr = document.createElement('tr'); tr.className = 'data-row'; tr.dataset.id = row.id;
    if (state.selection.has(row.id)) tr.classList.add('selected');
    state.visibleColumns.forEach(key => { const td = document.createElement('td'); if (isPlaylist(key)) td.className = 'membership'; td.textContent = displayValue(row, key); tr.append(td); });
    rows.append(tr);
  }
  const bottom = document.createElement('tr'); bottom.className = 'virtual-spacer'; bottom.style.height = `${Math.max(0, (state.visibleRows.length - end) * ROW_HEIGHT)}px`;
  const bottomCell = document.createElement('td'); bottomCell.colSpan = state.visibleColumns.length; bottom.append(bottomCell); rows.append(bottom);
  body.replaceChildren(rows);
  if (tableScroll.scrollTop !== scrollTop) tableScroll.scrollTop = scrollTop;
}
function selectedHidden() { const visible = new Set(state.visibleRows.map(row => String(row.id))); return [...state.selection.selected].filter(id => !visible.has(id)).length; }
function updateCount() {
  const hidden = selectedHidden(); $('selection-count').textContent = `${state.selection.size}件選択中${hidden ? `（うち${hidden}件はフィルターで非表示）` : ''}`;
  $('song-count').textContent = `表示 ${state.visibleRows.length} / 全 ${state.rows.length} 曲`;
  updateActionState();
}
function conditionSummary(condition) {
  const labels = { contains: '含む', 'not-contains': '含まない', eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', starts: '始まる', empty: '空', 'not-empty': '空でない', in: '含む', 'not-in': '含まない' };
  return `${labels[condition.op] || condition.op}${['empty', 'not-empty', 'in', 'not-in'].includes(condition.op) ? '' : ` ${condition.value}`}`;
}
function renderFilterSummary() {
  const summary = $('filter-summary'); summary.innerHTML = '';
  const chips = filterChipData(state.filters, state.fieldByKey);
  if (!chips.length) { summary.textContent = 'フィルターなし'; return; }
  chips.forEach(chip => {
    const item = document.createElement('span'); item.className = 'filter-chip';
    item.append(document.createTextNode(`${chip.label}: ${chip.conditions.map(conditionSummary).join(chip.combine === 'or' ? ' OR ' : ' AND ')}`));
    const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.filterRemove = chip.key; remove.textContent = '×'; remove.title = 'このフィルターを解除'; item.append(remove); summary.append(item);
  });
  const clear = document.createElement('button'); clear.type = 'button'; clear.id = 'clear-filters'; clear.textContent = 'フィルターをすべて解除'; clear.onclick = () => { state.filters = {}; renderHeader(); recompute(); }; summary.append(clear);
}
function render() { renderHeader(); renderBody(); renderFilterSummary(); updateCount(); }

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
}
function populatePlaylistTarget() {
  const select = $('playlist-target'); select.innerHTML = '';
  const choices = editablePlaylists();
  if (!choices.length) { select.add(new Option('編集可能なプレイリストなし', '')); select.disabled = true; }
  else { choices.forEach(playlist => select.add(new Option(playlist.name, playlist.id))); select.disabled = false; }
  updateActionState();
}
function editablePlaylists() { return state.data.playlists.filter(playlist => playlist.editable); }
function updateActionState() {
  if (!$('playlist-target') || !state.data) return;
  const enabled = !state.actionsPending && state.selection.size > 0 && editablePlaylists().length > 0;
  $('add-existing').disabled = !enabled; $('remove-from').disabled = !enabled; $('playlist-target').disabled = state.actionsPending || !editablePlaylists().length;
  $('create-playlist').disabled = state.actionsPending || state.selection.size === 0;
}
function setActionsPending(pending) { state.actionsPending = pending; updateActionState(); }
function clearSelectionAfterEdit() {
  if (!$('clear-after-edit').checked) return;
  state.selection.clear(); state.selection.anchor = null; renderBody(); updateCount();
}
function applyPayload(data) {
  const preserveCurrent = Boolean(state.data);
  state.data = data; state.fields = data.fields; state.fieldByKey = Object.fromEntries(data.fields.map(f => [f.key, f]));
  data.playlists.forEach(playlist => { const key = `playlist:${playlist.id}`; state.fieldByKey[key] = { key, label: playlist.name, type: 'number', playlist: true }; });
  state.rows = prepareRows(state.fields, data.songs);
  restorePrefs(preserveCurrent);
  const validKeys = new Set(allColumnKeys());
  if (preserveCurrent) {
    state.filters = Object.fromEntries(Object.entries(state.filters).filter(([key]) => validKeys.has(key)));
    const validIds = new Set(state.rows.map(row => String(row.id)));
    state.selection.selected = new Set([...state.selection.selected].filter(id => validIds.has(String(id))));
    if (state.selection.anchor !== null && !validIds.has(String(state.selection.anchor))) state.selection.anchor = null;
  }
  state.sort = Object.fromEntries(Object.entries(state.sort).filter(([key]) => validKeys.has(key) && state.visibleColumns.includes(key)));
  storageWrite('ndpl:sort', state.sort);
  renderHeader(); populatePlaylistTarget(); recompute();
}
async function load(path = '/api/library', options = {}) { setStatus('読み込み中…'); try { applyPayload(await request(path, options)); setStatus(`${state.data.songs.length}曲 / ${state.data.playlists.length}プレイリスト`); } catch (error) { setStatus(error.message, true); } }

function sortClick(key) {
  const direction = state.sort[key];
  if (!direction) state.sort[key] = 'asc';
  else if (direction === 'asc') state.sort[key] = 'desc';
  else delete state.sort[key];
  storageWrite('ndpl:sort', state.sort); renderHeader(); recompute();
}
function suppressSortClickOnce() {
  state.suppressSortClick = true;
  setTimeout(() => { state.suppressSortClick = false; }, 0);
}
function clearSort() { state.sort = {}; storageWrite('ndpl:sort', state.sort); renderHeader(); recompute(); }
function showColumnMenu() {
  const menu = $('column-menu'); menu.innerHTML = '<strong>表示する列</strong>';
  const controls = document.createElement('div'); const all = document.createElement('button'); all.type = 'button'; all.textContent = 'すべての列'; all.onclick = () => { state.visibleColumns = allColumnKeys(); keepVisibleSorts(); saveColumns(); menu.classList.add('hidden'); renderHeader(); recompute(); }; const defaults = document.createElement('button'); defaults.type = 'button'; defaults.textContent = '既定に戻す'; defaults.onclick = () => { state.visibleColumns = defaultColumnKeys(); keepVisibleSorts(); saveColumns(); menu.classList.add('hidden'); renderHeader(); recompute(); }; controls.append(all, defaults); menu.append(controls);
  const metadata = document.createElement('div'); metadata.innerHTML = '<hr><strong>メタデータ</strong>';
  orderedColumnKeys().filter(key => !isPlaylist(key)).forEach(key => metadata.append(columnChoice(key))); menu.append(metadata);
  const playlists = document.createElement('div'); playlists.innerHTML = '<hr><strong>プレイリスト</strong>';
  orderedColumnKeys().filter(isPlaylist).forEach(key => playlists.append(columnChoice(key))); menu.append(playlists);
  menu.classList.remove('hidden'); positionPopover(menu, $('columns').getBoundingClientRect(), 'right');
}
function columnChoice(key) { const label = document.createElement('label'); label.style.display = 'block'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.visibleColumns.includes(key); input.onchange = () => { if (input.checked) state.visibleColumns.push(key); else state.visibleColumns = state.visibleColumns.filter(item => item !== key); keepVisibleSorts(); saveColumns(); renderHeader(); recompute(); }; label.append(input, ` ${labelFor(key)}`); return label; }
function positionPopover(menu, targetRect, align = 'left') {
  const margin = 8;
  menu.style.left = '0px'; menu.style.right = 'auto'; menu.style.top = '0px';
  menu.style.maxHeight = `calc(100vh - ${margin * 2}px)`;
  const size = menu.getBoundingClientRect();
  const below = targetRect.bottom + 4;
  const above = targetRect.top - size.height - 4;
  const top = below + size.height <= innerHeight - margin ? below : above >= margin ? above : margin;
  const maxHeight = Math.max(0, innerHeight - top - margin);
  menu.style.maxHeight = `${maxHeight}px`;
  const width = menu.getBoundingClientRect().width;
  const preferredLeft = align === 'right' ? targetRect.right - width : targetRect.left;
  const left = Math.max(margin, Math.min(preferredLeft, innerWidth - width - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}
function showFilter(key, target) {
  const menu = $('edit-menu'); menu.innerHTML = ''; const f = field(key), playlist = isPlaylist(key), current = state.filters[key] || { combine: 'and', items: [] };
  const title = document.createElement('strong'); title.textContent = `${labelFor(key)} の条件`; menu.append(title);
  const combine = document.createElement('select'); combine.innerHTML = '<option value="and">すべて満たす (AND)</option><option value="or">いずれか (OR)</option>'; combine.value = current.combine; menu.append(combine);
  const list = document.createElement('div'); menu.append(list); let items = current.items?.length ? current.items.map(item => ({ ...item })) : [{ op: playlist ? 'in' : f.type === 'text' ? 'contains' : 'eq', value: '' }];
  const ops = playlist ? [['in', '含む'], ['not-in', '含まない']] : f.type === 'text' ? [['contains', '含む'], ['not-contains', '含まない'], ['eq', '一致'], ['ne', '不一致'], ['starts', '始まる'], ['empty', '空'], ['not-empty', '空でない']] : [['eq', '='], ['ne', '≠'], ['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥'], ['empty', '空'], ['not-empty', '空でない']];
  const draw = () => { list.innerHTML = ''; items.forEach((item, index) => { const line = document.createElement('div'); line.className = 'condition'; const select = document.createElement('select'); ops.forEach(([value, label]) => select.add(new Option(label, value))); select.value = item.op; const input = document.createElement('input'); input.value = item.value || ''; input.placeholder = '値'; input.hidden = ['empty', 'not-empty', 'in', 'not-in'].includes(item.op); select.onchange = () => { item.op = select.value; input.hidden = ['empty', 'not-empty', 'in', 'not-in'].includes(item.op); }; input.oninput = () => { item.value = input.value; }; const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.onclick = () => { items.splice(index, 1); draw(); }; line.append(select, input, remove); list.append(line); }); };
  draw(); const add = document.createElement('button'); add.type = 'button'; add.textContent = '条件を追加'; add.onclick = () => { items.push({ op: ops[0][0], value: '' }); draw(); }; const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = '適用'; apply.onclick = () => { state.filters[key] = { combine: combine.value, items: items.filter(item => ['empty', 'not-empty', 'in', 'not-in'].includes(item.op) || item.value !== '') }; if (!state.filters[key].items.length) delete state.filters[key]; menu.classList.add('hidden'); renderHeader(); recompute(); }; const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = '解除'; clear.onclick = () => { delete state.filters[key]; menu.classList.add('hidden'); renderHeader(); recompute(); }; menu.append(add, apply, clear); menu.classList.remove('hidden'); positionPopover(menu, target.getBoundingClientRect());
}

async function addExisting() { const selected = [...state.selection.selected], playlist = editablePlaylists().find(item => String(item.id) === String($('playlist-target').value)); if (!selected.length) return setStatus('曲を選択してください', true); if (!playlist) return setStatus('編集可能なプレイリストがありません', true); setActionsPending(true); try { const result = await request(`/api/playlists/${encodeURIComponent(playlist.id)}/add`, { method: 'POST', body: JSON.stringify({ songIds: selected }) }); state.data.membership[String(playlist.id)] = result.membership; recompute(); setStatus(`${result.added}件追加、${result.skipped}件スキップ`); clearSelectionAfterEdit(); } catch (error) { setStatus(error.message, true); } finally { setActionsPending(false); } }
async function removeFrom() { const selected = [...state.selection.selected], playlist = editablePlaylists().find(item => String(item.id) === String($('playlist-target').value)); if (!selected.length) return setStatus('曲を選択してください', true); if (!playlist) return setStatus('編集可能なプレイリストがありません', true); if (!confirm(`${selected.length}曲を「${playlist.name}」から削除しますか？`)) return; setActionsPending(true); try { const result = await request(`/api/playlists/${encodeURIComponent(playlist.id)}/remove`, { method: 'POST', body: JSON.stringify({ songIds: selected }) }); state.data.membership[String(playlist.id)] = result.membership; recompute(); setStatus(`${result.removed}件削除しました`); clearSelectionAfterEdit(); } catch (error) { setStatus(error.message, true); } finally { setActionsPending(false); } }
async function createPlaylist() {
  const selected = [...state.selection.selected]; if (!selected.length) return setStatus('曲を選択してください', true);
  const dialog = $('name-dialog'), input = $('playlist-name'); input.value = ''; input.setCustomValidity(''); dialog.showModal();
  const result = await new Promise(resolve => { const finish = () => resolve(dialog.returnValue); dialog.addEventListener('close', finish, { once: true }); });
  if (result !== 'ok') return;
  const name = input.value.trim(); if (!name) return setStatus('プレイリスト名を入力してください', true);
  setActionsPending(true); try { const response = await request('/api/playlists', { method: 'POST', body: JSON.stringify({ name, songIds: selected }) }); const playlist = response.playlist; state.data.playlists.push(playlist); state.data.membership[String(response.id)] = response.membership; const key = `playlist:${response.id}`; state.fieldByKey[key] = { key, label: playlist.name, type: 'number', playlist: true }; state.visibleColumns.push(key); saveColumns(); populatePlaylistTarget(); renderHeader(); recompute(); setStatus('プレイリストを作成し、曲を追加しました'); clearSelectionAfterEdit(); } catch (error) { setStatus(error.message, true); } finally { setActionsPending(false); }
}

function rowAtClientY(clientY) {
  if (!state.visibleRows.length) return null;
  const rect = tableScroll.getBoundingClientRect(); const position = Math.floor((clientY - rect.top + tableScroll.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT);
  return state.visibleRows[Math.max(0, Math.min(state.visibleRows.length - 1, position))]?.id;
}
function paintDrag() {
  const drag = state.dragging; if (!drag) return;
  const currentId = rowAtClientY(drag.clientY); if (!currentId) return;
  if (!drag.moved && String(currentId) === String(drag.clickedId)) return;
  if (String(currentId) !== String(drag.lastId)) { state.selection.selected = dragPaint(state.visibleIndexById, drag.paintStart, currentId, drag.baseline, drag.mode); drag.lastId = currentId; drag.moved = true; state.selection.anchor = String(currentId); renderBody(); updateCount(); }
}
function dragLoop() {
  if (!state.dragging) return;
  const rect = tableScroll.getBoundingClientRect(), edge = 32;
  if (state.dragging.clientY < rect.top + edge) tableScroll.scrollTop = Math.max(0, tableScroll.scrollTop - 18);
  else if (state.dragging.clientY > rect.bottom - edge) tableScroll.scrollTop += 18;
  paintDrag(); state.dragRaf = requestAnimationFrame(dragLoop);
}
function onTableMouseDown(event) {
  const row = event.target.closest('tr.data-row'); if (!row || event.button !== 0) return;
  event.preventDefault(); const gesture = beginGesture({ selected: state.selection.selected, anchor: state.selection.anchor, clickedId: row.dataset.id, shiftKey: event.shiftKey, indexById: state.visibleIndexById });
  state.selection.selected = gesture.selected; state.selection.anchor = gesture.anchor;
  state.dragging = { ...gesture.drag, clientY: event.clientY, lastId: String(row.dataset.id), moved: false };
  renderBody(); updateCount(); cancelAnimationFrame(state.dragRaf); state.dragRaf = requestAnimationFrame(dragLoop);
}
function dropIndicator(position) {
  let indicator = $('column-drop-indicator');
  if (!indicator) { indicator = document.createElement('span'); indicator.id = 'column-drop-indicator'; indicator.className = 'drop-indicator'; document.body.append(indicator); }
  const rect = tableScroll.getBoundingClientRect();
  indicator.style.left = `${position.x}px`;
  indicator.style.top = `${rect.top}px`;
  indicator.style.height = `${HEADER_HEIGHT}px`;
}
function clearDropIndicator() { $('column-drop-indicator')?.remove(); }
function reorderPosition(clientX) {
  const source = state.reordering?.key;
  const headers = [...$('table-head').querySelectorAll('th[data-key]')].filter(header => header.dataset.key !== source);
  let toIndex = headers.length, x = headers.at(-1)?.getBoundingClientRect().right || tableScroll.getBoundingClientRect().left;
  for (const [index, header] of headers.entries()) {
    const rect = header.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) { toIndex = index; x = rect.left; break; }
  }
  return { toIndex, x };
}
function updateReorder(clientX) {
  if (!state.reordering?.active) return;
  const position = reorderPosition(clientX);
  state.reordering.toIndex = position.toIndex;
  dropIndicator(position);
}
function reorderLoop() {
  if (!state.reordering?.active) return;
  const rect = tableScroll.getBoundingClientRect(), edge = 32;
  if (state.reordering.clientX < rect.left + edge) tableScroll.scrollLeft = Math.max(0, tableScroll.scrollLeft - 18);
  else if (state.reordering.clientX > rect.right - edge) tableScroll.scrollLeft += 18;
  updateReorder(state.reordering.clientX);
  state.reorderRaf = requestAnimationFrame(reorderLoop);
}
function onHeaderMouseDown(event) {
  if (event.button !== 0 || event.target.closest('.resize,.filter-btn')) return;
  const header = event.target.closest('th[data-key]');
  if (!header) return;
  state.reordering = { key: header.dataset.key, startX: event.clientX, clientX: event.clientX, header, active: false, toIndex: state.visibleColumns.indexOf(header.dataset.key) };
}
function cancelReorder() {
  if (!state.reordering) return;
  cancelAnimationFrame(state.reorderRaf); state.reordering.header.classList.remove('dragging-column');
  state.reordering = null; clearDropIndicator();
}
function endReorder() {
  if (!state.reordering) return;
  const reorder = state.reordering;
  cancelAnimationFrame(state.reorderRaf);
  if (reorder.active) {
    state.visibleColumns = moveColumn(state.visibleColumns, reorder.key, reorder.toIndex);
    saveColumns(); renderHeader(); renderBody(); suppressSortClickOnce();
  }
  reorder.header.classList.remove('dragging-column');
  state.reordering = null; clearDropIndicator();
}
function onDocumentMouseMove(event) {
  if (state.reordering) {
    state.reordering.clientX = event.clientX;
    if (!state.reordering.active && Math.abs(event.clientX - state.reordering.startX) > 5) {
      state.reordering.active = true; state.reordering.header.classList.add('dragging-column');
      event.preventDefault(); state.reorderRaf = requestAnimationFrame(reorderLoop);
    }
    updateReorder(event.clientX);
  }
  if (state.dragging) state.dragging.clientY = event.clientY;
}
function endDrag() { if (!state.dragging) return; cancelAnimationFrame(state.dragRaf); state.dragging = null; }

document.addEventListener('click', event => {
  const sortHeader = event.target.closest('th[data-key]');
  const filter = event.target.closest('[data-filter]');
  const resize = event.target.closest('.resize');
  if (sortHeader && !filter && !resize && !state.suppressSortClick) sortClick(sortHeader.dataset.key);
  if (filter) showFilter(filter.dataset.filter, filter);
  const remove = event.target.closest('[data-filter-remove]'); if (remove) { delete state.filters[remove.dataset.filterRemove]; renderHeader(); recompute(); }
  if (!event.target.closest('.popover,#columns,[data-filter],#filter-summary')) document.querySelectorAll('.popover').forEach(popover => popover.classList.add('hidden'));
});
tableScroll.addEventListener('mousedown', onTableMouseDown); tableScroll.addEventListener('mousedown', onHeaderMouseDown); document.addEventListener('mousemove', onDocumentMouseMove); document.addEventListener('mouseup', endDrag); document.addEventListener('mouseup', endReorder);
tableScroll.addEventListener('scroll', () => { cancelAnimationFrame(state.scrollRaf); state.scrollRaf = requestAnimationFrame(() => { renderBody(); updateCount(); }); });
document.addEventListener('mousedown', event => { const handle = event.target.closest('.resize'); if (!handle) return; event.preventDefault(); const th = handle.parentElement; state.resizing = { key: handle.dataset.resize, startX: event.clientX, startWidth: th.getBoundingClientRect().width, changed: false }; });
document.addEventListener('mousemove', event => { if (!state.resizing) return; const next = Math.max(minimumColumnWidth(), state.resizing.startWidth + event.clientX - state.resizing.startX); state.widths[state.resizing.key] = next; state.resizing.changed = next !== state.resizing.startWidth; applyColumnWidths(); });
document.addEventListener('mouseup', () => { if (!state.resizing) return; if (state.resizing.changed) { storageWrite('ndpl:widths', state.widths); suppressSortClickOnce(); } state.resizing = null; });
$('reload').onclick = () => load('/api/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
$('select-all').onclick = () => { state.selection.selectAll(state.visibleRows.map(row => row.id)); renderBody(); updateCount(); }; $('clear-selection').onclick = () => { state.selection.clear(); renderBody(); updateCount(); }; $('invert-selection').onclick = () => { state.selection.invert(state.visibleRows.map(row => row.id)); renderBody(); updateCount(); };
$('columns').onclick = showColumnMenu; $('clear-sort').onclick = clearSort; $('add-existing').onclick = addExisting; $('create-playlist').onclick = createPlaylist; $('remove-from').onclick = removeFrom;
$('clear-after-edit').checked = storageRead('ndpl:clearAfterEdit', false) === true; $('clear-after-edit').onchange = event => storageWrite('ndpl:clearAfterEdit', event.target.checked);
$('name-cancel').onclick = () => $('name-dialog').close('cancel'); $('name-form').addEventListener('submit', event => { if (!$('playlist-name').value.trim()) { event.preventDefault(); $('playlist-name').setCustomValidity('空白以外の文字を入力してください'); $('playlist-name').reportValidity(); } else $('playlist-name').setCustomValidity(''); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !/input|textarea|select/i.test(document.activeElement.tagName)) { event.preventDefault(); state.selection.selectAll(state.visibleRows.map(row => row.id)); renderBody(); updateCount(); } if (event.key === 'Escape') { if (state.reordering) { cancelReorder(); suppressSortClickOnce(); return; } const open = document.querySelector('.popover:not(.hidden),dialog[open]'); if (open) { if (open.tagName === 'DIALOG') open.close(); else open.classList.add('hidden'); } else { state.selection.clear(); renderBody(); updateCount(); } } });

load();
