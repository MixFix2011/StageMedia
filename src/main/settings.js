'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
	outputDisplayId: null,      // null = авто: первый неосновной монитор
	outputFullscreen: true,
	fit: 'contain',             // contain | cover
	fadeMs: 300,
	showName: false,
	keepAwake: true,
	muted: false,
	volume: 100,                // 0..100
	loopVideo: false,
	autoAdvance: false,
	imageDuration: 8,           // сек
	advanceAfterVideo: true,
	loopQueue: false,
	onError: 'skip',            // skip | stay | black
	confirmClear: true,
	confirmClose: true,
	// ... предыдущие настройки ...
	confirmClose: true,
	// Новые настройки фона:
	bgType: 'color',       // 'color' (цвет) или 'image' (картинка)
	bgColor: '#000000',    // Цвет фона (по умолчанию черный)
	bgImage: '',            // Путь к картинке
	// Храним e.code, поэтому клавиши работают при любой раскладке (B = И на русской)
	hotkeys: {
		playPause: 'Space', next: 'ArrowRight', prev: 'ArrowLeft', black: 'KeyB',
		fullscreen: 'KeyF', settings: 'KeyS', show: 'Enter', panic: 'Backspace'
	},
	confirmClose: true,
	previewPlayVideo: false // По умолчанию видео в превью ВЫКЛЮЧЕНО
};

let data = structuredClone(DEFAULTS);
const file = () => path.join(app.getPath('userData'), 'settings.json');

// Пишем во временный файл и переименовываем: сбой питания не испортит настройки
function writeJsonAtomic(p, obj) {
	const tmp = p + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
	fs.renameSync(tmp, p);
}

function load() {
	try {
		const r = JSON.parse(fs.readFileSync(file(), 'utf8'));
		data = { ...DEFAULTS, ...r, hotkeys: { ...DEFAULTS.hotkeys, ...(r.hotkeys || {}) } };
	} catch { data = structuredClone(DEFAULTS); }
	return data;
}
const get = () => data;
function set(patch) {
	data = { ...data, ...patch };
	if (patch.hotkeys) data.hotkeys = { ...DEFAULTS.hotkeys, ...patch.hotkeys };
	try { writeJsonAtomic(file(), data); } catch (e) { require('./logger').error('Не удалось сохранить настройки: ' + e.message); }
	return data;
}
module.exports = { load, get, set, writeJsonAtomic };