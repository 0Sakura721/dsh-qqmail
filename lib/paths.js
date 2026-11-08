/**
 * dsh-qqmail / lib/paths.js
 *
 * 所有落盘位置集中在这里，避免散落在各处。
 * 插件自己的状态目录：~/.dsh/qqmail/
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
export const PLUGIN_HOME = path.join(DSH_HOME, 'qqmail');

export const CONFIG_PATH = path.join(PLUGIN_HOME, 'config.json');
export const CREDENTIALS_PATH = path.join(PLUGIN_HOME, 'credentials.json');
export const STATE_PATH = path.join(PLUGIN_HOME, 'state.json');
export const LOG_PATH = path.join(PLUGIN_HOME, 'qqmail.log');

/** WorkBuddy 连接器根目录（可选凭据来源）。 */
export const WORKBUDDY_HOME = path.join(HOME, '.workbuddy');
export const WORKBUDDY_CONNECTORS = path.join(WORKBUDDY_HOME, 'connectors');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  return file;
}

/** 简单的追加式日志，出错不影响主流程。 */
export function log(...parts) {
  try {
    ensureDir(PLUGIN_HOME);
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : safeStringify(p))).join(' ')}\n`;
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch {
    /* ignore */
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
