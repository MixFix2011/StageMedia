'use strict';
const { app, BrowserWindow, ipcMain, dialog, screen, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const log = require('./logger');
const files = require('./files');
const output = require('./output-window');

// В самом начале файла, после других require
const DiscordRPC = require('discord-rpc');

// Ваш Application ID из Discord Developer Portal
const clientId = '1567946693935108220';

// Создаем клиент для подключения к локальному Discord
const rpc = new DiscordRPC.Client({ transport: 'ipc' });

// Регистрируем приложение (это включает кнопки "Присоединиться" и т.п.)
DiscordRPC.register(clientId);

// Функция для установки статуса
async function setActivity() {
	if (!rpc) return;

	try {
		await rpc.setActivity({
			details: 'Управление медиа', // Верхняя строка статуса
			state: 'Готов к работе',      // Нижняя строка статуса
			startTimestamp: new Date(),   // Таймер с момента запуска
			largeImageKey: 'logo',        // Ключ иконки (см. Шаг 4)
			largeImageText: 'StageMedia', // Подсказка при наведении на иконку
			instance: false,
		});
	} catch (error) {
		console.error('Ошибка установки Discord Rich Presence:', error);
	}
}

// Когда Discord будет готов, устанавливаем статус
rpc.on('ready', () => {
	console.log('Discord RPC подключен!');
	setActivity();

	// Discord разрешает обновлять статус не чаще раза в 15 секунд
	setInterval(() => {
		setActivity();
	}, 15000);
});

// Подключаемся к Discord
rpc.login({ clientId }).catch(console.error);

// ---------- Производительность: GPU, декодирование, без троттлинга ----------
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'true');
// Без этого Chromium «усыпляет» окно, перекрытое другими окнами
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

process.on('uncaughtException', e => log.error('uncaughtException: ' + (e.stack || e)));
process.on('unhandledRejection', e => log.error('unhandledRejection: ' + (e && e.stack || e)));

let control = null, quitting = false;

function createControl() {
	control = new BrowserWindow({
		width: 1400, height: 860, minWidth: 1100, minHeight: 700, show: false,
		backgroundColor: '#0e1014', title: 'StageMedia — управление',
		icon: path.join(__dirname, '../../icon.ico'), // <--- ДОБАВИТЬ ЭТУ СТРОКУ
		webPreferences: {
			preload: path.join(__dirname, 'preload-control.js'),
			contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
		}
	});
	control.loadFile(path.join(__dirname, '../renderer/control/index.html'));
	control.once('ready-to-show', () => control.show());
	if (process.env.DEBUG) control.webContents.openDevTools({ mode: 'detach' });

	// Защита от случайного закрытия: спрашиваем подтверждение в интерфейсе
	control.on('close', e => {
		if (quitting || !settings.get().confirmClose) return;
		e.preventDefault();
		control.webContents.send('app:close-request');
	});
	control.on('moved', () => output.sync());   // окно управления перенесли на другой монитор
	control.on('closed', () => { control = null; });
	control.webContents.on('render-process-gone', (_e, d) => log.error('Окно управления: ' + d.reason));
}

const broadcastDisplays = () => control && !control.isDestroyed() && control.webContents.send('displays:changed', output.info());

function start() {
	Menu.setApplicationMenu(null);           // без меню: нет случайных Ctrl+R / F5 / DevTools
	settings.load();
	log.onLine(l => control && !control.isDestroyed() && control.webContents.send('log:line', l));
	log.info('Запуск приложения');
	createControl();
	output.init(control);
	output.sync();                           // сразу чёрный экран на проекторе

	// Подключение/отключение/смена разрешения мониторов (с задержкой: события приходят пачкой)
	let t; const onDisp = () => {
		clearTimeout(t); t = setTimeout(() => {
			log.info('Конфигурация мониторов изменилась'); output.sync(); broadcastDisplays();
		}, 300);
	};
	['display-added', 'display-removed', 'display-metrics-changed'].forEach(ev => screen.on(ev, onDisp));
}

// ---------- IPC ----------
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => {
	const s = settings.set(patch);
	if (['outputDisplayId', 'outputFullscreen', 'keepAwake'].some(k => k in patch)) { output.sync(); broadcastDisplays(); }
	return s;
});
ipcMain.handle('displays:list', () => output.info());

