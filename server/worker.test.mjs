import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Room } from './worker.mjs';

class Storage {
  constructor() { this.map = new Map(); this.alarm = null; this.writes = []; }
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) {
    if (value instanceof Uint8Array) assert.ok(value.byteLength <= 100 * 1024, 'image value exceeds the DO-safe chunk limit');
    else assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024, 'record exceeds the DO value limit');
    this.writes.push(key); this.map.set(key, structuredClone(value));
  }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k); }
  async deleteAll() { this.map.clear(); }
  async setAlarm(at) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}
function harness() {
  const rooms = new Map();
  const env = { ALLOWED_ORIGIN: 'https://xayse.github.io', HORDE_API_KEY: 'test-secret' };
  env.ROOMS = {
    idFromName: code => code,
    get(code) {
      if (!rooms.has(code)) rooms.set(code, new Room({ storage: new Storage() }, env));
      return rooms.get(code);
    }
  };
  const call = async (path, { method = 'GET', token, body, origin } = {}) => {
    const response = await worker.fetch(new Request(`https://api.example${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    }), env);
    return { response, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : null };
  };
  return { rooms, env, call };
}
async function party(h, { count = 3, rounds = 3 } = {}) {
  const created = await h.call('/api/rooms', { method: 'POST', body: { name: 'Аня', settings: { rounds, maxPlayers: 8, turnSeconds: 30 } } });
  assert.equal(created.response.status, 201);
  const code = created.body.roomCode;
  const tokens = [created.body.playerToken];
  const names = ['Аня', 'Борис', 'Вика', 'Глеб', 'Даша'];
  for (let i = 1; i < count; i++) {
    const joined = await h.call(`/api/rooms/${code}/join`, { method: 'POST', body: { name: names[i] } });
    assert.equal(joined.response.status, 201); tokens.push(joined.body.playerToken);
  }
  const action = (index, type, text) => h.call(`/api/rooms/${code}/action`, { method: 'POST', token: tokens[index], body: { type, ...(text ? { text } : {}) } });
  const state = index => h.call(`/api/rooms/${code}?token=${tokens[index]}`);
  return { code, tokens, action, state, room: h.rooms.get(code), names };
}
function mockHorde(t, { imageBytes = 200000 } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  let serial = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('/status/models?')) return Response.json([{ name: 'Dreamshaper', count: 3, type: 'image' }]);
    if (url.endsWith('/generate/async')) return Response.json({ id: `request-${++serial}` });
    if (url.includes('/generate/check/')) return Response.json({ done: true, finished: 1, faulted: false });
    if (url.includes('/generate/status/') && init.method === 'DELETE') return Response.json({ generations: [] });
    if (url.includes('/generate/status/')) return Response.json({ generations: [{ img: Buffer.alloc(imageBytes, 12).toString('base64'), censored: false }] });
    throw new Error(`Unexpected outgoing URL ${url}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}
async function completeGeneration(room) {
  for (let i = 0; i < 20 && room.data.phase === 'generating'; i++) await room.alarm();
  assert.notEqual(room.data.phase, 'generating');
}

test('creation, authentication, host permissions, and strict CORS', async () => {
  const h = harness(); const p = await party(h);
  assert.equal((await h.call(`/api/rooms/${p.code}`)).response.status, 401);
  assert.equal((await h.call(`/api/rooms/${p.code}?token=wrong`)).response.status, 401);
  assert.equal((await p.action(1, 'start')).response.status, 403);
  const state = (await p.state(0)).body;
  assert.equal(state.phase, 'lobby'); assert.equal(state.me.isHost, true);
  assert.ok(!JSON.stringify(state).includes(p.tokens[1]));
  assert.ok(!JSON.stringify(state).includes('test-secret'));
  const denied = await h.call('/api/health', { origin: 'https://evil.example' });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null);
  const allowed = await h.call('/api/health', { origin: 'https://xayse.github.io' });
  assert.equal(allowed.response.headers.get('Access-Control-Allow-Origin'), 'https://xayse.github.io');
  assert.equal((await h.call('/api/health', { origin: 'http://localhost:8080' })).response.status, 200);
  const preflight = await h.call('/api/rooms', { method: 'OPTIONS', origin: 'https://xayse.github.io' });
  assert.equal(preflight.response.status, 204);
});

test('parallel chains rotate, hide prompts, protect images, and reveal albums progressively', async t => {
  const outgoing = mockHorde(t);
  const h = harness(); const p = await party(h);
  assert.equal((await p.action(0, 'start')).body.phase, 'writing');
  for (let i = 0; i < 3; i++) assert.equal((await p.state(i)).body.currentTask.chainOwner, p.names[i]);
  assert.equal((await p.action(0, 'submit', 'СЕКРЕТ кот в ракете')).body.hasSubmitted, true);
  const other = (await p.state(1)).body;
  assert.ok(!JSON.stringify(other).includes('СЕКРЕТ')); assert.equal(other.album, undefined);
  await p.action(1, 'submit', 'Собака на скейте'); await p.action(2, 'submit', 'Рыба у компьютера');
  assert.equal(p.room.data.phase, 'generating');
  await p.room.alarm();
  assert.equal(outgoing.filter(r => r.url.endsWith('/generate/async')).length, 2, 'only two jobs run concurrently');
  const firstGeneration = outgoing.find(r => r.url.endsWith('/generate/async'));
  const payload = JSON.parse(firstGeneration.init.body);
  assert.equal(payload.nsfw, false); assert.equal(payload.censor_nsfw, true); assert.equal(payload.shared, false);
  assert.deepEqual(payload.models, ['Dreamshaper']);
  assert.equal(firstGeneration.init.headers.apikey, 'test-secret');
  await completeGeneration(p.room);
  assert.equal(p.room.data.round, 2);
  for (let i = 0; i < 3; i++) {
    const view = (await p.state(i)).body;
    assert.equal(view.currentTask.chainOwner, p.names[(i + 2) % 3]);
    assert.ok(view.currentTask.imageUrl); assert.ok(!JSON.stringify(view).includes('СЕКРЕТ'));
    const image = await h.call(view.currentTask.imageUrl.replace('https://api.example', ''));
    assert.equal(image.response.status, 200); assert.equal((await image.response.arrayBuffer()).byteLength, 200000);
    const imagePath = new URL(view.currentTask.imageUrl).pathname;
    const denied = await h.call(`${imagePath}?token=${p.tokens[(i + 1) % 3]}`);
    assert.equal(denied.response.status, 403, 'another participant cannot fetch this assigned image');
  }
  for (let round = 2; round <= 3; round++) {
    for (let i = 0; i < 3; i++) await p.action(i, 'submit', `Ответ ${round} игрока ${i}`);
    await completeGeneration(p.room);
  }
  const final = (await p.state(1)).body;
  assert.equal(final.phase, 'reveal'); assert.equal(final.album.length, 1); assert.equal(final.album[0].entries.length, 6);
  assert.equal(final.album[0].entries[0].text, 'СЕКРЕТ кот в ракете');
  const unopenedId = p.room.data.chains[1].entries.find(e => e.type === 'image').imageId;
  assert.equal((await h.call(`/api/rooms/${p.code}/images/${unopenedId}?token=${p.tokens[0]}`)).response.status, 403);
  assert.equal((await p.action(1, 'reveal-next')).response.status, 403);
  assert.equal((await p.action(0, 'reveal-next')).body.album.length, 2);
  assert.equal((await h.call(`/api/rooms/${p.code}/images/${unopenedId}?token=${p.tokens[1]}`)).response.status, 200);
  await p.action(0, 'reveal-next');
  assert.equal((await p.state(2)).body.album.length, 3);
  const lobby = await p.action(0, 'lobby');
  assert.equal(lobby.body.phase, 'lobby'); assert.equal(lobby.body.players.length, 3);
  assert.equal([...p.room.storage.map.keys()].filter(k => k.startsWith('image:')).length, 0);
});

test('late answers auto-skip and carry the last successful picture through a skipped round', async t => {
  mockHorde(t, { imageBytes: 32 });
  const h = harness(); const p = await party(h);
  await p.action(0, 'start');
  for (let i = 0; i < 3; i++) await p.action(i, 'submit', `Первый промпт ${i}`);
  await completeGeneration(p.room);
  const originalImages = p.room.data.chains.map(c => c.entries.find(e => e.type === 'image').imageId);
  p.room.data.deadline = Date.now() - 1;
  await p.room.alarm();
  assert.equal(p.room.data.phase, 'writing'); assert.equal(p.room.data.round, 3);
  for (let i = 0; i < 3; i++) {
    const state = (await p.state(i)).body;
    const chainIndex = (i + 1) % 3;
    assert.ok(state.currentTask.imageUrl.includes(originalImages[chainIndex]));
    assert.equal(state.hasSubmitted, false);
  }
  for (let i = 0; i < 3; i++) await p.action(i, 'skip');
  assert.equal(p.room.data.phase, 'reveal');
  assert.ok(p.room.data.chains[0].entries.some(e => e.type === 'error' && e.text.includes('не успел')));
});

test('generation timeout waits for the host, supports retry and skip, and keeps completed work', async t => {
  mockHorde(t, { imageBytes: 32 });
  const h = harness(); const p = await party(h, { count: 2, rounds: 1 });
  await p.action(0, 'start');
  await p.action(0, 'submit', 'Лягушка с зонтом'); await p.action(1, 'submit', 'Ёжик в лодке');
  await p.room.alarm();
  for (const job of p.room.data.jobs) job.startedAt = Date.now() - 301000;
  await p.room.alarm();
  const state = (await p.state(0)).body;
  assert.equal(state.phase, 'generating'); assert.equal(state.generation.failed, 2);
  assert.equal((await p.action(1, 'retry')).response.status, 403);
  assert.equal((await p.action(0, 'retry')).body.generation.failed, 0);
  assert.ok(p.room.data.chains.every(c => !c.entries.some(e => e.type === 'error')));
  await p.room.alarm(); await p.room.alarm();
  assert.equal(p.room.data.phase, 'reveal');
  await p.action(0, 'lobby'); await p.action(0, 'start');
  await p.action(0, 'submit', 'Чайник в пустыне'); await p.action(1, 'submit', 'Утка на луне');
  await p.room.alarm();
  assert.equal((await p.action(1, 'skip')).response.status, 403);
  assert.equal((await p.action(0, 'skip')).body.phase, 'reveal');
  assert.ok(p.room.data.chains.every(c => c.entries.some(e => e.type === 'error')));
});

test('malformed input, room capacity, duplicate submissions, and round bounds', async () => {
  const h = harness();
  assert.equal((await h.call('/api/rooms', { method: 'POST', body: { name: ' ' } })).response.status, 400);
  const p = await party(h, { count: 2, rounds: 12 });
  assert.equal((await h.call(`/api/rooms/${p.code}/join`, { method: 'POST', body: { name: 'Аня' } })).response.status, 409);
  await p.action(0, 'start');
  assert.equal(p.room.data.totalRounds, 2, 'each player visits a chain at most once');
  assert.equal((await h.call(`/api/rooms/${p.code}/join`, { method: 'POST', body: { name: 'Поздний' } })).response.status, 409);
  assert.equal((await p.action(0, 'submit', 'x')).response.status, 400);
  await p.action(0, 'submit', 'Нормальный ответ');
  assert.equal((await p.action(0, 'submit', 'Второй ответ')).response.status, 409);
  const restored = new Room({ storage: p.room.storage }, h.env);
  const response = await restored.fetch(new Request(`https://api.example/api/rooms/${p.code}?token=${p.tokens[0]}`));
  assert.equal((await response.json()).hasSubmitted, true, 'room survives object reconstruction');
});

test('a fully idle room expires and removes its stored records', async () => {
  const h = harness(); const p = await party(h, { count: 2 });
  p.room.data.expiresAt = Date.now() - 1;
  await p.room.alarm();
  assert.equal(p.room.data, null); assert.equal(p.room.storage.map.size, 0);
  assert.equal((await p.state(0)).response.status, 404);
});

test('Russian prompts translate once for Horde while the album keeps the original wording', async t => {
  const outgoing = mockHorde(t, { imageBytes: 32 });
  const h = harness();
  const translations = [];
  h.env.AI = { run: async (model, input) => {
    translations.push({ model, input });
    return { translated_text: 'A cheerful octopus is cooking pancakes on the Moon' };
  } };
  const p = await party(h, { count: 2, rounds: 1 });
  await p.action(0, 'start');
  await p.action(0, 'submit', 'Весёлый осьминог печёт блины на Луне');
  await p.action(1, 'submit', 'A dog drives a tiny blue car');
  await completeGeneration(p.room);
  assert.equal(translations.length, 1);
  assert.equal(translations[0].model, '@cf/meta/m2m100-1.2b');
  assert.equal(translations[0].input.source_lang, 'russian');
  assert.equal(translations[0].input.target_lang, 'english');
  const sent = outgoing.filter(r => r.url.endsWith('/generate/async')).map(r => JSON.parse(r.init.body).prompt);
  assert.ok(sent[0].startsWith('A cheerful octopus is cooking pancakes on the Moon'));
  assert.ok(sent[1].startsWith('A dog drives a tiny blue car'));
  const final = (await p.state(0)).body;
  assert.equal(final.translationAvailable, true);
  assert.equal(final.album[0].entries[0].text, 'Весёлый осьминог печёт блины на Луне');
  assert.ok(!JSON.stringify(final).includes('cheerful octopus'));
  assert.equal((await h.call('/api/health')).body.translationAvailable, true);
});

test('failed translation stops an unrelated Horde request and the host can retry it', async t => {
  const outgoing = mockHorde(t, { imageBytes: 32 });
  const h = harness();
  let available = false;
  let calls = 0;
  h.env.AI = { run: async () => {
    calls++;
    if (!available) throw new Error('temporary failure');
    return { translated_text: 'A frog wearing a purple hat' };
  } };
  const p = await party(h, { count: 2, rounds: 1 });
  await p.action(0, 'start');
  await p.action(0, 'submit', 'Лягушка в фиолетовой шляпе'); await p.action(1, 'skip');
  await p.room.alarm();
  const failed = (await p.state(0)).body;
  assert.equal(failed.phase, 'generating'); assert.equal(failed.generation.failed, 1);
  assert.match(failed.generation.message, /Не удалось перевести/);
  assert.equal(outgoing.filter(r => r.url.endsWith('/generate/async')).length, 0);
  available = true;
  await p.action(0, 'retry'); await completeGeneration(p.room);
  assert.equal(calls, 2);
  assert.equal(p.room.data.chains[0].entries[0].text, 'Лягушка в фиолетовой шляпе');
  assert.equal((await p.state(0)).body.generation.failed, 0);
  const noAI = harness();
  assert.equal((await noAI.call('/api/health')).body.translationAvailable, false);
});
