import { writeFile } from 'node:fs/promises';

const apiBase = (process.env.PUBLIC_API_BASE || '').trim().replace(/\/+$/, '');
if (apiBase) {
  const url = new URL(apiBase);
  if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) {
    throw new Error('PUBLIC_API_BASE must be an HTTPS server address.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PUBLIC_API_BASE must contain only the server origin, without credentials or a path.');
  }
}
await writeFile(new URL('../site/config.js', import.meta.url), `window.APP_CONFIG = ${JSON.stringify({ apiBase })};\n`, 'utf8');
console.log(apiBase ? 'Game server configured.' : 'No server address configured. The game will show the connection setup screen.');
