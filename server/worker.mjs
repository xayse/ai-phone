/** AI Phone API. The same module runs on Cloudflare and the local Node adapter. */
const ROOM_TTL = 24 * 60 * 60 * 1000;
const JOB_TIMEOUT = 15 * 60 * 1000;
const POLL_MS = 8000;
const MAX_CONCURRENT = 2;
const ATTEMPT_LEASE = 2 * 60 * 1000;
const IMAGE_CHUNK = 96 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const HORDE = 'https://aihorde.net/api/v2';
const FLUX = '@cf/black-forest-labs/flux-1-schnell';
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }
});
const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};
const randomId = () => crypto.randomUUID();
const playerToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), n => alphabet[n % alphabet.length]).join('');
const imageProvider = env => env.IMAGE_PROVIDER !== 'horde' && typeof env.AI?.run === 'function' ? 'cloudflare' : 'horde';
async function withTimeout(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Inference timeout')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const nameOf = name => {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 24) throw new HttpError(400, 'Ник должен содержать от 1 до 24 символов.');
  return name.trim();
};
async function bodyJson(request) {
  if (Number(request.headers.get('content-length')) > 16384) throw new HttpError(413, 'Слишком большой запрос.');
  const body = await request.text();
  if (body.length > 16384) throw new HttpError(413, 'Слишком большой запрос.');
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Не удалось прочитать запрос.'); }
}
function settingsOf(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  return {
    turnSeconds: clamp(settings.turnSeconds, 30, 300, 90),
    // Eight parallel albums keep even all-Cyrillic, 400-character rounds below the DO's 128 KiB value limit.
    rounds: clamp(settings.rounds, 1, 8, 3),
    maxPlayers: clamp(settings.maxPlayers, 2, 8, 8),
    model: typeof settings.model === 'string' ? settings.model.trim().slice(0, 100) : ''
  };
}
function originAllowed(origin, env) {
  if (!origin) return true;
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
function withCors(response, origin) {
  const headers = new Headers(response.headers);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    if (!originAllowed(origin, env)) return json({ error: 'Этот адрес сайта не разрешён сервером игры.' }, 403);
    let response;
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else if (request.method === 'GET' && url.pathname === '/api/health') response = json({ ok: true, service: 'ai-phone', imageProvider: imageProvider(env), generation: imageProvider(env) === 'cloudflare' ? 'Cloudflare FLUX.1 schnell + AI Horde fallback' : 'AI Horde', translationAvailable: typeof env.AI?.run === 'function' });
      else if (request.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await bodyJson(request);
        // Check collisions in the object instead of ever overwriting an existing room.
        for (let i = 0; i < 5; i++) {
          const code = roomCode();
          const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
          response = await stub.fetch(new Request(new URL('/internal/create', url), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, code })
          }));
          if (response.status !== 409) break;
        }
      } else {
        const match = url.pathname.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(?:join|action|images\/[a-f0-9-]+))?$/i);
        if (!match) throw new HttpError(404, 'Страница не найдена.');
        const code = match[1].toUpperCase();
        // Canonicalise the path; room links are intentionally case insensitive.
        url.pathname = url.pathname.replace(match[1], code);
        response = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(url, request));
      }
    } catch (error) {
      response = json({ error: error instanceof HttpError ? error.message : 'Сервер временно недоступен. Повторите попытку.' }, error.status || 500);
    }
    return withCors(response, origin);
  }
};

export class Room {
  constructor(state, env) {
    this.ctx = state;
    this.storage = state.storage;
    this.env = env;
    this.data = null;
    this.queue = Promise.resolve();
    this.ready = this.storage.get('room').then(data => { this.data = data || null; });
  }

  exclusive(fn) {
    const next = this.queue.then(async () => { await this.ready; return fn(); });
    this.queue = next.catch(() => {});
    return next;
  }

  async fetch(request) {
    return this.exclusive(async () => {
      try { return await this.handle(request); }
      catch (error) { return json({ error: error instanceof HttpError ? error.message : 'Ошибка комнаты. Попробуйте ещё раз.' }, error.status || 500); }
    });
  }

