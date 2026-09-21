import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const emptyState = () => ({ version: 1, binding: null, halted: null, blockedUntil: 0, lastClock: 0, rules: {}, items: [], seen: [] });

export class Store {
  constructor(root) { this.dir = resolve(root, '.local'); this.path = resolve(this.dir, 'state.json'); }
  async prepare() { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }
  async read() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.items) || !Array.isArray(state.seen)) throw new Error('Invalid state file; do not replace it to resume posting.');
      return state;
    } catch (e) { if (e.code === 'ENOENT') return emptyState(); throw e; }
  }
  async write(state) {
    const previous = await this.read();
    state.blockedUntil = Math.max(state.blockedUntil || 0, previous.blockedUntil || 0);
    await this.writeJson('state.json', state);
  }
  async stopped() {
    try { await readFile(resolve(this.dir, 'STOP')); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  async writeJson(name, value) {
    await this.prepare();
    const tmp = resolve(this.dir, `.${name}.${randomUUID()}.tmp`);
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(tmp, resolve(this.dir, name));
    // Directory fsync makes the rename durable on platforms that support it.
    try { const dir = await open(this.dir, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    catch (e) { if (!['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'EACCES'].includes(e.code)) throw e; }
  }
  async token() {
    try { return JSON.parse(await readFile(resolve(this.dir, 'oauth.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') throw new Error('Run auth to connect your approved Reddit application.'); throw e; }
  }
  async lock(fn) {
    await this.prepare();
    const path = resolve(this.dir, 'lock');
    let lock;
    try { lock = await open(path, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Another process or a stale lock exists. See README recovery steps.'); throw e; }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); return await fn(); }
    finally { await lock.close(); await unlink(path); }
  }
}
