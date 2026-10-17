/* PromptoPhone: no build step, no external frontend dependencies. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const safeGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const safeSet = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const configured = String(window.APP_CONFIG?.apiBase || '').replace(/\/$/, '');
  let apiBase = configured || safeGet('prompto.apiBase') || '';
  let mode = 'create';
  let roomCode = new URLSearchParams(location.search).get('room')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || '';
  let token = roomCode ? safeGet(`prompto.token.${roomCode}`) : '';
  let state = null;
  let screenKey = '';
  let busy = false;
  let polling = false;
  let failures = 0;
  let albumView = null;
  let lastPoll = 0;

  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function append(parent, ...nodes) { for (const node of nodes) if (node) parent.append(node); return parent; }
  function button(text, action, className = 'button primary') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node; }
  function notice(message = '') { $('notice').textContent = message; $('notice').classList.toggle('hidden', !message); }
  function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.add('hidden'), 3000); }
  function who(person) { return typeof person === 'object' && person ? person.name || 'Игрок' : person || 'Игрок'; }
  function displayImage(url, alt, className = '') {
    const image = el('img', className); image.alt = alt; image.loading = 'lazy';
    if (/^https?:\/\//i.test(url || '') || /^data:image\/(png|jpeg|webp);base64,/i.test(url || '')) image.src = url;
    else if (/^\/(?!\/)/.test(url || '')) image.src = `${apiBase}${url}`;
    image.addEventListener('error', () => { const box = el('div', 'image-error', 'Картинка временно недоступна. Попробуй обновить страницу.'); image.replaceWith(box); });
    return image;
  }
  function serverNeeded() { return !apiBase && location.hostname.endsWith('github.io'); }
  function updateServer() {
    $('server-url').value = apiBase;
    $('server-badge').textContent = apiBase ? '✓' : (serverNeeded() ? 'нужен адрес' : '');
    if (serverNeeded()) $('server-details').open = true;
  }
  async function request(path, options = {}) {
    if (serverNeeded()) throw new Error('Укажи адрес сервера игры в разделе «Подключение к серверу» под формой.');
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetch(`${apiBase}${path}`, { ...options, headers, signal: abort.signal, cache: 'no-store' });
      let result; try { result = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Проверь адрес подключения.'); }
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.message || `Ошибка сервера (${response.status}).`);
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер долго не отвечает. Попробуй ещё раз.');
      if (error instanceof TypeError) throw new Error('Не удалось подключиться к серверу. Проверь адрес и соединение.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function setMode(next) {
    mode = next; $('create-tab').setAttribute('aria-selected', mode === 'create'); $('join-tab').setAttribute('aria-selected', mode === 'join');
    $('create-fields').classList.toggle('hidden', mode !== 'create'); $('join-fields').classList.toggle('hidden', mode !== 'join'); $('room-code').required = mode === 'join';
    $('enter-button').textContent = mode === 'create' ? 'Создать комнату ↗' : 'Войти в комнату ↗';
  }
  $('create-tab').addEventListener('click', () => setMode('create'));
  $('join-tab').addEventListener('click', () => setMode('join'));
  $('room-code').addEventListener('input', () => { $('room-code').value = $('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('nickname').value = safeGet('prompto.name') || '';
  $('save-server').addEventListener('click', () => {
    let value = $('server-url').value.trim().replace(/\/$/, '');
    if (value) { try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); value = url.href.replace(/\/$/, ''); } catch { notice('Укажи полный адрес сервера, например https://имя.workers.dev'); return; } }
    apiBase = value; safeSet('prompto.apiBase', apiBase); updateServer(); notice(); toast('Адрес сервера сохранён');
  });
  $('entry-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return; busy = true; $('enter-button').disabled = true; notice();
    const name = $('nickname').value.trim(); safeSet('prompto.name', name);
    try {
      const code = $('room-code').value.trim().toUpperCase();
      const result = await request(mode === 'create' ? '/api/rooms' : `/api/rooms/${encodeURIComponent(code)}/join`, {
        method: 'POST', body: JSON.stringify(mode === 'create' ? { name, settings: { turnSeconds: Number($('turn-time').value), rounds: Number($('round-count').value), maxPlayers: 8, model: '' } } : { name })
      });
      roomCode = result.roomCode; token = result.playerToken;
      if (!roomCode || !token) throw new Error('Сервер не прислал данные входа. Попробуй ещё раз.');
      safeSet(`prompto.token.${roomCode}`, token); history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(roomCode)}`); screenKey = ''; await poll();
    } catch (error) { notice(error.message); } finally { busy = false; $('enter-button').disabled = false; updateLive(); }
  });
  $('leave').addEventListener('click', () => {
    if (!confirm('Выйти из комнаты? Ты сможешь вернуться по той же ссылке в этом браузере.')) return;
    roomCode = ''; token = ''; state = null; screenKey = ''; history.replaceState({}, '', location.pathname); $('entry').classList.remove('hidden'); $('game').classList.add('hidden'); $('how-it-works').classList.remove('hidden'); $('leave').classList.add('hidden'); $('connection').textContent = 'для друзей и фантазии'; notice();
  });
  async function act(type, extra = {}) {
    if (busy) return; busy = true; notice(); setActionDisabled(true);
    try {
      await request(`/api/rooms/${encodeURIComponent(roomCode)}/action`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ type, ...extra }) });
      if (type === 'submit') safeSet(`prompto.draft.${roomCode}.${state?.round}`, '');
      await poll(true);
    } catch (error) { notice(error.message); } finally { busy = false; setActionDisabled(false); updateLive(); }
  }
  function setActionDisabled(disabled) { document.querySelectorAll('#game button[data-action]').forEach(node => { node.disabled = disabled || node.dataset.locked === 'true'; }); }
  async function poll(force = false) {
    if (!roomCode || !token || polling) return;
    polling = true;
    try {
      state = await request(`/api/rooms/${encodeURIComponent(roomCode)}?token=${encodeURIComponent(token)}`);
      failures = 0; lastPoll = Date.now();
      $('connection').textContent = `● комната ${roomCode}`;
      if (force || !$('notice').textContent || $('notice').dataset.network === 'true') { notice(); $('notice').dataset.network = ''; }
      render();
    } catch (error) {
      failures++; $('connection').textContent = '● восстанавливаем связь';
      if (failures >= 2 || !state) { notice(error.message); $('notice').dataset.network = 'true'; }
      if (!state) { setMode('join'); $('room-code').value = roomCode; }
    } finally { polling = false; }
  }
  function actionButton(text, type, cls = 'button primary', extra = {}) { const node = button(text, () => act(type, extra), cls); node.dataset.action = type; return node; }
  function gameHeader(label, title, description) {
    const header = el('div', 'game-heading');
    append(header, el('div', 'eyebrow', label), el('h1', '', title), el('p', 'game-description', description)); return header;
  }
  function playerList() {
    const list = el('div', 'player-list');
    (state.players || []).forEach((player, i) => {
      const row = el('div', 'player'); append(row, el('span', `avatar avatar-${i % 4}`, player.name?.slice(0, 1).toUpperCase() || '?'));
      const name = el('div', 'player-name', player.name); if (player.id === state.me?.id) name.append(el('small', '', 'это ты'));
      append(row, name, el('span', 'player-status', player.submitted ? '✓ готово' : (state.phase === 'lobby' ? (player.id === state.players?.[0]?.id ? 'ведущий' : 'в игре') : 'думает…'))); list.append(row);
    }); return list;
  }
  async function invite() { const url = `${location.origin}${location.pathname}?room=${roomCode}`; try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована — отправь её друзьям'); } catch { prompt('Скопируй ссылку для друзей:', url); } }
  function buildLobby(root) {
    root.append(gameHeader('ПРИВЕТ, КОМПАНИЯ', 'Все хорошие истории начинаются здесь.', 'Зови друзей. У каждого будет своя цепочка, которую продолжат остальные.'));
    const grid = el('div', 'lobby-grid'); const left = el('div', 'panel');
    append(left, el('div', 'panel-title', 'Кто уже с нами'), el('div', 'muted', 'Для начала нужны хотя бы два игрока.'));
    const players = el('div'); players.id = 'players'; left.append(players);
    const right = el('div', 'panel room-panel'); append(right, el('span', 'section-tag', 'ВАША СЕКРЕТНАЯ КОМНАТА'), el('div', 'big-code', roomCode), button('Скопировать приглашение ↗', invite, 'button secondary wide'));
    const settings = el('div', 'settings-summary'); settings.id = 'settings-summary'; right.append(settings);
    if (state.me?.isHost) { const start = actionButton('Поехали! ✦', 'start', 'button primary wide'); start.id = 'start-game'; right.append(start); } else right.append(el('p', 'host-wait', 'Ведущий начнёт игру, когда все соберутся.'));
    append(grid, left, right); root.append(grid);
  }
  function buildWriting(root) {
    const first = !state.currentTask?.imageUrl;
    root.append(gameHeader(`ХОД ${state.round || 1} ИЗ ${state.totalRounds || state.settings?.rounds || 3}`, first ? 'С чего начнётся твоя история?' : 'Что здесь вообще происходит?', first ? 'Придумай сцену. Нейросеть нарисует её, а следующий игрок попробует угадать.' : 'Опиши то, что видишь. Твой ответ станет промптом для следующей картинки.'));
    const grid = el('div', `writing-grid ${first ? 'first-turn' : ''}`);
    const visual = el('div', 'task-visual');
    if (!first) append(visual, displayImage(state.currentTask.imageUrl, 'Картинка из цепочки, которую нужно описать', 'task-image'), el('div', 'image-caption', 'Предыдущий промпт скрыт. Доверься глазам и фантазии.'));
    else append(visual, el('div', 'idea-symbol', '✳'), el('h2', '', 'Самая странная идея — самая удачная.'), el('p', '', 'Например: «Осьминог сдаёт экзамен по вождению на Марсе».'), el('div', 'idea-mini', '✦  Кто?  +  Что делает?  +  Где?'));
    const panel = el('div', 'panel answer-panel'); const top = el('div', 'answer-top'); const timer = el('span', 'timer', ''); timer.id = 'timer'; append(top, el('span', 'section-tag', first ? 'ТВОЯ ИДЕЯ' : 'ТВОЯ ВЕРСИЯ'), timer); panel.append(top);
    const form = el('form'); form.id = 'answer-form'; const label = el('label', '', first ? 'Что нарисовать нейросети?' : 'Что нарисовано на картинке?'); label.htmlFor = 'answer';
    const input = el('textarea'); input.id = 'answer'; input.maxLength = 400; input.rows = 5; input.required = true; input.placeholder = first ? 'Кот-диджей устраивает вечеринку на Сатурне…' : 'Кажется, это…'; input.value = safeGet(`prompto.draft.${roomCode}.${state.round}`) || '';
    const count = el('span', 'character-count', `${input.value.length}/400`); input.addEventListener('input', () => { safeSet(`prompto.draft.${roomCode}.${state.round}`, input.value); count.textContent = `${input.value.length}/400`; });
    const submit = el('button', 'button primary wide', 'Передать дальше ↗'); submit.type = 'submit'; submit.dataset.action = 'submit'; submit.id = 'submit-answer';
    const languageHint = el('p', 'muted'); languageHint.id = 'language-hint';
    append(form, label, input, count, languageHint, submit, actionButton('Пропустить этот ход', 'skip', 'text-button skip-turn')); form.addEventListener('submit', event => { event.preventDefault(); const text = input.value.trim(); if (text) act('submit', { text }); }); panel.append(form);
    const sent = el('div', 'submitted hidden'); sent.id = 'submitted'; append(sent, el('div', 'success-mark', '✓'), el('h2', '', 'Идея отправлена!'), el('p', '', 'Ждём остальных. Интересно, во что превратится твоя история?')); panel.append(sent);
    const progress = el('div', 'answer-progress'); progress.id = 'answer-progress'; panel.append(progress); append(grid, visual, panel); root.append(grid);
  }
  function buildGenerating(root) {
    root.append(gameHeader('МАГИЯ В ПРОЦЕССЕ', 'Воображение вышло на смену.', 'AI Horde рисует ваши идеи. Очередь общая, поэтому иногда нужно немного подождать.'));
    const box = el('div', 'panel generation-panel'); append(box, el('div', 'generation-orbit', '✳'), el('h2', '', 'Слова превращаются в картинки'));
    const progress = el('div', 'progress-track'); const fill = el('div', 'progress-fill'); fill.id = 'generation-fill'; progress.append(fill); box.append(progress);
    const status = el('p', 'generation-status'); status.id = 'generation-status'; box.append(status); const message = el('p', 'muted'); message.id = 'generation-message'; box.append(message);
    if (state.me?.isHost) { const actions = el('div', 'generation-actions'); append(actions, actionButton('Повторить ошибки', 'retry', 'button secondary'), actionButton('Пропустить оставшиеся картинки', 'skip', 'text-button')); box.append(actions); }
    append(box, el('p', 'generation-tip', 'Пока ждёте: попробуйте угадать, кто придумал самый странный промпт.')); root.append(box);
  }
  function buildReveal(root) {
    root.append(gameHeader('ВОТ ЭТО ПОВОРОТ', 'Смотрите, до чего договорились.', 'Одна идея, несколько воображений. Пора раскрыть все превращения.'));
    const controls = el('div', 'reveal-controls'); const tabs = el('div', 'album-tabs'); tabs.id = 'album-tabs'; controls.append(tabs);
    if (state.me?.isHost) { const actions = el('div', 'reveal-actions'); const next = actionButton('Следующая цепочка →', 'reveal-next'); next.id = 'reveal-next'; append(actions, next, actionButton('Ещё одну игру', 'lobby', 'button secondary')); controls.append(actions); } else controls.append(el('p', 'muted', 'Ведущий открывает следующие цепочки.'));
    root.append(controls); const album = el('div', 'album'); album.id = 'album'; root.append(album);
  }
  function render() {
    if (!state?.phase) return;
    $('entry').classList.add('hidden'); $('how-it-works').classList.add('hidden'); $('game').classList.remove('hidden'); $('leave').classList.remove('hidden');
    const key = `${state.phase}:${state.round || 0}`;
    if (key !== screenKey) {
      screenKey = key; const root = $('game'); root.replaceChildren(); albumView = null;
      ({ lobby: buildLobby, writing: buildWriting, generating: buildGenerating, reveal: buildReveal }[state.phase] || ((r) => r.append(el('p', '', 'Ожидаем следующий ход…'))))(root);
    }
    updateLive();
  }
  function updateLive() {
    if (!state) return;
    if (state.phase === 'lobby') {
      $('players')?.replaceChildren(playerList());
      if ($('settings-summary')) $('settings-summary').textContent = `${state.settings?.rounds || 3} хода в цепочке · ${state.settings?.turnSeconds || 90} сек. на ответ · до ${state.settings?.maxPlayers || 8} игроков`;
      if ($('start-game')) { const locked = (state.players?.length || 0) < 2; $('start-game').dataset.locked = String(locked); $('start-game').disabled = busy || locked; }
    }
    if (state.phase === 'writing') {
      const submitted = !!state.hasSubmitted;
      $('answer-form')?.classList.toggle('hidden', submitted); $('submitted')?.classList.toggle('hidden', !submitted);
      const ready = (state.players || []).filter(p => p.submitted).length;
      if ($('answer-progress')) $('answer-progress').textContent = `${ready} из ${state.players?.length || 0} уже передали идею`;
      if ($('language-hint')) {
        $('language-hint').textContent = state.translationAvailable === false ? 'Для более точного рисунка напиши по-английски.' : state.translationAvailable === true ? 'Можно писать по-русски — переведём для нейросети.' : '';
        $('language-hint').classList.toggle('hidden', typeof state.translationAvailable !== 'boolean');
      }
      if ($('submit-answer')) $('submit-answer').disabled = busy || submitted;
      updateTimer();
    }
    if (state.phase === 'generating') {
      const generation = state.generation || {}; const total = generation.total || state.players?.length || 1; const done = generation.done || 0;
      if ($('generation-fill')) $('generation-fill').style.width = `${Math.min(100, Math.max(0, done / total * 100))}%`;
      if ($('generation-status')) $('generation-status').textContent = `Готово ${done} из ${total} картинок`;
      if ($('generation-message')) $('generation-message').textContent = generation.message || (generation.queued ? `В очереди: ${generation.queued}. Можно оставить эту вкладку открытой.` : 'Не закрывай вкладку. Мы сами покажем следующий ход.');
    }
    if (state.phase === 'reveal') updateAlbums();
  }
  function updateTimer() {
    const timer = $('timer'); if (!timer || !state?.deadline) return;
    const deadline = typeof state.deadline === 'number' ? state.deadline : Date.parse(state.deadline);
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; timer.classList.toggle('urgent', seconds <= 15);
    if (seconds === 0 && Date.now() - lastPoll > 2000) poll();
  }
  function updateAlbums() {
    const albums = state.album || []; const unlocked = Math.min(albums.length - 1, Number(state.revealIndex ?? albums.length - 1));
    if (!albums.length) { $('album')?.replaceChildren(el('div', 'panel', 'Цепочки скоро появятся…')); return; }
    const revealedNow = Number(state.revealIndex ?? albums.length - 1);
    if (albumView === null || albumView > unlocked || $('album').dataset.revealed !== String(revealedNow)) albumView = Math.max(0, unlocked);
    $('album').dataset.revealed = String(revealedNow);
    const tabs = $('album-tabs'); tabs.replaceChildren();
    albums.forEach((album, index) => { if (index > unlocked) return; const tab = button(`✦ ${who(album.owner)}`, () => { albumView = index; updateAlbums(); }, `album-tab ${albumView === index ? 'active' : ''}`); tabs.append(tab); });
    const current = albums[albumView]; const container = $('album'); const fingerprint = JSON.stringify({ current, albumView });
    if (container.dataset.fingerprint !== fingerprint) {
      container.dataset.fingerprint = fingerprint; container.replaceChildren();
      container.append(el('h2', 'album-title', `Цепочка ${who(current?.owner)}`)); const entries = el('div', 'chain-entries');
      (current?.entries || []).forEach((entry, index) => {
        const card = el('article', `chain-card ${entry.type === 'image' ? 'image-card' : 'text-card'}`);
        append(card, el('div', 'chain-card-top', `${String(index + 1).padStart(2, '0')} / ${entry.type === 'image' ? 'НЕЙРОСЕТЬ РИСУЕТ' : entry.type === 'error' ? 'НЕ УДАЛОСЬ НАРИСОВАТЬ' : who(entry.author)}`));
        if (entry.type === 'image' && entry.url) card.append(displayImage(entry.url, `Рисунок ${index + 1} в цепочке`, 'chain-image'));
        else card.append(el('p', entry.type === 'error' ? 'chain-error' : 'chain-text', entry.text || (entry.type === 'error' ? 'Этот рисунок потерялся по дороге. Бывает даже у нейросетей.' : 'Без подписи')));
        entries.append(card);
      }); container.append(entries);
    }
    if ($('reveal-next')) { const locked = revealedNow >= (state.players?.length || albums.length) - 1; $('reveal-next').dataset.locked = String(locked); $('reveal-next').disabled = busy || locked; $('reveal-next').textContent = locked ? 'Все цепочки открыты ✓' : 'Следующая цепочка →'; }
  }
  updateServer();
  if (roomCode) { setMode('join'); $('room-code').value = roomCode; if (token) poll(); }
  setInterval(() => { if (roomCode && token && !document.hidden) poll(); }, 3000);
  setInterval(updateTimer, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
