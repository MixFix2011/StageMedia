(() => {
	'use strict';
	const stage = document.getElementById('stage');
	const blackEl = document.getElementById('black');
	const emit = m => window.out.emit(m);

	let opts = { fit: 'contain', fadeMs: 300, muted: false, volume: 1, loopVideo: false };
	let current = null;
	let blackOn = true, seq = 0, zTop = 1;
	const cache = new Map();

	const mediaErr = e => !e ? 'Ошибка воспроизведения'
		: e.code === 3 ? 'Файл повреждён или кодек не поддерживается'
			: e.code === 4 ? 'Формат/кодек не поддерживается или файл недоступен' : 'Ошибка воспроизведения';

	function loadImage(item) {
		const img = new Image(); img.decoding = 'async'; img.src = item.url;
		return img.decode().then(() => img, () => { throw new Error('Файл повреждён'); });
	}

	function loadVideo(item) {
		return new Promise((res, rej) => {
			const v = document.createElement('video');
			v.preload = 'auto'; v.muted = true; v.playsInline = true; v.disablePictureInPicture = true;
			const to = setTimeout(() => rej(new Error('Таймаут загрузки видео')), 15000);
			v.onloadeddata = () => { clearTimeout(to); res(v); };
			v.onerror = () => { clearTimeout(to); rej(new Error(mediaErr(v.error))); };
			v.src = item.url; v.load();
		});
	}

	function prepare(item) {
		let e = cache.get(item.id);
		if (!e) {
			e = { item, ready: (item.kind === 'image' ? loadImage : loadVideo)(item) };
			e.ready.catch(() => { if (cache.get(item.id) === e) cache.delete(item.id); });
			cache.set(item.id, e);
		}
		return e;
	}

	const release = el => { if (el && el.tagName === 'VIDEO') { el.pause(); el.removeAttribute('src'); el.load(); } };

	function keepOnly(ids) {
		setTimeout(() => {
			for (const [id, e] of cache) {
				if (ids.has(id) || (current && current.id === id)) continue;
				cache.delete(id); e.ready.then(release, () => { });
			}
		}, opts.fadeMs + 150);
	}

	const applyAudio = v => { v.muted = opts.muted; v.volume = Math.min(1, Math.max(0, opts.volume)); v.loop = opts.loopVideo; };

	const firstFrame = v => new Promise(r => {
		if (!v.requestVideoFrameCallback) return r();
		const t = setTimeout(r, 400);
		v.requestVideoFrameCallback(() => { clearTimeout(t); r(); });
	});

	function bindVideo(v, item) {
		const t = () => emit({ type: 'time', id: item.id, t: v.currentTime, d: v.duration || 0, paused: v.paused });
		v.ontimeupdate = t; v.onpause = t; v.onplay = t;
		v.onended = () => emit({ type: 'ended', id: item.id });
		v.onerror = () => emit({ type: 'error', id: item.id, message: mediaErr(v.error) });
	}

	function setBlack(on, resume = true) {
		blackOn = !!on;
		const ms = opts.fadeMs !== undefined ? Number(opts.fadeMs) : 300;
		blackEl.style.transition = ms > 0 ? 'opacity ' + ms + 'ms ease' : 'none';
		blackEl.style.opacity = on ? '1' : '0';

		if (current && current.kind === 'video') {
			if (on) {
				current.resume = !current.el.paused;
				current.el.pause();
			} else if (resume && current.resume) {
				current.el.play().catch(() => { });
			}
		}
		emit({ type: 'black', on });
	}

	async function show(item, o) {
		const my = ++seq, t0 = performance.now();
		opts = { ...opts, ...o };
		try {
			let el = await prepare(item).ready;
			if (my !== seq) return;

			if (item.kind === 'image' && item.ext === '.gif') {
				el = new Image(); el.src = item.url; await el.decode(); if (my !== seq) return;
			}

			if (current && current.el === el) {
				setBlack(false, false);
				if (item.kind === 'video') {
					el.currentTime = 0;
					applyAudio(el);
					bindVideo(el, item);
					// Безопасный запуск: обрабатываем возможную ошибку прерывания
					const playPromise = el.play();
					if (playPromise !== undefined) {
						playPromise.catch(err => {
							if (err.name !== 'AbortError') {
								console.warn('Ошибка воспроизведения:', err);
							}
						});
					}
				}
				emit({ type: 'shown', id: item.id, ms: Math.round(performance.now() - t0) });
				return;
			}

			const layer = document.createElement('div');
			layer.className = 'layer fit-' + opts.fit;
			layer.style.zIndex = ++zTop;
			layer.appendChild(el);
			stage.appendChild(layer);

			if (item.kind === 'video') {
				applyAudio(el);
				bindVideo(el, item);
				el.currentTime = 0;

				// Безопасный запуск: обрабатываем возможную ошибку прерывания
				const playPromise = el.play();
				if (playPromise !== undefined) {
					playPromise.catch(err => {
						if (err.name !== 'AbortError') {
							console.warn('Ошибка воспроизведения:', err);
						}
					});
				}

				await firstFrame(el);
				if (my !== seq) { el.pause(); layer.remove(); return; }
			}

			current = { id: item.id, el, kind: item.kind, layer, resume: false };
			setBlack(false, false);
			layer.getBoundingClientRect();

			layer.style.transition = opts.fadeMs > 0 ? 'opacity ' + opts.fadeMs + 'ms ease' : 'none';
			layer.style.opacity = 1;

			const cleanup = () => {
				for (const l of [...stage.children]) {
					if (l !== layer && Number(l.style.zIndex) < Number(layer.style.zIndex)) {
						const v = l.querySelector('video');
						if (v) {
							v.pause();
							// Дополнительная страховка: очищаем старый источник
							v.removeAttribute('src');
							v.load();
						}
						l.remove();
					}
				}
			};

			if (opts.fadeMs > 0) setTimeout(cleanup, opts.fadeMs + 50); else cleanup();
			emit({ type: 'shown', id: item.id, ms: Math.round(performance.now() - t0) });
		} catch (err) {
			if (my === seq) emit({ type: 'error', id: item.id, message: err.message || String(err) });
		}
	}

	function applyOpts(o) {
		opts = { ...opts, ...o };
		if (current) {
			current.layer.className = 'layer fit-' + opts.fit;
			if (current.kind === 'video') applyAudio(current.el);
		}

		if (blackEl) {
			if (opts.bgType === 'image' && opts.bgImage) {
				blackEl.style.backgroundColor = '#000';
				blackEl.style.backgroundImage = 'url("' + opts.bgImage + '")';
				blackEl.style.backgroundSize = 'contain';
				blackEl.style.backgroundRepeat = 'no-repeat';
				blackEl.style.backgroundPosition = 'center';
			} else {
				blackEl.style.backgroundImage = 'none';
				blackEl.style.backgroundColor = opts.bgColor || '#000000';
			}
		}
	}

	window.out.onCmd(m => {
		switch (m.type) {
			case 'show': show(m.item, m.opts); break;
			case 'preload':
				(m.items || []).forEach(it => {
					prepare(it).ready.then(() => emit({ type: 'preloaded', id: it.id })).catch(() => { });
				});
				keepOnly(new Set((m.items || []).map(i => i.id)));
				break;
			case 'opts': applyOpts(m.opts); break;
			case 'black': setBlack(!!m.on); break;
			case 'toggleVideo':
				if (!blackOn && current && current.kind === 'video') current.el.paused ? current.el.play().catch(() => { }) : current.el.pause();
				break;
			case 'seek':
				if (current && current.kind === 'video' && current.el) current.el.currentTime = m.time;
				break;
		}
	});

	emit({ type: 'ready' });
})();