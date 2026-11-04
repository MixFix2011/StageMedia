const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = (c, ...a) => ipcRenderer.invoke(c, ...a);
const ALLOWED = ['out:event', 'displays:changed', 'app:close-request', 'log:line'];

contextBridge.exposeInMainWorld('api', {
	pickFiles: () => inv('files:pick'),
	pickFolder: () => inv('files:pickFolder'),
	readDir: p => inv('files:readDir', p),
	pickFolderPath: () => inv('files:pickFolderPath'),
	pickBgImage: () => inv('bg:pickImage'),
	resolvePaths: p => inv('files:resolve', p),
	pathForFile: f => webUtils.getPathForFile(f),      // путь dropped-файла (File.path убран в новых Electron)
	exists: p => inv('files:exists', p),
	thumb: (p, s) => inv('thumb:get', p, s),
	getSettings: () => inv('settings:get'),
	setSettings: p => inv('settings:set', p),
	getDisplays: () => inv('displays:list'),
	loadQueue: () => inv('queue:load'),
	saveQueue: q => ipcRenderer.send('queue:save', q),
	out: m => ipcRenderer.send('out:cmd', m),
	gpu: () => inv('app:gpu'),
	openLogs: () => inv('log:open'),
	recentLog: () => inv('log:recent'),
	log: (l, m) => ipcRenderer.send('log:write', l, m),
	quit: () => ipcRenderer.send('app:quit'),
	on: (ch, fn) => { if (ALLOWED.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a)); },
	openExternal: url => ipcRenderer.send('app:openExternal', url),
	exportSettings: () => inv('settings:export'),
	importSettings: () => inv('settings:import'),
	searchFiles: (dir, q) => inv('files:search', dir, q),
});