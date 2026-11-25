'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { stateFile } = require('./paths');

/**
 * installed.json schema
 * {
 *   "schemaVersion": 1,
 *   "plugins": {
 *     "<catalog plugin id>": {
 *       "version": "1.2.0",
 *       "installedAt": "2026-11-24T10:00:00.000Z",
 *       "sourceUrl": "https://...",
 *       "bundles": [{ "format": "AU", "path": "/Users/.../KYROlll SOUL.component" }]
 *     }
 *   }
 * }
 */

function emptyState() {
  return { schemaVersion: 1, plugins: {} };
}

async function read() {
  try {
    const raw = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.plugins !== 'object' || !raw.plugins) return emptyState();
    return { schemaVersion: 1, plugins: { ...raw.plugins } };
  } catch {
    return emptyState();
  }
}

async function write(state) {
  const file = stateFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

async function setRecord(pluginId, record) {
  const state = await read();
  state.plugins[pluginId] = record;
  await write(state);
  return record;
}

async function removeRecord(pluginId) {
  const state = await read();
  delete state.plugins[pluginId];
  await write(state);
}

module.exports = { read, write, setRecord, removeRecord, stateFile };
