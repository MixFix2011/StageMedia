'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ring = [];            // последние 500 строк для окна «Журнал»
let sink = () => { };
const dir = () => path.join(app.getPath('userData'), 'logs');

function write(level, msg) {
	const d = new Date();
	const line = `${d.toISOString().replace('T', ' ').slice(0, 23)} [${level}] ${msg}`;
	ring.push(line); if (ring.length > 500) ring.shift();
	try {
		fs.mkdirSync(dir(), { recursive: true });
		fs.appendFile(path.join(dir(), `show - ${d.toISOString().slice(0, 10)}.log`), line + '\n', () => { });
	} catch { /* лог не должен ронять приложение */ }
	sink(line);
}
module.exports = {
	write, dir,
	info: m => write('INFO', m), warn: m => write('WARN', m), error: m => write('ERROR', m),
	recent: () => ring.slice(), onLine: f => { sink = f; }
};