  async save() { await this.storage.put('room', this.data); }
  async schedule() {
    if (!this.data) return;
    let at = this.data.expiresAt;
    if (this.data.phase === 'writing') at = Math.min(at, this.data.deadline);
    if (this.data.phase === 'generating' && this.data.jobs.some(j => ['queued', 'processing'].includes(j.status))) {
      const freeSlot = this.data.jobs.filter(j => j.status === 'processing').length < MAX_CONCURRENT;
      const startSoon = freeSlot && this.data.jobs.some(j => j.status === 'queued');
      at = Math.min(at, Date.now() + (startSoon ? 100 : POLL_MS));
    }
    await this.storage.setAlarm(Math.max(Date.now() + 100, at));
  }
  auth(request, url) {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || (request.method === 'GET' ? url.searchParams.get('token') : null);
    const player = this.data.players.find(p => p.token === token);
    if (!player) throw new HttpError(401, 'Войдите в комнату заново.');
    return player;
  }
  host(player) {
    if (player.id !== this.data.hostId) throw new HttpError(403, 'Это действие доступно ведущему.');
  }
  chainFor(playerId) {
    const players = this.data.players;
    const index = players.findIndex(p => p.id === playerId);
    return (index - (this.data.round - 1) + players.length) % players.length;
  }

