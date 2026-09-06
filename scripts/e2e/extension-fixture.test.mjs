/**
 * 插件装载夹具自检：缺省形态全站授权；scoped 形态只授权给定 origin、<all_urls> 留在 optional 侧。
 * 运行：node --test scripts/e2e/extension-fixture.test.mjs（家族 runner 开跑前也会执行）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareExtensionDir, removeExtensionDir } from './extension-fixture.mjs';

const EXTENSION_DIR = resolve(fileURLToPath(import.meta.url), '../../..', 'apps', 'extension');

function loadManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

test('缺省形态：optional_host_permissions 整体提为 host_permissions', () => {
  const dir = prepareExtensionDir(EXTENSION_DIR);
  try {
    const manifest = loadManifest(dir);
    assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
    assert.equal(manifest.optional_host_permissions, undefined);
  } finally {
    removeExtensionDir(dir);
  }
});

test('scoped 形态：host_permissions 只含给定 origin，<all_urls> 留在 optional 侧', () => {
  const dir = prepareExtensionDir(EXTENSION_DIR, { hostPermissions: ['http://127.0.0.1/*'] });
  try {
    const manifest = loadManifest(dir);
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
    assert.ok(!manifest.host_permissions.includes('<all_urls>'));
    assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  } finally {
    removeExtensionDir(dir);
  }
});

test('scoped 形态拒绝 <all_urls>', () => {
  assert.throws(() => prepareExtensionDir(EXTENSION_DIR, { hostPermissions: ['<all_urls>'] }), /<all_urls>/);
});
