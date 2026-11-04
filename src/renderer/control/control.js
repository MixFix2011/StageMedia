(() => {
	'use strict';
	const $ = s => document.querySelector(s);
	const api = window.api;

	const ACTIONS = {
		playPause: 'Пауза / продолжить видео', next: 'Следующий', prev: 'Предыдущий',
		black: 'Чёрный экран (вкл/выкл)', fullscreen: 'Полный экран / окно вывода', settings: 'Настройки', show: 'Показать выбранный',
		panic: '🚨 ПАНИКА (скрыть вывод)' // <--- НОВАЯ КОМАНДА
	};
	const FIELDS = [
		['h', 'Вывод'],
		['outputFullscreen', 'check', 'Полноэкранный вывод (если выбран другой монитор, не тот, где управление)'],
		['fit', 'select', 'Вписывание', [['contain', 'Вписать целиком (contain)'], ['cover', 'Заполнить экран (cover)']]],
		['fadeMs', 'range', 'Плавный переход, мс (0 = мгновенно)', 0, 2000, 50],
		['keepAwake', 'check', 'Не давать компьютеру и экрану засыпать'],
		['h', 'Видео'],
		['muted', 'check', 'Выключить звук'],
		['volume', 'range', 'Громкость, %', 0, 100, 1],
		['loopVideo', 'check', 'Зациклить видео'],
		['h', 'Показ'],
		['previewPlayVideo', 'check', 'Проигрывать видео в превью (нагрузка на ПК)'],
		['autoAdvance', 'check', 'Автопереход (слайд-шоу)'],
		['imageDuration', 'range', 'Время показа фото, сек', 1, 120, 1],
		['advanceAfterVideo', 'check', 'После окончания видео переходить дальше'],
		['loopQueue', 'check', 'Зациклить очередь'],
		['onError', 'select', 'При ошибке файла', [['skip', 'Пропустить, показать следующий'], ['stay', 'Оставить прежний кадр'], ['black', 'Чёрный экран']]],
		['h', 'Защита'],
		['confirmClear', 'check', 'Подтверждать очистку очереди'],
		['confirmClose', 'check', 'Подтверждать закрытие окна управления']
	];
	let selectedQueueIds = new Set();
	let lastQueueIndex = -1; // Запоминает последний клик
	let selectedExpPaths = new Set();
	let lastClickedIndex = -1;
	let currentExpEntries = [];
	let isExplorer = false;
	let expCurrentDir = null;
	let expParentDir = null;
	let collapsedDirs = new Set();
	let S = {}, items = [], curId = null, selId = null, blackOn = true, outInfo = null;
	let autoTimer = null, autoPaused = false, lastGoodId = null, errStreak = 0, lastDir = 1;
	let view = 'list', vs = { t: 0, d: 0, paused: true }, rebinding = null, previewFor = null;
	let modalEl = null, confirmOpen = false, noticeT = null, dragId = null;
	const thumbs = new Map();
	function updateVolumeUI() {
		const vr = $('#volRange');
		if (!vr) return;

		// Если значение сломалось (NaN, null или пусто), ставим 100 по умолчанию
		let vol = Number(S.volume);
		if (isNaN(vol) || vol < 0 || vol > 100) vol = 100;
		S.volume = vol; // Исправляем настройки в памяти

		vr.value = vol;
		$('#volText').textContent = vol + '%';
		$('#volIcon').textContent = vol === 0 ? '🔇' : (vol < 50 ? '🔉' : '🔊');
	}
	const preloadedIds = new Set(); // Здесь храним ID готовых файлов

	// ---------- утилиты ----------
	const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	const idx = id => items.findIndex(i => i.id === id);
	const byId = id => items[idx(id)];
	const fmtT = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
	const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' ГБ' : b > 1e6 ? (b / 1e6).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1e3)) + ' КБ';
	const strip = it => ({ id: it.id, name: it.name, kind: it.kind, ext: it.ext, url: it.url });
	const keyName = c => {
		if (!c) return 'Не задано'; // Защита: если клавиши нет, выводим текст
		const map = { Space: 'Пробел', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter' };
		return map[c] || String(c).replace(/^(Key|Digit)/, '');
	};
	const outOpts = () => ({
		fit: S.fit, fadeMs: S.fadeMs, muted: S.muted, volume: S.volume / 100,
		loopVideo: S.loopVideo,
		bgType: S.bgType, bgColor: S.bgColor, bgImage: S.bgImage // <--- Новые поля
	});
	const persist = () => api.saveQueue({ items: items.map(({ error, ...r }) => r), curId: curId || selId });
	const getThumb = (it, size) => { const k = it.id + size; if (!thumbs.has(k)) thumbs.set(k, api.thumb(it.path, size).catch(() => null)); return thumbs.get(k); };

	function notice(text, kind) {
		const n = $('#notice'); n.textContent = text; n.className = 'notice ' + (kind || '');
		clearTimeout(noticeT);
		if (kind !== 'bad') noticeT = setTimeout(() => { n.className = 'notice hidden'; }, 4000);
	}

	// ---------- очередь ----------
	function addItems(list) {
		preloadedIds.clear(); // Сбрасываем статусы
		if (!list || list.length === 0) return;
		items.push(...list);
		if (!selId) selId = items[0].id;
		persist(); renderQueue(); updateNow();
		notice('Добавлено файлов: ' + list.length, 'ok');
	}

	function removeItem(id) {
		preloadedIds.clear(); // Сбрасываем статусы
		if (id === curId) return notice('Нельзя убрать файл, который сейчас на экране', 'bad');
		const i = idx(id);
		items.splice(i, 1);
		if (selId === id) {
			const nextItem = items[i] || items[i - 1] || {};
			selId = nextItem.id || null;
		}
		persist(); renderQueue(); updateNow();
	}

	async function clearQueue() {
		preloadedIds.clear(); // Сбрасываем статусы
		if (!items.length) return;
		const ok = await confirmDlg('Очистить очередь?', 'Все файлы будут убраны из очереди, экран станет чёрным.', 'Очистить');
		if (S.confirmClear && !ok) return;
		blackout(); items = []; curId = null; selId = null; previewFor = null;
		persist(); renderQueue(); updateNow();
	}

	const thumbObs = new IntersectionObserver(es => es.forEach(async en => {
		if (!en.isIntersecting) return;
		thumbObs.unobserve(en.target);
		const it = byId(en.target.dataset.id); if (!it) return;
		const u = await getThumb(it, 240);
		if (u) en.target.querySelector('img').src = u;
	}), { root: $('#queue'), rootMargin: '300px' });

	function renderQueue() {
		const q = $('#queue'); q.className = view; q.replaceChildren();
		const frag = document.createDocumentFragment();

		const groups = new Map();
		items.forEach((it, i) => {
			const dir = it.dir || 'Разное';
			if (!groups.has(dir)) groups.set(dir, []);
			groups.get(dir).push({ item: it, index: i });
		});

		groups.forEach((groupItems, dirPath) => {
			const isCollapsed = collapsedDirs.has(dirPath);

			const header = document.createElement('div');
			header.className = 'folder-header';
			const folderName = dirPath.split(/[/\\]/).pop() || dirPath;

			// Запоминаем иконку, чтобы менять её при клике
			header.innerHTML = '<span class="folder-icon" style="margin-right:8px;">' + (isCollapsed ? '📁' : '📂') + '</span>' +
				'<b>' + esc(folderName) + '</b>' +
				'<span style="margin-left:auto; color:#8b93a3; font-size:12px;">' + groupItems.length + ' файлов</span>';
			header.title = dirPath;

			// Создаем обертку для контента (для анимации)
			const contentWrapper = document.createElement('div');
			contentWrapper.className = 'folder-content' + (isCollapsed ? ' collapsed' : '');

			const inner = document.createElement('div');
			inner.className = 'folder-inner';

			// Наполняем внутренний контейнер файлами
			groupItems.forEach(({ item: it, index: i }) => {
				const row = document.createElement('div');
				row.className = 'item';
				row.dataset.id = it.id;
				row.draggable = true;

				// Логика выделения (Ctrl и Shift)
				row.onmousedown = (e) => {
					if (e.detail === 2) return; // Игнорируем двойной клик

					const isCtrl = e.ctrlKey || e.metaKey;
					const isShift = e.shiftKey;

					if (isShift && lastQueueIndex !== -1) {
						if (!isCtrl) selectedQueueIds.clear();
						const start = Math.min(lastQueueIndex, i);
						const end = Math.max(lastQueueIndex, i);
						for (let j = start; j <= end; j++) {
							selectedQueueIds.add(items[j].id);
						}
					} else if (isCtrl) {
						if (selectedQueueIds.has(it.id)) selectedQueueIds.delete(it.id);
						else selectedQueueIds.add(it.id);
						lastQueueIndex = i;
					} else {
						selectedQueueIds.clear();
						selectedQueueIds.add(it.id);
						lastQueueIndex = i;
					}

					// Обновляем визуальное выделение
					const q = $('#queue');
					q.querySelectorAll('.item').forEach(r => {
						r.classList.toggle('selected', selectedQueueIds.has(r.dataset.id));
					});

					const btn = $('#floatingDeleteBtn');
					if (btn) btn.style.display = selectedQueueIds.size > 0 ? 'flex' : 'none';
				};

				const kindIcon = it.kind === 'video' ? '▶' : '';
				const kindText = it.kind === 'video' ? 'видео' : 'фото';

				row.innerHTML = '<div class="th"><img alt=""><span class="kind">' + kindIcon + '</span><span class="preload-status" style="position:absolute; left:4px; top:4px; font-size:12px; text-shadow:0 0 3px #000;"></span></div>' +
					'<div class="meta"><b>' + (i + 1) + '. ' + esc(it.name) + '</b><small>' + kindText + ' · ' + fmtSize(it.size) + '</small></div>' +
					'<span class="tag"></span><button class="rm" title="Убрать из очереди">✕</button>';
				inner.append(row);
				thumbObs.observe(row);
			});

			contentWrapper.append(inner);

			// Обработчик клика по папке (БЕЗ перерисовки всего списка!)
			header.onclick = () => {
				const isNowCollapsed = contentWrapper.classList.toggle('collapsed');
				header.querySelector('.folder-icon').textContent = isNowCollapsed ? '📁' : '📂';

				if (isNowCollapsed) {
					collapsedDirs.add(dirPath);
				} else {
					collapsedDirs.delete(dirPath);
				}
			};

			frag.append(header);
			frag.append(contentWrapper);
		});

		q.append(frag);
		applyFilter();
		mark();
		$('#count').textContent = 'Файлов в очереди: ' + items.length;
	}

	function mark() {
		const nextId = curId ? (neighbor(curId, 1) || {}).id : null;
		for (const row of $('#queue').querySelectorAll('.item')) {
			const id = row.dataset.id;
			const it = byId(id);
			if (!it) continue;

			const bad = it.missing || it.error;
			row.classList.toggle('cur', id === curId && !blackOn);
			row.classList.toggle('sel', id === selId);
			row.classList.toggle('next', id === nextId && id !== curId);
			row.classList.toggle('bad', !!bad);
			row.querySelector('.tag').textContent = bad ? 'ОШИБКА' : id === curId ? (blackOn ? 'ЧЁРНЫЙ' : 'НА ЭКРАНЕ') : id === nextId ? 'СЛЕДУЮЩИЙ' : '';
			row.title = bad ? (it.error || 'Файл недоступен: ' + it.path) : it.path;

			// Отрисовка статуса предзагрузки (ставим галочку или часики)
			const statusEl = row.querySelector('.preload-status');
			if (statusEl) {
				if (preloadedIds.has(id)) {
					statusEl.textContent = '🟢'; // Файл готов
				} else if (id === curId || id === nextId) {
					statusEl.textContent = '⏳'; // Файл в процессе
				} else {
					statusEl.textContent = '';
				}
			}
		}
	}

	function applyFilter() {
		const f = $('#search').value.trim().toLowerCase();
		for (const row of $('#queue').children) row.style.display = !f || (byId(row.dataset.id).name.toLowerCase().includes(f)) ? '' : 'none';
	}

	function scrollToCur() {
		const r = $('.item[data-id="' + curId + '"]');
		if (r) r.scrollIntoView({ block: 'nearest' });
	}

	function neighbor(baseId, dir) {
		let i = idx(baseId) + dir;
		if (i >= items.length) { if (!S.loopQueue) return null; i = 0; }
		if (i < 0) { if (!S.loopQueue) return null; i = items.length - 1; }
		return items[i] || null;
	}

	function step(dir, baseId) {
		if (!items.length) return;
		const b = baseId !== undefined ? baseId : curId;
		let n;
		if (b == null || idx(b) < 0) n = byId(selId) || items[0];
		else n = neighbor(b, dir);
		if (!n) return notice(dir > 0 ? 'Конец очереди' : 'Начало очереди');
		showItem(n.id, { dir });
	}
	async function showItem(id, { dir = 1 } = {}) {
		const it = byId(id); if (!it) return;
		clearAuto(); selId = id; lastDir = dir;
		if (!(await api.exists(it.path))) return onItemError(it, 'Файл не найден или недоступен: ' + it.path);
		it.missing = false; it.error = null;
		api.out({ type: 'show', item: strip(it), opts: outOpts() });
		curId = id; blackOn = false; vs = { t: 0, d: 0, paused: false };

		// Здесь я убрал обратные кавычки, чтобы они снова не потерялись
		api.log('SHOW', (idx(id) + 1) + '. ' + it.name);

		updateNow(); mark(); scrollToCur(); persist();
		preloadAround(idx(id));
	}

	function preloadAround(i) {
		const pick = [items[i + 1] || (S.loopQueue && items[0]), items[i + 2], items[i - 1]]
			.filter(it => it && !it.missing && !it.error);
		api.out({ type: 'preload', items: pick.map(strip) });
	}

	function onItemError(it, msg) {
		it.error = msg;
		api.log('ERROR', it.name + ': ' + msg);
		notice(it.name + ': ' + msg, 'bad');

		errStreak++;
		if (curId === it.id) curId = lastGoodId;
		clearAuto(); updateNow(); mark();

		if (S.onError === 'skip' && errStreak < items.length) {
			setTimeout(() => step(lastDir, it.id), 500);
		} else if (S.onError === 'black') {
			blackout();
		}
	}

	function blackout() {
		api.out({ type: 'black', on: true });
		if (!blackOn) api.log('STOP', 'Чёрный экран');
		blackOn = true; clearAuto(); updateNow(); mark();

		const vid = $('#prevVid');
		if (vid) vid.pause(); // Ставим на паузу видео в превью
	}

	function toggleBlack() {
		if (!blackOn) return blackout();
		if (!curId) return notice('Нет файла для показа — выберите файл и нажмите «Показать»');
		api.out({ type: 'black', on: false }); blackOn = false;
		api.log('SHOW', 'Возврат с чёрного экрана'); updateNow(); mark(); startAuto();
	}

	// Автопереход
	function clearAuto() {
		clearTimeout(autoTimer);
		autoTimer = null;
		const b = $('#bar');
		b.style.transition = 'none';
		b.style.width = '0';
	}

	function startAuto() {
		clearAuto();
		const it = byId(curId);
		if (blackOn || it.kind !== 'image' || !S.autoAdvance || autoPaused) return;
		const b = $('#bar');
		b.getBoundingClientRect();

		// Здесь заменено на плюсы, чтобы не искать кавычки
		b.style.transition = 'width ' + S.imageDuration + 's linear';
		b.style.width = '100%';

		autoTimer = setTimeout(() => step(1, curId), S.imageDuration * 1000);
	}

	// после смены монитора/падения окна вывода — восстановить состояние
	function resync() {
		api.out({ type: 'opts', opts: outOpts() });
		const it = byId(curId);
		if (it && !blackOn) api.out({ type: 'show', item: strip(it), opts: { ...outOpts(), fadeMs: 0 } });
		else api.out({ type: 'black', on: true });
	}

	// ---------- события окна вывода ----------
	api.on('out:event', ev => {
		switch (ev.type) {
			case 'ready': resync(); break;
			case 'preloaded':
				preloadedIds.add(ev.id); // Запоминаем, что файл загружен
				mark();                  // Перерисовываем список
				break;
			case 'crashed': notice('Окно вывода было перезапущено после сбоя', 'bad'); break;
			case 'shown':
				if (ev.id !== curId) break;
				lastGoodId = ev.id;
				errStreak = 0;
				notice('Показано за ' + ev.ms + ' мс', 'ok');
				startAuto();
				break;
			case 'time':
				if (ev.id === curId) {
					vs = { t: ev.t, d: ev.d, paused: ev.paused };
					updateProgress();
					updateNow(true);

					const vid = $('#prevVid');
					// Синхронизируем только если настройка включена и видео отображается
					if (S.previewPlayVideo && vid && vid.style.display !== 'none') {
						if (Math.abs(vid.currentTime - ev.t) > 0.5) vid.currentTime = ev.t;
						if (ev.paused && !vid.paused) vid.pause();
						if (!ev.paused && vid.paused) vid.play().catch(() => { });
					}
				}
				break;
				break;
			case 'ended':
				if (ev.id !== curId) break;
				if (S.autoAdvance && S.advanceAfterVideo && !blackOn) step(1, curId);
				else notice('Видео завершено');
				break;
			case 'error':
				const it = byId(ev.id);
				if (it) onItemError(it, ev.message);
				break;
		}
	});

	api.on('displays:changed', info => {
		const was = outInfo && outInfo.mode; outInfo = info; updateOut();
		if (was !== info.mode) {
			if (info.mode === 'none') notice('⚠ Монитор вывода отключён. Вывод остановлен, пока он не вернётся', 'bad');
			else if (was === 'none') { notice('Монитор вывода подключён — вывод восстановлен', 'ok'); resync(); }
		}
		if (modalEl === $('#settingsModal')) buildSettings();
	});

	api.on('log:line', l => { if (modalEl === $('#logModal')) { const p = $('#logBody'); p.textContent += l + '\n'; p.scrollTop = p.scrollHeight; } });

	// ---------- отрисовка статусов ----------
	function updateOut() {
		const p = $('#outPill'); if (!outInfo) return;
		if (outInfo.mode === 'none') { p.className = 'pill bad'; p.textContent = '⚠ Монитор вывода отключён'; }
		else {
			const d = outInfo.displays.find(x => x.id === outInfo.outputId);
			p.className = 'pill ok';
			p.textContent = 'Вывод: ' + (d ? d.label : '?') + (outInfo.mode === 'window' ? ' · ОКНО (не полный экран)' : ' · полный экран');
		}
		updateNow();
	}

	function updateNow(light) {
		const it = byId(curId), b = $('#badge');
		if (outInfo && outInfo.mode === 'none') { b.className = 'badge off'; b.textContent = 'ВЫВОД НЕДОСТУПЕН'; }
		else if (blackOn) { b.className = 'badge black'; b.textContent = 'ЧЁРНЫЙ ЭКРАН'; }
		else { b.className = 'badge live'; b.textContent = vs.paused && it && it.kind === 'video' ? 'ПАУЗА' : 'В ЭФИРЕ'; }

		$('#preview').classList.toggle('live', !blackOn && !!it);
		$('#preview').classList.toggle('black-border', blackOn);
		$('#blackMark').style.display = blackOn ? 'grid' : 'none';
		$('#nowName').textContent = it ? it.name : '—';

		// Убрали обратные кавычки, используем плюсы
		const kindName = it && it.kind === 'video' ? 'Видео' : 'Фото';
		$('#nowMeta').textContent = it ? kindName + ' · ' + fmtSize(it.size) + ' · №' + (idx(curId) + 1) + ' из ' + items.length : 'Ничего не показывается';

		const nx = it ? neighbor(curId, 1) : byId(selId);
		$('#nextUp').textContent = nx ? 'Далее: ' + nx.name : (it ? 'Это последний файл' : '');

		$('#btnStop').textContent = blackOn && it ? '▶ ВЕРНУТЬ КАРТИНКУ (B)' : '■ СТОП / ЧЁРНЫЙ (Esc)';

		const isVid = it && it.kind === 'video';
		// Восстановили операторы ||
		$('#btnPause').disabled = blackOn || !(isVid || S.autoAdvance);
		$('#btnPause').textContent = isVid ? (vs.paused ? '▶ Продолжить' : '⏸ Пауза') : (autoPaused ? '▶ Автопереход' : '⏸ Автопереход');

		if (!light) updatePreview();
	}

	function updateProgress() {
		const it = byId(curId); if (!it || it.kind !== 'video') return;
		const b = $('#bar');
		b.style.transition = 'width .25s linear';
		b.style.width = vs.d ? (vs.t / vs.d * 100) + '%' : '0';

		// Убрали обратные кавычки, используем плюсы
		$('#timeLeft').textContent = fmtT(vs.t) + ' / ' + fmtT(vs.d) + ' · осталось ' + fmtT(vs.d - vs.t);
	}

	async function updatePreview() {
		const it = byId(curId), id = it ? it.id : null;
		if (previewFor === id) return;
		previewFor = id;

		const img = $('#prevImg'), em = $('#prevEmpty'), vid = $('#prevVid');
		$('#timeLeft').textContent = '';

		// Сбрасываем видео
		vid.pause();
		vid.removeAttribute('src');
		vid.load();

		if (!it) {
			img.removeAttribute('src'); img.style.display = 'none';
			vid.style.display = 'none';
			em.textContent = 'Нет файла на экране'; em.style.display = 'grid';
			return;
		}

		// Если это видео И включена настройка проигрывания
		if (it.kind === 'video' && S.previewPlayVideo) {
			img.style.display = 'none';
			em.style.display = 'none';
			vid.style.display = 'block';
			vid.src = it.url;
			vid.play().catch(() => { });
		} else {
			// Иначе показываем статичную картинку (для фото или если видео выключено)
			vid.style.display = 'none';
			img.style.display = 'block';

			const u = await getThumb(it, 720);
			if (previewFor !== id) return;
			if (u) { img.src = u; em.style.display = 'none'; }
			else { img.removeAttribute('src'); em.textContent = it.name; em.style.display = 'grid'; }
		}
	}

	function renderHints() {
		const hintsHtml = Object.keys(ACTIONS).map(a => {
			return '<span><kbd>' + keyName(S.hotkeys[a]) + '</kbd> ' + ACTIONS[a] + '</span>';
		}).join('');

		$('#hints').innerHTML = hintsHtml +
			'<span><kbd>Esc</kbd> Чёрный экран (всегда)</span><span><kbd>↑</kbd><kbd>↓</kbd> Выбор в очереди</span>';
	}
	// ---------- модальные окна ----------
	function openModal(id) { closeModal(); modalEl = $(id); modalEl.classList.add('open'); }
	function closeModal() { if (modalEl) modalEl.classList.remove('open'); modalEl = null; rebinding = null; }
	const applySettings = s => {
		const oldPreview = S.previewPlayVideo; // Запоминаем старое значение
		S = s;

		// Если настройка превью ИЗМЕНИЛАСЬ, тогда перерисовываем его
		if (oldPreview !== S.previewPlayVideo) {
			previewFor = null;
			updatePreview();
		}

		renderHints();
		api.out({ type: 'opts', opts: outOpts() });

		// ВАЖНО: Передаем true, чтобы updateNow НЕ вызывал перерисовку превью
		updateNow(true);
		mark();

		const vr = $('#volRange');
		if (vr && document.activeElement !== vr) {
			updateVolumeUI();
		}
	};

	function openSettings() { buildSettings(); openModal('#settingsModal'); }

	function openBgSettings() {
		const body = $('#bgSettingsBody');
		body.replaceChildren();

		// Выбор типа фона (Цвет или Картинка)
		const rowType = document.createElement('div'); rowType.className = 'frow';
		rowType.innerHTML = '<span>Тип фона</span>';
		const selType = document.createElement('select');
		selType.innerHTML = '<option value="color">Сплошной цвет</option><option value="image">Картинка</option>';
		selType.value = S.bgType || 'color';
		selType.onchange = async () => {
			applySettings(await api.setSettings({ bgType: selType.value }));
			openBgSettings(); // Перерисовать окно
		};
		rowType.append(selType); body.append(rowType);

		// Если выбран цвет
		if (S.bgType === 'color' || !S.bgType) {
			const rowColor = document.createElement('div'); rowColor.className = 'frow';
			rowColor.innerHTML = '<span>Цвет</span>';
			const inpColor = document.createElement('input');
			inpColor.type = 'color'; inpColor.value = S.bgColor || '#000000';
			inpColor.style.width = '80px'; inpColor.style.height = '40px'; inpColor.style.padding = '0'; inpColor.style.border = 'none';
			inpColor.onchange = async () => applySettings(await api.setSettings({ bgColor: inpColor.value }));
			rowColor.append(inpColor); body.append(rowColor);
		}

		// Если выбрана картинка
		if (S.bgType === 'image') {
			const rowImg = document.createElement('div'); rowImg.className = 'frow';
			rowImg.innerHTML = '<span>Файл картинки</span>';
			const btnPick = document.createElement('button');
			btnPick.textContent = S.bgImage ? 'Изменить картинку' : 'Выбрать файл';
			btnPick.onclick = async () => {
				const url = await api.pickBgImage();
				if (url) { applySettings(await api.setSettings({ bgImage: url })); openBgSettings(); }
			};
			rowImg.append(btnPick); body.append(rowImg);

			if (S.bgImage) {
				const preview = document.createElement('img');
				preview.src = S.bgImage;
				preview.style.width = '100%'; preview.style.maxHeight = '200px'; preview.style.objectFit = 'contain'; preview.style.background = '#000'; preview.style.marginTop = '10px'; preview.style.borderRadius = '8px';
				body.append(preview);

				const btnClear = document.createElement('button');
				btnClear.textContent = 'Удалить картинку (сбросить)';
				btnClear.className = 'danger'; btnClear.style.marginTop = '10px'; btnClear.style.width = '100%';
				btnClear.onclick = async () => { applySettings(await api.setSettings({ bgImage: '' })); openBgSettings(); };
				body.append(btnClear);
			}
		}
		openModal('#bgModal');
	}

	function buildSettings() {
		const body = $('#settingsBody');
		body.replaceChildren();
		const add = h => body.insertAdjacentHTML('beforeend', h);

		add('<h4>Монитор вывода</h4>');
		const sel = document.createElement('select');

		let optsHtml = '<option value="">Авто (первый неосновной)</option>';
		if (outInfo) {
			outInfo.displays.forEach(d => {
				optsHtml += '<option value="' + d.id + '">' + esc(d.label) + '</option>';
			});
		}
		sel.innerHTML = optsHtml;
		sel.value = S.outputDisplayId == null ? '' : String(S.outputDisplayId);

		if (S.outputDisplayId != null && sel.value === '') {
			sel.innerHTML += '<option value="' + S.outputDisplayId + '" selected>(отключён) id ' + S.outputDisplayId + '</option>';
		}

		sel.onchange = async () => applySettings(await api.setSettings({ outputDisplayId: sel.value === '' ? null : Number(sel.value) }));

		const row = document.createElement('div'); row.className = 'frow'; row.innerHTML = '<span>Экран / проектор</span>'; row.append(sel);
		body.append(row);

		for (const f of FIELDS) {
			if (f[0] === 'h') { add('<h4>' + f[1] + '</h4>'); continue; }
			const [key, type, label, a, b, c] = f;
			const r = document.createElement('div');
			r.className = 'frow';
			r.innerHTML = '<span>' + label + '</span>';

			let inp;

			if (type === 'check') {
				inp = document.createElement('input');
				inp.type = 'checkbox';
				inp.checked = !!S[key];
				inp.onchange = async () => applySettings(await api.setSettings({ [key]: inp.checked }));
			} else if (type === 'select') {
				inp = document.createElement('select');
				let selHtml = '';
				a.forEach(o => { selHtml += '<option value="' + o[0] + '">' + o[1] + '</option>'; });
				inp.innerHTML = selHtml;
				inp.value = S[key];
				inp.onchange = async () => applySettings(await api.setSettings({ [key]: inp.value }));
			} else {
				// --- БЛОК ПОЛЗУНКА (RANGE) ---
				let safeVal = Number(S[key]);
				if (isNaN(safeVal)) safeVal = Number(a);

				const sliderWrap = document.createElement('div');
				sliderWrap.style.display = 'flex';
				sliderWrap.style.alignItems = 'center';
				sliderWrap.style.gap = '10px';

				const input = document.createElement('input');
				input.type = 'range';
				input.min = a;
				input.max = b;
				input.step = c;
				input.value = safeVal;
				input.style.width = '180px';

				const valSpan = document.createElement('span');
				valSpan.textContent = safeVal;
				valSpan.style.minWidth = '40px';
				valSpan.style.textAlign = 'right';
				valSpan.style.color = 'var(--acc)'; // Чтобы цифры было видно

				// Меняем цифры в реальном времени
				input.oninput = () => {
					valSpan.textContent = input.value;
				};

				// Сохраняем, когда отпустили мышку
				input.onchange = async () => {
					const num = Number(input.value);
					applySettings(await api.setSettings({ [key]: num }));
				};

				sliderWrap.append(input, valSpan);
				r.append(sliderWrap);
				// -----------------------------
			}

			if (type !== 'range') {
				r.append(inp);
			}
			body.append(r);
		}

		add('<h4>Горячие клавиши (нажмите кнопку, затем новую клавишу)</h4>');
		for (const a of Object.keys(ACTIONS)) {
			const r = document.createElement('div'); r.className = 'frow'; r.innerHTML = '<span>' + ACTIONS[a] + '</span>';
			const bt = document.createElement('button'); bt.textContent = rebinding === a ? 'Нажмите клавишу…' : keyName(S.hotkeys[a]);
			bt.onclick = () => { rebinding = a; buildSettings(); };
			r.append(bt); body.append(r);
		}

		add('<h4>Диагностика</h4>');
		const d = document.createElement('div'); d.className = 'frow';
		d.innerHTML = '<span>Аппаратное ускорение (GPU)</span>';
		const gb = document.createElement('button'); gb.textContent = 'Проверить';
		gb.onclick = async () => {
			const g = await api.gpu();
			let pre = body.querySelector('#gpuOut');
			if (!pre) { pre = document.createElement('pre'); pre.id = 'gpuOut'; body.append(pre); }
			pre.textContent = JSON.stringify(g, null, 2);
		};
		d.append(gb); body.append(d);

		add('<h4>Резервное копирование</h4>');
		const expRow = document.createElement('div'); expRow.className = 'frow';
		expRow.innerHTML = '<span>Сохранить или загрузить настройки</span>';
		const expBtn = document.createElement('button'); expBtn.textContent = 'Экспорт';
		const impBtn = document.createElement('button'); impBtn.textContent = 'Импорт'; impBtn.style.marginLeft = '10px';
		expBtn.onclick = async () => { if (await api.exportSettings()) notice('Настройки сохранены!', 'ok'); };
		impBtn.onclick = async () => {
			if (await api.importSettings()) {
				notice('Настройки загружены! Перезапустите приложение.', 'ok');
				setTimeout(() => api.quit(), 2000);
			}
		};
		const btnWrap = document.createElement('div'); btnWrap.append(expBtn, impBtn);
		expRow.append(btnWrap); body.append(expRow);
	}

	async function finishRebind(code) {
		const a = rebinding; rebinding = null;
		if (code === 'Escape') return buildSettings();

		const clash = Object.keys(S.hotkeys).find(k => k !== a && S.hotkeys[k] === code);

		// Восстановили операторы || и убрали кавычки из notice
		if (clash || code === 'ArrowUp' || code === 'ArrowDown') {
			notice('Клавиша «' + keyName(code) + '» занята', 'bad');
			return buildSettings();
		}

		applySettings(await api.setSettings({ hotkeys: { ...S.hotkeys, [a]: code } })); buildSettings();
	}

	async function openLog() {
		$('#logBody').textContent = (await api.recentLog()).join('\n') + '\n';
		openModal('#logModal'); const p = $('#logBody'); p.scrollTop = p.scrollHeight;
	}

	function confirmDlg(title, text, ok) {
		return new Promise(res => {
			confirmOpen = true;
			$('#cTitle').textContent = title; $('#cText').textContent = text; $('#cOk').textContent = ok;
			$('#confirm').classList.add('open'); $('#cNo').focus();
			const done = v => { confirmOpen = false; $('#confirm').classList.remove('open'); window.removeEventListener('keydown', onKey, true); res(v); };
			const onKey = e => { if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
			window.addEventListener('keydown', onKey, true);
			$('#cOk').onclick = () => done(true); $('#cNo').onclick = () => done(false);
		});
	}

	api.on('app:close-request', async () => {
		if (confirmOpen) return;
		if (await confirmDlg('Закрыть приложение?', 'Вывод на проектор будет остановлен.', 'Закрыть')) api.quit();
	});

	// ---------- действия и горячие клавиши ----------
	const run = {
		panic() {
			api.out({ type: 'black', on: true });
			api.out({ type: 'toggleVideo' }); // На всякий случай ставим видео на паузу
			blackOn = true;
			updateNow(); mark();
			notice('🚨 Экстренный черный экран', 'bad');
		},
		playPause() {
			const it = byId(curId); if (blackOn || !it) return;
			if (it.kind === 'video') api.out({ type: 'toggleVideo' });
			else if (S.autoAdvance) { autoPaused = !autoPaused; autoPaused ? (clearAuto(), notice('Автопереход на паузе')) : (startAuto(), notice('Автопереход продолжен')); updateNow(); }
		},
		next() { step(1); }, prev() { step(-1); },
		black() { toggleBlack(); },
		fullscreen() { api.setSettings({ outputFullscreen: !S.outputFullscreen }).then(applySettings); },
		settings() { modalEl ? closeModal() : openSettings(); },
		show() { if (selId) showItem(selId); }
	};

	const typing = t => t && t.matches && t.matches('input[type=search],input[type=text],textarea');

	window.addEventListener('keydown', e => {
		if (rebinding) { e.preventDefault(); finishRebind(e.code); return; }
		if (confirmOpen) return;
		if (typing(e.target)) { if (e.code === 'Escape') e.target.blur(); return; }
		if (modalEl) { if (e.code === 'Escape' || e.code === S.hotkeys.settings) { e.preventDefault(); closeModal(); } return; }

		const act = Object.keys(S.hotkeys).find(a => S.hotkeys[a] === e.code);

		// Восстановили операторы ||
		if (act || e.code === 'Escape' || e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
		if (e.repeat) return;
		if (e.code === 'Escape') return blackout();

		if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
			const n = items[Math.min(items.length - 1, Math.max(0, idx(selId) + (e.code === 'ArrowDown' ? 1 : -1)))];
			if (n) {
				selId = n.id;
				mark();
				// Убрали обратные кавычки, используем сложение
				const r = $('.item[data-id="' + n.id + '"]');
				if (r) r.scrollIntoView({ block: 'nearest' });
				updateNow(true);
			}
			return;
		}
		if (act) run[act]();
	});

	window.addEventListener('keyup', e => { if (!modalEl && !confirmOpen && !typing(e.target) && (e.code === 'Space' || e.code === 'Enter')) e.preventDefault(); });
	document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });

	// ---------- кнопки ----------
	$('#btnPrev').onclick = () => step(-1);
	$('#btnNext').onclick = () => step(1);
	$('#btnShow').onclick = () => run.show();
	$('#btnPause').onclick = () => run.playPause();
	$('#btnStop').onclick = () => toggleBlack();
	if ($('#btnSettings')) $('#btnSettings').onclick = openSettings;
	$('#btnCloseSettings').onclick = closeModal;
	$('#btnLog').onclick = openLog;
	$('#btnCloseLog').onclick = closeModal;
	$('#btnOpenLogs').onclick = () => api.openLogs();
	$('#btnAddFiles').onclick = async () => addItems(await api.pickFiles());
	$('#btnAddFolder').onclick = async () => addItems(await api.pickFolder());
	$('#btnClear').onclick = clearQueue;
	$('#floatingDeleteBtn').onclick = () => {
		if (selectedQueueIds.size === 0) return;
		if (selectedQueueIds.has(curId)) blackout(); // Если удаляем играющий файл

		items = items.filter(it => !selectedQueueIds.has(it.id));
		selectedQueueIds.clear();
		$('#floatingDeleteBtn').style.display = 'none';
		persist(); renderQueue(); updateNow();
	};
	$('#btnView').onclick = () => { view = view === 'list' ? 'grid' : 'list'; renderQueue(); };
	$('#search').oninput = applyFilter;
	$('#btnBg').onclick = openBgSettings;
	$('#btnCloseBg').onclick = closeModal;

	// --- Перемотка видео ---
	let isDragging = false;
	const progressBar = $('#progress');

	if (progressBar) {
		progressBar.style.cursor = 'pointer'; // Меняем курсор на палец

		const seekToEvent = (e) => {
			// Если сейчас показывается фото, полоса пустая, перематывать нечего
			if (!vs.d) return;

			const rect = progressBar.getBoundingClientRect();
			let percent = (e.clientX - rect.left) / rect.width;

			// Ограничиваем от 0 до 1 (чтобы не улететь за пределы)
			percent = Math.max(0, Math.min(1, percent));
			const time = percent * vs.d;

			// Мгновенно обновляем цифры и полоску на экране управления
			vs.t = time;
			$('#bar').style.width = (percent * 100) + '%';
			$('#timeLeft').textContent = fmtT(vs.t) + ' / ' + fmtT(vs.d) + ' · осталось ' + fmtT(vs.d - vs.t);

			// Отправляем команду на второй экран
			api.out({ type: 'seek', time: time });
		};

		// Клик или зажатие мыши на полосе
		progressBar.addEventListener('mousedown', (e) => {
			if (!vs.d) return;
			isDragging = true;
			seekToEvent(e);
		});

		// Движение мыши (если зажали кнопку)
		window.addEventListener('mousemove', (e) => {
			if (isDragging) seekToEvent(e);
		});

		// Отпустили кнопку мыши
		window.addEventListener('mouseup', () => {
			isDragging = false;
		});
	}

	// Очередь: клик, двойной клик, перетаскивание
	const q = $('#queue');
	q.addEventListener('click', e => {
		const r = e.target.closest('.item'); if (!r) return;
		if (e.target.closest('.rm')) return removeItem(r.dataset.id);
		selId = r.dataset.id; mark(); updateNow(true);
	});
	q.addEventListener('dblclick', e => { const r = e.target.closest('.item'); if (r && !e.target.closest('.rm')) showItem(r.dataset.id); });
	q.addEventListener('dragstart', e => { const r = e.target.closest('.item'); if (r) { dragId = r.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } });
	q.addEventListener('dragover', e => { if (dragId) e.preventDefault(); });
	q.addEventListener('drop', e => {
		if (!dragId) return; e.preventDefault(); e.stopPropagation();
		const r = e.target.closest('.item');
		if (r && r.dataset.id !== dragId) { const [m] = items.splice(idx(dragId), 1); items.splice(idx(r.dataset.id), 0, m); persist(); renderQueue(); updateNow(true); }
		dragId = null;
	});
	q.addEventListener('dragend', () => { dragId = null; });

	// Drag&drop файлов
	window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); $('#drop').classList.add('on'); } });
	window.addEventListener('dragleave', e => { if (!e.relatedTarget) $('#drop').classList.remove('on'); });
	window.addEventListener('drop', async e => {
		$('#drop').classList.remove('on');
		if (!e.dataTransfer.files.length) return;
		e.preventDefault();
		const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
		addItems(await api.resolvePaths(paths));
	});

	// ---------- старт ----------
	(async function init() {
		S = await api.getSettings();
		outInfo = await api.getDisplays();
		const saved = await api.loadQueue();
		items = saved.items || [];
		selId = saved.curId && idx(saved.curId) >= 0 ? saved.curId : (items[0] && items[0].id) || null;
		renderQueue(); renderHints(); updateOut(); updateNow();
		api.out({ type: 'opts', opts: outOpts() });
		api.out({ type: 'black', on: true });
		if (items.some(i => i.missing)) notice('Часть файлов из прошлой сессии недоступна — они помечены красным', 'bad');
		// Обработка ползунка громкости
		$('#volRange').oninput = (e) => {
			S.volume = Number(e.target.value);
			$('#volText').textContent = S.volume + '%';
			$('#volIcon').textContent = S.volume === 0 ? '🔇' : (S.volume < 50 ? '🔉' : '🔊');

			// ОТПРАВЛЯЕМ БЫСТРУЮ КОМАНДУ (без перерисовки всего интерфейса)
			api.out({ type: 'setVolume', volume: S.volume / 100, muted: S.muted });
		};

		$('#volRange').onchange = async (e) => {
			// СОХРАНЯЕМ НА ДИСК только тогда, когда отпустили мышку
			applySettings(await api.setSettings({ volume: Number(e.target.value) }));
		};

		$('#volRange').onchange = async (e) => {
			// Сохраняем громкость в настройки, чтобы она не сбрасывалась при перезапуске
			applySettings(await api.setSettings({ volume: Number(e.target.value) }));
		};
	})();
	// Синхронизируем ползунок громкости при запуске
	updateVolumeUI();
	// --- Логика Проводника ---
	function updateTabs() {
		$('#tabQueue').classList.toggle('active', !isExplorer);
		$('#tabExplorer').classList.toggle('active', isExplorer);
		$('#queueView').style.display = isExplorer ? 'none' : 'flex';
		$('#explorerView').style.display = isExplorer ? 'flex' : 'none';
	}

	$('#tabQueue').onclick = () => { isExplorer = false; updateTabs(); };
	$('#tabExplorer').onclick = () => { isExplorer = true; updateTabs(); if (!expCurrentDir) pickExpFolder(); };

	async function pickExpFolder() {
		const path = await api.pickFolderPath();
		if (path) loadExplorer(path);
	}
	$('#btnExpPick').onclick = pickExpFolder;

	$('#btnExpUp').onclick = () => { if (expParentDir) loadExplorer(expParentDir); };

	async function loadExplorer(path) {

		$('#expSearch').value = '';

		const res = await api.readDir(path);
		if (res.error) return notice('Ошибка чтения: ' + res.error, 'bad');

		expCurrentDir = res.path;
		expParentDir = res.parent;
		$('#expPath').textContent = res.path;
		$('#btnExpUp').disabled = !expParentDir;

		// Сбрасываем выделение при переходе в другую папку
		selectedExpPaths.clear();
		lastClickedIndex = -1;
		updateBulkBar();

		currentExpEntries = res.entries;
		const list = $('#expList');
		list.replaceChildren();

		if (res.entries.length === 0) {
			list.innerHTML = '<div style="color:var(--mut); padding:20px; text-align:center;">Папка пуста или нет медиафайлов</div>';
			return;
		}

		const frag = document.createDocumentFragment();
		res.entries.forEach((entry, i) => {
			const row = document.createElement('div');
			row.className = 'item';
			row.dataset.path = entry.path;
			row.dataset.index = i;

			if (entry.isDirectory) {
				row.innerHTML = '<div style="font-size:28px; width:96px; text-align:center;">📁</div><div class="meta"><b>' + esc(entry.name) + '</b><small>Папка</small></div>';
				row.ondblclick = () => loadExplorer(entry.path);
			} else {
				const kindIcon = entry.kind === 'video' ? '▶' : '';
				row.innerHTML = '<div class="th"><img alt=""><span class="kind">' + kindIcon + '</span></div>' +
					'<div class="meta"><b>' + esc(entry.name) + '</b><small>' + (entry.kind === 'video' ? 'видео' : 'фото') + '</small></div>';

				api.thumb(entry.path, 240).then(u => {
					if (u) row.querySelector('img').src = u;
				});

				row.ondblclick = async (e) => {
					e.stopPropagation();
					const itemsToAdd = await api.resolvePaths([entry.path]);
					if (itemsToAdd.length > 0) {
						addItems(itemsToAdd);
						showItem(itemsToAdd[0].id);
					}
				};
			}

			// Логика выделения
			row.onmousedown = (e) => {
				// Если это двойной клик — не меняем выделение
				if (e.detail === 2) return;

				const isCtrl = e.ctrlKey || e.metaKey;
				const isShift = e.shiftKey;

				if (isShift && lastClickedIndex !== -1) {
					// Выделяем диапазон
					if (!isCtrl) selectedExpPaths.clear();
					const start = Math.min(lastClickedIndex, i);
					const end = Math.max(lastClickedIndex, i);
					for (let j = start; j <= end; j++) {
						selectedExpPaths.add(res.entries[j].path);
					}
				} else if (isCtrl) {
					// Точечное добавление/удаление
					if (selectedExpPaths.has(entry.path)) {
						selectedExpPaths.delete(entry.path);
					} else {
						selectedExpPaths.add(entry.path);
					}
					lastClickedIndex = i;
				} else {
					// Обычный клик — сбрасываем всё и выбираем только это
					selectedExpPaths.clear();
					selectedExpPaths.add(entry.path);
					lastClickedIndex = i;
				}

				// Обновляем визуальное выделение
				const rows = list.querySelectorAll('.item');
				rows.forEach(r => {
					r.classList.toggle('selected', selectedExpPaths.has(r.dataset.path));
				});

				updateBulkBar();
			};

			frag.append(row);
		});
		list.append(frag);
	}
	function updateBulkBar() {
		const count = selectedExpPaths.size;
		const btnAdd = $('#btnExpAddSelected');
		const btnRemove = $('#btnExpRemove');

		if (count > 0) {
			btnAdd.disabled = false;
			btnAdd.classList.add('ready'); // Включаем анимацию
			btnRemove.disabled = false;
		} else {
			btnAdd.disabled = true;
			btnAdd.classList.remove('ready'); // Выключаем анимацию
			btnRemove.disabled = true;
		}
	}

	$('#btnExpAddSelected').onclick = async () => {
		if (selectedExpPaths.size === 0) return;
		const paths = Array.from(selectedExpPaths);
		const itemsToAdd = await api.resolvePaths(paths);

		if (itemsToAdd.length > 0) {
			addItems(itemsToAdd);
			notice('Добавлено файлов: ' + itemsToAdd.length, 'ok');

			selectedExpPaths.clear();
			document.querySelectorAll('#expList .item').forEach(r => r.classList.remove('selected'));
			updateBulkBar();
		}
	};
	// Удаление выбранных файлов из очереди
	$('#btnExpRemove').onclick = () => {
		if (selectedExpPaths.size === 0) return;
		const paths = Array.from(selectedExpPaths);

		let removedCount = 0;
		let currentlyPlayingRemoved = false;

		// Фильтруем массив items, удаляя всё, что совпадает с путями
		items = items.filter(it => {
			// Проверяем, выбран ли сам файл или его родительская папка
			const matches = paths.some(p => it.path === p || it.path.startsWith(p + '\\') || it.path.startsWith(p + '/'));

			if (matches) {
				if (it.id === curId) currentlyPlayingRemoved = true;
				removedCount++;
				return false; // Удаляем из массива
			}
			return true;
		});

		if (removedCount > 0) {
			if (currentlyPlayingRemoved) blackout(); // Если удалили играющий файл — уходим в черный экран

			selectedExpPaths.clear();
			document.querySelectorAll('#expList .item').forEach(r => r.classList.remove('selected'));
			updateBulkBar();

			persist();
			renderQueue();
			updateNow();
			notice('Удалено из очереди: ' + removedCount, 'ok');
		} else {
			notice('Этих файлов нет в очереди', 'bad');
		}
	};

	// --- Поддержка ---
	const DEV_TELEGRAM = 'https://t.me/MixFix_3_16_3_1'; // <-- ЗАМЕНИТЕ НА СВОЙ
	const DEV_EMAIL = 'vladimirzakharov0120@mail.ru';             // <-- ЗАМЕНИТЕ НА СВОЙ

	if ($('#btnSupport')) $('#btnSupport').onclick = () => openModal('#supportModal');
	if ($('#btnCloseSupport')) $('#btnCloseSupport').onclick = closeModal;

	$('#btnCopyLogs').onclick = async () => {
		try {
			const gpu = await api.gpu();
			const logs = await api.recentLog();

			const report = [
				'=== ДАННЫЕ ДЛЯ ПОДДЕРЖКИ StageMedia ===',
				'Дата: ' + new Date().toLocaleString(),
				'ОС: Windows ' + (navigator.userAgent.includes('Win64') ? '64-bit' : '32-bit'),
				'Экранов: ' + (outInfo ? outInfo.displays.length : '?'),
				'Видеокарта (WebGL): ' + (gpu.video_decode === 'enabled' ? 'Аппаратное ускорение ВКЛ' : 'Аппаратное ускорение ВЫКЛ/ОШИБКА'),
				'',
				'=== ПОСЛЕДНИЕ ЛОГИ ===',
				...logs.slice(-30) // Берем последние 30 строк
			].join('\n');

			await navigator.clipboard.writeText(report);

			// Меняем текст кнопки, чтобы было понятно, что скопировалось
			const btn = $('#btnCopyLogs');
			const oldText = btn.textContent;
			btn.textContent = '✅ Скопировано в буфер!';
			btn.style.background = 'var(--ok)';
			setTimeout(() => {
				btn.textContent = oldText;
				btn.style.background = 'var(--acc)';
			}, 2000);

		} catch (e) {
			notice('Не удалось скопировать данные', 'bad');
		}
	};

	$('#btnContactTelegram').onclick = () => {
		api.openExternal(DEV_TELEGRAM);
	};

	$('#btnContactEmail').onclick = () => {
		// Тема письма заполняется автоматически
		const subject = encodeURIComponent('Проблема с приложением StageMedia');
		api.openExternal('mailto:' + DEV_EMAIL + '?subject=' + subject);
	};

	let searchTimer = null;
	$('#expSearch').oninput = (e) => {
		clearTimeout(searchTimer);
		const q = e.target.value.trim();

		// Если поиск очистили, возвращаем обычный вид папки
		if (q === '') {
			if (expCurrentDir) loadExplorer(expCurrentDir);
			return;
		}

		// Ждем 0.5 сек после последнего нажатия клавиши (дебаунс)
		searchTimer = setTimeout(async () => {
			if (!expCurrentDir) return;
			const list = $('#expList');
			list.innerHTML = '<div style="color:var(--mut); padding:20px; text-align:center;">Ищем...</div>';

			const results = await api.searchFiles(expCurrentDir, q);
			list.replaceChildren();

			if (results.length === 0) {
				list.innerHTML = '<div style="color:var(--mut); padding:20px; text-align:center;">Ничего не найдено</div>';
				return;
			}

			const frag = document.createDocumentFragment();
			results.forEach(entry => {
				const row = document.createElement('div');
				row.className = 'item';
				row.innerHTML = '<div class="th"><img alt=""></div><div class="meta"><b>' + esc(entry.name) + '</b><small>' + entry.path + '</small></div>';
				api.thumb(entry.path, 240).then(u => { if (u) row.querySelector('img').src = u; });
				row.ondblclick = async () => {
					const itemsToAdd = await api.resolvePaths([entry.path]);
					if (itemsToAdd.length > 0) { addItems(itemsToAdd); showItem(itemsToAdd[0].id); }
				};
				frag.append(row);
			});
			list.append(frag);
		}, 500);
	};

	// Скрываем кнопку удаления при клике на пустое место в очереди
	$('#queue').addEventListener('mousedown', (e) => {
		if (!e.target.closest('.item')) {
			selectedQueueIds.clear();
			document.querySelectorAll('#queue .item').forEach(r => r.classList.remove('selected'));
			$('#floatingDeleteBtn').style.display = 'none';
		}
	});
})();