const filters = [{ name: 'Фото и видео', extensions: [...files.EXT.image, ...files.EXT.video].map(e => e.slice(1)) }];
ipcMain.handle('files:pick', async () => {
	const r = await dialog.showOpenDialog(control, { title: 'Добавить файлы', properties: ['openFile', 'multiSelections'], filters });
	return r.canceled ? [] : files.resolvePaths(r.filePaths);
});
ipcMain.handle('files:pickFolder', async () => {
	const r = await dialog.showOpenDialog(control, { title: 'Добавить папку', properties: ['openDirectory'] });
	return r.canceled ? [] : files.resolvePaths(r.filePaths);
});
ipcMain.handle('files:readDir', (_e, dirPath) => files.readDir(dirPath));
ipcMain.handle('files:pickFolderPath', async () => {
	const r = await dialog.showOpenDialog(control, { title: 'Выбрать папку', properties: ['openDirectory'] });
	return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('bg:pickImage', async () => {
	const r = await dialog.showOpenDialog(control, {
		title: 'Выбрать картинку для фона',
		properties: ['openFile'],
		filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
	});
	if (r.canceled || r.filePaths.length === 0) return null;
	// Возвращаем URL файла, чтобы output.js мог его загрузить
	return require('url').pathToFileURL(r.filePaths[0]).href;
});
ipcMain.handle('files:resolve', (_e, p) => files.resolvePaths(p));
ipcMain.handle('files:exists', (_e, p) => files.exists(p));
ipcMain.handle('thumb:get', (_e, p, s) => files.thumb(p, s));

// Очередь переживает перезапуск/сбой
const queueFile = () => path.join(app.getPath('userData'), 'queue.json');
let qTimer;
ipcMain.on('queue:save', (_e, q) => {
	clearTimeout(qTimer);
	qTimer = setTimeout(() => { try { settings.writeJsonAtomic(queueFile(), q); } catch (e) { log.error('queue save: ' + e.message); } }, 400);
});
ipcMain.handle('queue:load', async () => {
	try {
		const q = JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
		for (const it of q.items) it.missing = !(await files.exists(it.path));
		return q;
	} catch { return { items: [], curId: null }; }
});

// Реле управление ↔ вывод
ipcMain.on('out:cmd', (_e, m) => output.send(m));
ipcMain.on('out:forceHide', () => output.forceHide());
ipcMain.on('out:event', (_e, m) => control && !control.isDestroyed() && control.webContents.send('out:event', m));
ipcMain.handle('files:search', (_e, dir, q) => files.searchFiles(dir, q));
ipcMain.on('log:write', (_e, l, m) => log.write(String(l).slice(0, 10), String(m).slice(0, 500)));
ipcMain.handle('log:recent', () => log.recent());
ipcMain.handle('log:open', () => shell.openPath(log.dir()));
ipcMain.handle('app:gpu', () => app.getGPUFeatureStatus());
ipcMain.on('app:quit', () => { quitting = true; app.quit(); });

ipcMain.on('app:openExternal', (_e, url) => {
	shell.openExternal(url);
});

ipcMain.handle('settings:export', async () => {
	const r = await dialog.showSaveDialog(control, { title: 'Экспорт настроек', defaultPath: 'StageMedia-Backup.json' });
	if (r.canceled) return false;
	const qPath = path.join(app.getPath('userData'), 'queue.json');
	let qData = null;
	try { qData = JSON.parse(fs.readFileSync(qPath, 'utf8')); } catch (e) { }
	const backup = { settings: settings.get(), queue: qData };
	fs.writeFileSync(r.filePath, JSON.stringify(backup, null, 2));
	return true;
});

ipcMain.handle('settings:import', async () => {
	const r = await dialog.showOpenDialog(control, { title: 'Импорт настроек', properties: ['openFile'] });
	if (r.canceled) return false;
	try {
		const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
		if (data.settings) settings.set(data.settings);
		if (data.queue) {
			const qPath = path.join(app.getPath('userData'), 'queue.json');
			fs.writeFileSync(qPath, JSON.stringify(data.queue, null, 2));
		}
		return true;
	} catch (e) { return false; }
});

app.on('before-quit', () => { quitting = true; output.destroy(); });
app.on('window-all-closed', () => app.quit());

if (!app.requestSingleInstanceLock()) app.quit();           // вторая копия не запускается
else {
	app.on('second-instance', () => { if (control) { if (control.isMinimized()) control.restore(); control.focus(); } });
	app.whenReady().then(start);
}