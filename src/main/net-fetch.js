'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { net } = require('electron');

/**
 * Small shared GET helper used by the catalog and app release-feed checks.
 * Supports https://, file:// URLs and plain local paths so everything works
 * offline and in tests without special-casing each caller.
 */

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

function readLocal(url) {
  if (url.startsWith('file://')) {
    return fs.readFile(fileURLToPath(url), 'utf8');
  }
  return fs.readFile(path.resolve(url), 'utf8');
}

function fetchRemote(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'follow' });
    for (const [key, value] of Object.entries(headers)) {
      if (value) request.setHeader(key, value);
    }

    const chunks = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`));
      request.abort();
    }, timeoutMs);

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        finish(reject, new Error(`Server responded with HTTP ${response.statusCode}.`));
        response.resume();
        return;
      }
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      response.on('error', (err) => finish(reject, err));
    });
    request.on('error', (err) => finish(reject, err));
    request.end();
  });
}

/** GET a URL/path and return its body as text. */
async function fetchText(url, timeoutMs = 8000, headers = {}) {
  if (!url || typeof url !== 'string') throw new Error('No URL configured.');
  if (url.startsWith('file://') || !isHttpUrl(url)) {
    return readLocal(url);
  }
  return fetchRemote(url, timeoutMs, headers);
}

/** Convert a local file path to a file:// URL for renderer-safe display. */
function toFileUrl(file) {
  return pathToFileURL(path.resolve(file)).href;
}

module.exports = { fetchText, isHttpUrl, toFileUrl };
