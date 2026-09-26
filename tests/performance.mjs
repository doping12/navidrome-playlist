import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { prepareRows, recomputeRows } from '../navidrome_playlist/static/logic.js';

const count = 10000;
const fields = [
  { key: 'id', type: 'text', label: 'ID' }, { key: 'title', type: 'text', label: 'タイトル' },
  { key: 'album', type: 'text', label: 'アルバム' }, { key: 'artist', type: 'text', label: 'アーティスト' },
  { key: 'albumArtist', type: 'text', label: 'アルバムアーティスト' }, { key: 'releaseDate', type: 'date', label: 'リリース日' },
  { key: 'year', type: 'number', label: '年' }, { key: 'trackNumber', type: 'number', label: 'トラック番号' },
  ...Array.from({ length: 32 }, (_, index) => ({ key: `metadata${index}`, type: index % 3 ? 'text' : 'number', label: `metadata${index}` })),
];
const songs = Array.from({ length: count }, (_, index) => [
  String(index), `曲 ${count - index}`, `アルバム ${index % 500}`, `Artist ${index % 300}`, `作者 ${index % 100}`,
  `${1950 + index % 75}-${String(index % 12 + 1).padStart(2, '0')}-01`, 1950 + index % 75, index % 15 + 1,
  ...Array.from({ length: 32 }, (_, field) => field % 3 ? `値 ${index % (field + 3)}` : index * (field + 1)),
]);
const fieldsByKey = Object.fromEntries([...fields, { key: 'playlist:p', type: 'number', label: 'P', playlist: true }].map(field => [field.key, field]));
const membership = { 'playlist:p': Object.fromEntries(Array.from({ length: count / 3 }, (_, index) => [String(index * 3), 1])) };
const payload = { fields, songs, playlists: [{ id: 'p', name: 'P', editable: true }], membership };
const raw = JSON.stringify(payload);
const loadStart = performance.now();
const parsed = JSON.parse(raw);
const rows = prepareRows(parsed.fields, parsed.songs);
const loadMs = performance.now() - loadStart;
const start = performance.now();
const visible = recomputeRows(rows, {
  artist: { items: [{ op: 'contains', value: 'artist 1' }] },
  album: { items: [{ op: 'contains', value: 'アルバム' }] },
  'playlist:p': { items: [{ op: 'in' }] },
}, { key: 'title', direction: 'asc' }, fieldsByKey, { 'playlist:p': membership['playlist:p'] });
const recomputeMs = performance.now() - start;
console.log(JSON.stringify({ rows: count, fields: fields.length, visible: visible.length, loadMs: Number(loadMs.toFixed(2)), recomputeMs: Number(recomputeMs.toFixed(2)), payloadBytes: Buffer.byteLength(raw), gzipBytes: gzipSync(raw).byteLength }));
