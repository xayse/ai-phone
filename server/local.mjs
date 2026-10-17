import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker, { Room } from './worker.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.join(project, '.local-data');
await mkdir(dataDir, { recursive: true });
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const rooms = new Map();
const clone = value => value === undefined ? undefined : structuredClone(value);

class LocalRoom {
  constructor(id, env) {
    this.id = id;
    this.filename = path.join(dataDir, createHash('sha256').update(String(id)).digest('hex') + '.bin');
    this.items = new Map();
    this.queue = Promise.resolve();
    this.timer = null;
    this.alarmTime = null;
    this.storage = {
      get: async key => Array.isArray(key) ? new Map(key.filter(k => this.items.has(k)).map(k => [k, clone(this.items.get(k))])) : clone(this.items.get(key)),
      put: async (key, value) => {
        if (typeof key === 'string') this.items.set(key, clone(value));
        else for (const [k, v] of Object.entries(key)) this.items.set(k, clone(v));
        await this.persist();
      },
      delete: async key => {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) if (this.items.delete(k)) count++;
        await this.persist();
        return Array.isArray(key) ? count : Boolean(count);
      },
      deleteAll: async () => { this.items.clear(); await this.persist(); },
      list: async (options = {}) => new Map([...this.items].filter(([k]) => !options.prefix || k.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit || Infinity).map(([k, v]) => [k, clone(v)])),
      getAlarm: async () => this.alarmTime,
      setAlarm: async when => { this.alarmTime = Number(when instanceof Date ? when.getTime() : when); await this.persist(); this.schedule(); },
      deleteAlarm: async () => { this.alarmTime = null; clearTimeout(this.timer); await this.persist(); },
      transaction: async callback => callback(this.storage),
    };
    this.ready = this.load().then(() => {
      const initialization = [];
      const context = {
        storage: this.storage,
        blockConcurrencyWhile: fn => { const promise = Promise.resolve().then(fn); initialization.push(promise); return promise; },
        waitUntil: promise => { Promise.resolve(promise).catch(error => console.error('Background task failed:', error.message)); },
        id: { toString: () => id },
      };
      this.instance = new Room(context, env);
      return Promise.all(initialization);
    }).then(() => this.schedule());
  }
  async load() {
    try { const saved = deserialize(await readFile(this.filename)); this.items = saved.items; this.alarmTime = saved.alarmTime; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  persist() { return writeFile(this.filename, serialize({ items: this.items, alarmTime: this.alarmTime })); }
  run(callback) {
    const operation = this.queue.then(() => this.ready).then(callback);
    this.queue = operation.catch(() => {});
    return operation;
  }
  fetch(request) { return this.run(() => this.instance.fetch(request)); }
  schedule() {
    clearTimeout(this.timer);
    if (!this.alarmTime) return;
    const scheduledTime = this.alarmTime;
    this.timer = setTimeout(() => {
      this.run(async () => {
        if (this.alarmTime !== scheduledTime) return;
        this.alarmTime = null;
        await this.persist();
        await this.instance.alarm();
      }).catch(error => console.error('Room alarm failed:', error.message));
    }, Math.min(2147483647, Math.max(1, scheduledTime - Date.now())));
    this.timer.unref();
  }
}

const env = {
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || `http://localhost:${port},http://127.0.0.1:${port}`,
  HORDE_API_KEY: process.env.HORDE_API_KEY || '0000000000',
  ROOMS: {
    idFromName: name => String(name),
    get: id => {
      if (!rooms.has(id)) rooms.set(id, new LocalRoom(id, env));
      return rooms.get(id);
    },
  },
};

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://${incoming.headers.host || `localhost:${port}`}`;
    const url = new URL(incoming.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) { size += chunk.length; if (size > 65536) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(chunk); }
      const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await worker.fetch(request, env, { waitUntil: p => p.catch(e => console.error(e.message)) });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (url.pathname === '/config.js') {
      outgoing.writeHead(200, { 'Content-Type': mime['.js'], 'Cache-Control': 'no-store' });
      outgoing.end(`window.APP_CONFIG = ${JSON.stringify({ apiBase: origin })};`);
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const siteRoot = path.join(project, 'site');
    const filename = path.resolve(siteRoot, name);
    if (!filename.startsWith(siteRoot + path.sep)) { outgoing.writeHead(403); outgoing.end(); return; }
    const content = await readFile(filename);
    outgoing.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    outgoing.end(content);
  } catch (error) {
    outgoing.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    outgoing.end(JSON.stringify({ error: error.code === 'ENOENT' ? 'Не найдено' : 'Не удалось выполнить запрос' }));
    if (error.code !== 'ENOENT') console.error(error.message);
  }
});
server.listen(port, host, () => console.log(`Промптофон: http://localhost:${port}\nДанные партий сохраняются в .local-data.\nГенерация: AI Horde (${process.env.HORDE_API_KEY ? 'ключ настроен' : 'анонимный режим'}).`));