  async handle(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/internal/create') {
      if (this.data && this.data.expiresAt > Date.now()) throw new HttpError(409, 'Комната уже существует.');
      if (this.data) await this.storage.deleteAll();
      const body = await bodyJson(request);
      const player = { id: randomId(), token: playerToken(), name: nameOf(body.name) };
      this.data = {
        code: body.code, phase: 'lobby', settings: settingsOf(body.settings), players: [player], hostId: player.id,
        round: 0, totalRounds: 0, deadline: null, submissions: {}, chains: [], jobs: [], revealIndex: 0,
        createdAt: Date.now(), expiresAt: Date.now() + ROOM_TTL
      };
      await this.save(); await this.schedule();
      return json({ roomCode: this.data.code, playerToken: player.token }, 201);
    }
    if (!this.data || this.data.expiresAt <= Date.now()) throw new HttpError(404, 'Комната не найдена или уже закрыта.');
    if (request.method === 'POST' && url.pathname.endsWith('/join')) {
      if (this.data.phase !== 'lobby') throw new HttpError(409, 'Партия уже началась. Подождите следующую игру.');
      if (this.data.players.length >= this.data.settings.maxPlayers) throw new HttpError(409, 'Комната заполнена.');
      const body = await bodyJson(request);
      const name = nameOf(body.name);
      if (this.data.players.some(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new HttpError(409, 'Этот ник уже занят в комнате.');
      const player = { id: randomId(), token: playerToken(), name };
      this.data.players.push(player);
      this.data.expiresAt = Date.now() + ROOM_TTL;
      await this.save(); await this.schedule();
      return json({ roomCode: this.data.code, playerToken: player.token }, 201);
    }
    const player = this.auth(request, url);
    const imageMatch = url.pathname.match(/\/images\/([a-f0-9-]+)$/i);
    if (request.method === 'GET' && imageMatch) return this.imageResponse(imageMatch[1], player);
    // Also advance overdue turns on a browser poll: the timer remains correct when a local adapter sleeps.
    if (this.data.phase === 'writing' && this.data.deadline <= Date.now()) {
      await this.beginGeneration(); await this.save(); await this.schedule();
    }
    if (request.method === 'GET' && url.pathname === `/api/rooms/${this.data.code}`) return json(this.publicState(player, url.origin));
    if (request.method !== 'POST' || !url.pathname.endsWith('/action')) throw new HttpError(404, 'Действие не найдено.');
    const action = await bodyJson(request);
    switch (action.type) {
      case 'start': {
        this.host(player);
        if (this.data.phase !== 'lobby') throw new HttpError(409, 'Игра уже началась.');
        if (this.data.players.length < 2) throw new HttpError(409, 'Для игры нужны хотя бы два игрока.');
        this.data.totalRounds = Math.min(this.data.settings.rounds, this.data.players.length);
        this.data.round = 1;
        this.data.chains = this.data.players.map(p => ({ ownerId: p.id, owner: p.name, entries: [] }));
        this.beginWriting();
        break;
      }
      case 'submit': {
        if (this.data.phase !== 'writing') throw new HttpError(409, 'Время ответа уже закончилось.');
        if (this.data.submissions[player.id]) throw new HttpError(409, 'Ответ уже отправлен.');
        const text = typeof action.text === 'string' ? action.text.trim() : '';
        if (text.length < 2 || text.length > 400) throw new HttpError(400, 'Напишите от 2 до 400 символов.');
        this.data.submissions[player.id] = { text };
        if (this.data.players.every(p => this.data.submissions[p.id])) await this.beginGeneration();
        break;
      }
      case 'skip': {
        if (this.data.phase === 'writing') {
          if (!this.data.submissions[player.id]) this.data.submissions[player.id] = { skipped: true };
          if (this.data.players.every(p => this.data.submissions[p.id])) await this.beginGeneration();
        } else if (this.data.phase === 'generating') {
          this.host(player);
          const requests = [];
          for (const job of this.data.jobs) {
            if (['done', 'skipped'].includes(job.status)) continue;
            if (job.requestId) requests.push(job.requestId);
            job.status = 'skipped';
            this.addJobError(job, 'Генерация пропущена ведущим.');
          }
          this.finishGeneration();
          // State is saved before best-effort cancellation, so a network failure never loses the game.
          await this.save();
          const cancellation = Promise.allSettled(requests.map(id => this.cancel(id)));
          if (this.ctx.waitUntil) this.ctx.waitUntil(cancellation);
        } else throw new HttpError(409, 'Сейчас нельзя пропустить ход.');
        break;
      }
      case 'retry': {
        this.host(player);
        if (this.data.phase !== 'generating') throw new HttpError(409, 'Сейчас нечего повторять.');
        let retried = 0;
        for (const job of this.data.jobs) {
          if (job.status !== 'failed') continue;
          this.data.chains[job.chainIndex].entries = this.data.chains[job.chainIndex].entries.filter(e => e.jobId !== job.id || e.type !== 'error');
          Object.assign(job, { status: 'queued', requestId: null, startedAt: null, error: null, failures: 0, waitSeconds: 0, queuePosition: 0, attemptId: null, attemptExpiresAt: null });
          retried++;
        }
        if (!retried) throw new HttpError(409, 'Ошибок пока нет. Картинки ещё создаются.');
        if (!this.data.settings.model) { this.data.generationModel = null; this.modelLookup = null; }
        break;
      }
      case 'reveal-next': {
        this.host(player);
        if (this.data.phase !== 'reveal') throw new HttpError(409, 'Показ результатов ещё не начался.');
        this.data.revealIndex = Math.min(this.data.chains.length - 1, this.data.revealIndex + 1);
        break;
      }
      case 'lobby': {
        this.host(player);
        if (this.data.phase !== 'reveal') throw new HttpError(409, 'Сначала завершите партию.');
        await this.removeImages();
        Object.assign(this.data, { phase: 'lobby', round: 0, totalRounds: 0, deadline: null, submissions: {}, jobs: [], chains: [], revealIndex: 0 });
        break;
      }
      default: throw new HttpError(400, 'Неизвестное действие.');
    }
    this.data.expiresAt = Date.now() + ROOM_TTL;
    await this.save(); await this.schedule();
    return json(this.publicState(player, url.origin));
  }

  beginWriting() {
    this.data.phase = 'writing';
    this.data.submissions = {};
    this.data.jobs = [];
    this.data.deadline = Date.now() + this.data.settings.turnSeconds * 1000;
  }
  async beginGeneration() {
    this.data.phase = 'generating';
    this.data.deadline = null;
    this.data.generationModel = null;
    this.data.jobs = this.data.chains.map((chain, chainIndex) => {
      const assignedIndex = (chainIndex + this.data.round - 1) % this.data.players.length;
      const player = this.data.players[assignedIndex];
      const answer = this.data.submissions[player.id];
      this.data.submissions[player.id] ||= { skipped: true };
      const job = { id: randomId(), chainIndex, authorId: player.id, author: player.name, round: this.data.round, status: answer?.text ? 'queued' : 'skipped', text: answer?.text || '', failures: 0 };
      if (answer?.text) chain.entries.push({ type: 'text', author: player.name, text: answer.text, round: this.data.round, jobId: job.id });
      else this.addJobError(job, answer?.skipped ? 'Игрок пропустил ход.' : 'Игрок не успел ответить.');
      return job;
    });
    this.finishGeneration();
  }
  finishGeneration() {
    if (this.data.phase !== 'generating' || !this.data.jobs.every(j => ['done', 'skipped'].includes(j.status))) return;
    if (this.data.round >= this.data.totalRounds) {
      this.data.phase = 'reveal'; this.data.revealIndex = 0; this.data.deadline = null;
    } else {
      this.data.round++; this.beginWriting();
    }
  }
  addJobError(job, message) {
    job.error = message;
    const entries = this.data.chains[job.chainIndex].entries;
    const existing = entries.find(e => e.type === 'error' && e.jobId === job.id);
    if (existing) existing.text = message;
    else entries.push({ type: 'error', author: job.author, text: message, round: job.round, jobId: job.id });
  }
  failJob(job, message) { job.status = 'failed'; this.addJobError(job, message); }

  publicState(player, origin) {
    const data = this.data;
    const imageUrl = id => `${origin}/api/rooms/${data.code}/images/${id}?token=${encodeURIComponent(player.token)}`;
    const processing = data.jobs.filter(j => j.status === 'processing');
    const waitSeconds = Math.max(0, ...processing.map(j => j.waitSeconds || 0));
    const queuePosition = Math.max(0, ...processing.map(j => j.queuePosition || 0));
    let currentTask = null;
    if (['writing', 'generating'].includes(data.phase)) {
      const chain = data.chains[this.chainFor(player.id)];
      const previous = [...chain.entries].reverse().find(e => e.type === 'image' && e.round < data.round);
      currentTask = { chainOwner: chain.owner, ...(previous ? { imageUrl: imageUrl(previous.imageId) } : {}) };
    }
    const state = {
      code: data.code, phase: data.phase,
      players: data.players.map(p => ({ id: p.id, name: p.name, submitted: Boolean(data.submissions[p.id]) })),
      me: { id: player.id, name: player.name, isHost: player.id === data.hostId },
      settings: data.settings, round: data.round, totalRounds: data.totalRounds, deadline: data.deadline,
      translationAvailable: typeof this.env.AI?.run === 'function',
      currentTask, hasSubmitted: Boolean(data.submissions[player.id]),
      generation: {
        done: data.jobs.filter(j => ['done', 'skipped'].includes(j.status)).length,
        total: data.jobs.length,
        queued: data.jobs.filter(j => j.status === 'queued').length,
        processing: processing.length,
        failed: data.jobs.filter(j => j.status === 'failed').length,
        waitSeconds, queuePosition, provider: imageProvider(this.env),
        message: data.jobs.some(j => j.status === 'failed') ? `${data.jobs.find(j => j.status === 'failed').error} Ведущий может повторить запрос или продолжить с пропуском.` : waitSeconds > 60 ? `AI Horde оценивает ожидание примерно в ${Math.ceil(waitSeconds / 60)} мин. Время может меняться.` : processing.some(j => j.provider === 'cloudflare') ? 'Нейросеть рисует картинки. Это займёт немного времени.' : 'Картинки создаются в общей очереди AI Horde. Это может занять несколько минут.'
      }
    };
    if (data.phase === 'reveal') {
      state.revealIndex = data.revealIndex;
      state.album = data.chains.slice(0, data.revealIndex + 1).map(chain => ({
        owner: chain.owner,
        entries: chain.entries.map(e => ({ type: e.type, author: e.author, ...(e.type === 'image' ? { url: imageUrl(e.imageId) } : { text: e.text }) }))
      }));
    }
    return state;
  }
  allowedImages(player) {
    const ids = new Set();
    if (this.data.phase === 'reveal') {
      for (const chain of this.data.chains.slice(0, this.data.revealIndex + 1)) for (const entry of chain.entries) if (entry.type === 'image') ids.add(entry.imageId);
    } else if (['writing', 'generating'].includes(this.data.phase)) {
      const chain = this.data.chains[this.chainFor(player.id)];
      const previous = [...chain.entries].reverse().find(e => e.type === 'image' && e.round < this.data.round);
      if (previous) ids.add(previous.imageId);
    }
    return ids;
  }
  async imageResponse(id, player) {
    if (!this.allowedImages(player).has(id)) throw new HttpError(403, 'Эта картинка пока скрыта.');
    const meta = await this.storage.get(`image:${id}`);
    if (!meta) throw new HttpError(404, 'Картинка не найдена.');
    const chunks = [];
    for (let i = 0; i < meta.chunks; i++) {
      const chunk = await this.storage.get(`image:${id}:${i}`);
      if (!chunk) throw new HttpError(404, 'Картинка не найдена.');
      chunks.push(chunk);
    }
    return new Response(new Blob(chunks, { type: meta.mime }), { headers: {
      'Content-Type': meta.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    } });
  }
  async removeImages() {
    for (const chain of this.data.chains) for (const entry of chain.entries) {
      if (entry.type !== 'image') continue;
      const key = `image:${entry.imageId}`;
      const meta = await this.storage.get(key);
      if (meta) await this.storage.delete(Array.from({ length: meta.chunks }, (_, i) => `${key}:${i}`));
      await this.storage.delete(key);
    }
  }

  async horde(path, options = {}) {
    const headers = { apikey: this.env.HORDE_API_KEY || '0000000000', 'Client-Agent': 'AI-Phone:1.0:https://github.com/xayse/ai-phone', ...options.headers };
    const response = await fetch(`${HORDE}${path}`, { ...options, headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('AI Horde отклонил запрос. Проверьте API-ключ и текст запроса.');
      if (response.status === 429) throw new Error('AI Horde ограничил число запросов. Подождите и повторите.');
      throw new Error(`AI Horde временно недоступен (код ${response.status}).`);
    }
    return response.json();
  }
  async cancel(id) {
    try { await this.horde(`/generate/status/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* best effort */ }
  }
  async imagePrompt(job) {
    if (job.imagePrompt) return job.imagePrompt;
    let prompt = job.text;
    if (/[А-Яа-яЁё]/.test(prompt) && typeof this.env.AI?.run === 'function') {
      try {
        const response = await withTimeout(this.env.AI.run('@cf/meta/m2m100-1.2b', { text: prompt, source_lang: 'ru', target_lang: 'en' }), 20000);
        const translated = response?.translated_text;
        if (typeof translated !== 'string' || !/[A-Za-z]/.test(translated) || /[А-Яа-яЁё]/.test(translated)) throw new Error('Invalid translation');
        prompt = translated.trim().slice(0, 600);
      } catch {
        const error = new Error('Не удалось перевести описание на английский. Повторите генерацию или в следующем ходе напишите по-английски.');
        error.translationFailed = true;
        throw error;
      }
    }
    return prompt.slice(0, 600);
  }
  async readGeneration(generation) {
    if (generation.censored || generation.gen_metadata?.some(m => ['censorship', 'csam', 'nsfw'].includes(String(m.type).toLowerCase()))) throw new Error('AI Horde скрыл картинку. Попробуйте другое описание или пропустите ход.');
    let bytes;
    let mime = 'image/webp';
    if (typeof generation.img !== 'string') throw new Error('AI Horde не вернул картинку.');
    if (/^https:\/\//i.test(generation.img)) {
      // Only Horde's own image storage is allowed; never fetch arbitrary internal or player-supplied URLs.
      const url = new URL(generation.img);
      if (!(url.hostname === 'aihorde.net' || url.hostname.endsWith('.aihorde.net') || url.hostname.endsWith('.r2.dev') || url.hostname.endsWith('.r2.cloudflarestorage.com'))) throw new Error('AI Horde вернул неизвестный адрес картинки.');
      // Workers supports manual/follow only. Never follow a storage redirect to another host.
      const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
      if (!response.ok) throw new Error('Не удалось скачать картинку AI Horde.');
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Слишком большой файл картинки.');
      const type = response.headers.get('content-type')?.split(';')[0];
      if (['image/webp', 'image/png', 'image/jpeg'].includes(type)) mime = type;
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      const encoded = generation.img.replace(/^data:image\/(?:webp|png|jpeg);base64,/, '');
      if (encoded.length > MAX_IMAGE_BYTES * 1.4) throw new Error('Слишком большой файл картинки.');
      try {
        if (typeof Uint8Array.fromBase64 === 'function') bytes = Uint8Array.fromBase64(encoded);
        else {
          const binary = atob(encoded);
          bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        }
      }
      catch { throw new Error('AI Horde вернул повреждённую картинку.'); }
    }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('AI Horde вернул картинку неподходящего размера.');
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = 'image/png';
    else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
    return { bytes, mime };
  }
  async storeGeneration(generation, job) {
    return this.storeImage(await this.readGeneration(generation), job);
  }
  async storeImage({ bytes, mime }, job) {
    const entries = this.data.chains[job.chainIndex].entries;
    // Protect against repeated alarm delivery and late completions of the same attempt.
    if (entries.some(e => e.type === 'image' && e.jobId === job.id)) { job.status = 'done'; return; }
    const imageId = randomId();
    const chunks = Math.ceil(bytes.length / IMAGE_CHUNK);
    for (let i = 0; i < chunks; i++) await this.storage.put(`image:${imageId}:${i}`, bytes.slice(i * IMAGE_CHUNK, (i + 1) * IMAGE_CHUNK));
    await this.storage.put(`image:${imageId}`, { chunks, mime, size: bytes.length });
    entries.push({ type: 'image', author: job.provider === 'cloudflare' ? 'FLUX.1 schnell' : 'AI Horde', imageId, round: job.round, jobId: job.id });
    job.status = 'done'; job.imageId = imageId; job.error = null;
  }

  activeAttempt(plan) {
    if (!this.data || this.data.phase !== 'generating' || this.data.round !== plan.round) return null;
    return this.data.jobs.find(job => job.id === plan.job.id && job.status === 'processing' && job.attemptId === plan.attemptId) || null;
  }
  clearAttempt(job) { job.attemptId = null; job.attemptExpiresAt = null; }
  async updateAttempt(plan, update) {
    return this.exclusive(async () => {
      const job = this.activeAttempt(plan);
      if (!job) return false;
      await update(job);
      this.finishGeneration();
      await this.save(); await this.schedule();
      return true;
    });
  }

  // Planning and result commits hold the room lock. Translation, inference and all remote
  // requests run outside it, so participants can still poll, skip and start a new game.
  prepareGeneration() {
    const plans = [];
    const makePlan = (job, operation) => {
      job.attemptId = randomId(); job.attemptExpiresAt = Date.now() + ATTEMPT_LEASE;
      plans.push({ job: structuredClone(job), attemptId: job.attemptId, round: this.data.round,
        generationId: this.data.jobs[0]?.id, settingsModel: this.data.settings.model, operation });
    };
    for (const job of this.data.jobs.filter(j => j.status === 'processing')) {
      if (job.attemptId && job.attemptExpiresAt > Date.now()) continue;
      // A requestId always wins over new provider preferences after a deployment.
      if (job.requestId) {
        job.provider = 'horde';
        if (Date.now() - job.startedAt >= JOB_TIMEOUT) {
          this.failJob(job, 'AI Horde не успел создать картинку за 15 минут. Повторите или пропустите генерацию.');
          this.clearAttempt(job);
          plans.push({ operation: 'cancel', requestId: job.requestId });
        } else makePlan(job, 'poll');
      } else if (job.provider === 'cloudflare') {
        // Recover an interrupted/evicted CF attempt by using Horde once, rather than
        // repeatedly spending the free AI quota on the same image.
        job.provider = 'horde'; job.cloudflareAttempted = true;
        makePlan(job, 'submit');
      } else {
        this.failJob(job, 'Не удалось получить подтверждение генерации. Повторите запрос или пропустите ход.');
        this.clearAttempt(job);
      }
    }
    let active = this.data.jobs.filter(j => j.status === 'processing').length;
    for (const job of this.data.jobs.filter(j => j.status === 'queued')) {
      if (active >= MAX_CONCURRENT) break;
      job.provider = !job.cloudflareAttempted ? imageProvider(this.env) : 'horde';
      job.status = 'processing'; job.startedAt = Date.now();
      if (job.provider === 'cloudflare') job.cloudflareAttempted = true;
      makePlan(job, 'submit'); active++;
    }
    return plans;
  }

  async hordeModel(plan) {
    if (plan.settingsModel) return plan.settingsModel;
    const cached = await this.exclusive(() => this.activeAttempt(plan) ? { model: this.data.generationModel } : null);
    if (!cached) return undefined;
    if (typeof cached.model === 'string') return cached.model;
    if (this.modelLookup?.generationId !== plan.generationId) {
      this.modelLookup = { generationId: plan.generationId, promise: (async () => {
        try {
          const models = await this.horde('/status/models?type=image&min_count=1');
          const available = Array.isArray(models) ? models.filter(m => m.name && m.count > 0 && m.type !== 'text').sort((a, b) => b.count - a.count) : [];
          const preferred = available.find(m => /^(dreamshaper|deliberate)(?:\s+\d[\d.]*)?$/i.test(m.name));
          return (preferred || available.find(m => !/sdxl|\bxl\b|flux|pony/i.test(m.name)) || available[0])?.name || '';
        } catch { return ''; }
      })() };
    }
    const model = await this.modelLookup.promise;
    return await this.updateAttempt(plan, () => { this.data.generationModel = model; }) ? model : undefined;
  }

  async submitHorde(plan, prompt) {
    const model = await this.hordeModel(plan);
    if (model === undefined) return;
    if (!await this.updateAttempt(plan, job => { job.provider = 'horde'; })) return;
    const size = /sdxl|\bxl\b|flux|pony/i.test(model) ? 1024 : 512;
    const payload = {
      prompt: `${prompt} ### text, watermark, signature, blurry`,
      params: { n: 1, width: size, height: size, steps: 20, cfg_scale: 7, sampler_name: 'k_euler_a', karras: true, clip_skip: 1 },
      nsfw: false, censor_nsfw: true, r2: true, shared: false, replacement_filter: true, trusted_workers: true,
      ...(model ? { models: [model] } : {})
    };
    const result = await this.horde('/generate/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!result.id) throw new Error('AI Horde не принял запрос на генерацию.');
    const accepted = await this.updateAttempt(plan, job => {
      Object.assign(job, { provider: 'horde', requestId: result.id, startedAt: Date.now(), failures: 0, waitSeconds: 0, queuePosition: 0 });
      this.clearAttempt(job);
    });
    if (!accepted) await this.cancel(result.id);
  }

  async generateNew(plan) {
    const prompt = await this.imagePrompt(plan.job);
    // Persist the English text once, privately, before attempting either generator.
    if (!await this.updateAttempt(plan, job => { job.imagePrompt = prompt; })) return;
    if (plan.job.provider === 'cloudflare') {
      try {
        const result = await withTimeout(this.env.AI.run(FLUX, { prompt, steps: 4 }), 35000);
        if (typeof result?.image !== 'string' || !result.image) throw new Error('Cloudflare did not return an image');
        const image = await this.readGeneration({ img: `data:image/jpeg;base64,${result.image}` });
        await this.updateAttempt(plan, async job => {
          job.provider = 'cloudflare';
          await this.storeImage(image, job); job.failures = 0; this.clearAttempt(job);
        });
        return;
      } catch {
        // Quota limits, inference timeouts and unsupported requests all use the same
        // saved job and translation. No successful image or original prompt is replaced.
        if (!await this.updateAttempt(plan, job => { job.provider = 'horde'; job.cloudflareAttempted = true; })) return;
      }
    }
    await this.submitHorde(plan, prompt);
  }

  async pollHorde(plan) {
    const check = await this.horde(`/generate/check/${encodeURIComponent(plan.job.requestId)}`);
    const pending = !check.done && !(check.finished >= 1);
    const applied = await this.updateAttempt(plan, job => {
      job.waitSeconds = typeof check.wait_time === 'number' && Number.isFinite(check.wait_time) ? clamp(check.wait_time, 0, 86400, 0) : 0;
      job.queuePosition = typeof check.queue_position === 'number' && Number.isFinite(check.queue_position) ? clamp(check.queue_position, 0, 1000000, 0) : 0;
      if (check.faulted || check.is_possible === false) {
        this.failJob(job, 'Сейчас в AI Horde нет доступного исполнителя. Повторите запрос позже.'); this.clearAttempt(job);
      } else if (pending) { job.failures = 0; this.clearAttempt(job); }
    });
    if (!applied || pending || check.faulted || check.is_possible === false) return;
    const status = await this.horde(`/generate/status/${encodeURIComponent(plan.job.requestId)}`);
    if (!status.generations?.length) throw new Error('AI Horde завершил запрос без картинки.');
    const image = await this.readGeneration(status.generations[0]);
    await this.updateAttempt(plan, async job => {
      await this.storeImage(image, job); job.failures = 0; this.clearAttempt(job);
    });
  }

  async runPlan(plan) {
    if (plan.operation === 'cancel') return this.cancel(plan.requestId);
    try {
      if (plan.operation === 'poll') await this.pollHorde(plan);
      else await this.generateNew(plan);
    } catch (error) {
      let cancel = false;
      await this.updateAttempt(plan, job => {
        job.failures = (job.failures || 0) + 1;
        if (plan.operation !== 'poll' || job.failures >= 3 || /скрыл|неизвестный|подходящего|повреждённую|большой/.test(error.message)) {
          this.failJob(job, String(error.message || 'Не удалось создать картинку. Повторите запрос.').slice(0, 220));
          cancel = Boolean(job.requestId);
          if (error.translationFailed) job.cloudflareAttempted = false;
        }
        this.clearAttempt(job);
      });
      if (cancel) await this.cancel(plan.job.requestId);
    }
  }

  async alarm() {
    const plans = await this.exclusive(async () => {
      if (!this.data) return [];
      if (this.data.expiresAt <= Date.now()) {
        const cancellations = this.data.jobs.filter(j => j.requestId && j.status === 'processing').map(j => ({ operation: 'cancel', requestId: j.requestId }));
        await this.storage.deleteAll(); this.data = null;
        if (this.storage.deleteAlarm) await this.storage.deleteAlarm();
        return cancellations;
      }
      if (this.data.phase === 'writing' && this.data.deadline <= Date.now()) await this.beginGeneration();
      const tasks = this.data.phase === 'generating' ? this.prepareGeneration() : [];
      await this.save(); await this.schedule();
      return tasks;
    });
    const work = Promise.allSettled(plans.map(plan => this.runPlan(plan)));
    if (this.ctx.waitUntil) this.ctx.waitUntil(work);
    else await work; // Minimal Node storage mocks can await a whole batch without a runtime context.
  }
}
