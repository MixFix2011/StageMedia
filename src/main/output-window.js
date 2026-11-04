'use strict';
const { BrowserWindow, screen, powerSaveBlocker } = require('electron');
const path = require('path');
const settings = require('./settings');
const log = require('./logger');

let win = null, control = null, loaded = false, blockerId = null;
const pending = [];   // команды, пришедшие до загрузки окна вывода

function init(controlWin) { control = controlWin; }

// Целевой монитор: сохранённый → если пропал, вывод останавливаем (missing), а не «прыгаем» на другой
function target() {
	const all = screen.getAllDisplays();
	const saved = settings.get().outputDisplayId;
	if (saved != null) {
		const d = all.find(x => x.id === saved);
		return d ? { display: d, missing: false } : { display: null, missing: true };
	}
	const primary = screen.getPrimaryDisplay();
	return { display: all.find(x => x.id !== primary.id) || primary, missing: false };
}

// Полноэкран только если вывод НЕ на том же мониторе, где окно управления (иначе перекроем управление)
function isFull(display) {
	const ctrlDisplay = control ? screen.getDisplayMatching(control.getBounds()) : null;
	return settings.get().outputFullscreen && (!ctrlDisplay || display.id !== ctrlDisplay.id);
}

function info() {
	const all = screen.getAllDisplays(), primary = screen.getPrimaryDisplay(), t = target();
	return {
		displays: all.map((d, i) => ({
			id: d.id, primary: d.id === primary.id,
			label: `${i + 1}: ${d.label || 'Монитор'} — ${d.size.width}×${d.size.height}${d.id === primary.id ? ' (основной)' : ''}`
		})),
		outputId: t.display ? t.display.id : null,
		missing: t.missing,
		mode: !t.display ? 'none' : isFull(t.display) ? 'fullscreen' : 'window'
	};
}

function ensure() {
	if (win && !win.isDestroyed()) return;
	loaded = false;
	win = new BrowserWindow({
		show: false, frame: false, backgroundColor: '#000000',
		focusable: false,            // окно вывода никогда не получает фокус
		skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
		fullscreenable: false, hasShadow: false,
		thickFrame: false,
		useContentSize: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload-output.js'),
			contextIsolation: true, nodeIntegration: false, sandbox: true,
			backgroundThrottling: false,                      // КРИТИЧНО: не замораживать видео
			autoplayPolicy: 'no-user-gesture-required'
		}
	});
	win.setIgnoreMouseEvents(true);
	win.loadFile(path.join(__dirname, '../renderer/output/output.html'));
	win.webContents.on('did-finish-load', () => {
		loaded = true;
		pending.splice(0).forEach(m => win.webContents.send('out:cmd', m));
	});
	// Падение рендерера вывода: пересоздаём окно, управление пересылает текущий кадр по событию 'ready'
	win.webContents.on('render-process-gone', (_e, d) => {
		log.error('Окно вывода упало: ' + d.reason);
		try { win.destroy(); } catch { } win = null; sync();
		if (control && !control.isDestroyed()) control.webContents.send('out:event', { type: 'crashed' });
	});
	win.on('closed', () => { win = null; });
}

// Приводит окно вывода в соответствие с настройками и подключёнными мониторами
function sync() {
	const t = target();
	if (!t.display) { if (win && !win.isDestroyed()) win.hide(); keepAwake(false); return; }
	ensure();
	const d = t.display;
	let b;
	if (isFull(d)) { b = d.bounds; win.setAlwaysOnTop(true, 'screen-saver'); }
	else { const w = 960, h = 540, a = d.workArea; b = { x: a.x + a.width - w - 24, y: a.y + a.height - h - 24, width: w, height: h }; win.setAlwaysOnTop(true, 'screen-saver'); }
	const safeBounds = {
		x: Math.round(b.x),
		y: Math.round(b.y),
		width: Math.round(b.width),
		height: Math.round(b.height)
	};
	win.setBounds(safeBounds);
	// Повторно: при разном DPI мониторов Windows первый setBounds может дать неверный размер
	setTimeout(() => { if (win && !win.isDestroyed()) win.setBounds(safeBounds); }, 60);
	if (!win.isVisible()) win.showInactive();       // показать без захвата фокуса
	win.showInactive(); // Принудительно показываем
	keepAwake(settings.get().keepAwake);
}
function keepAwake(on) {
	if (on && blockerId == null) { blockerId = powerSaveBlocker.start('prevent-display-sleep'); log.info('Блокировка сна включена'); }
	if (!on && blockerId != null) { powerSaveBlocker.stop(blockerId); blockerId = null; log.info('Блокировка сна выключена'); }
}

function send(msg) {
	if (!win || win.isDestroyed()) return;
	if (!loaded) pending.push(msg); else win.webContents.send('out:cmd', msg);
}

function forceHide() {
	if (win && !win.isDestroyed()) {
		win.hide(); // Мгновенно скрываем окно вывода
	}
}

function destroy() { keepAwake(false); if (win && !win.isDestroyed()) win.destroy(); }

module.exports = { init, sync, info, send, destroy, forceHide };