/**
 * Cookie 铸造与密钥读取的测试。不连 DSH，纯本地。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  mintBrowserSessionCookie,
  readBrowserSessionSecret,
} from '../src/dsh/client.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decodePayload = (cookie) => {
  const value = cookie.split('=')[1];          // v1.<payload>.<sig>
  const body = value.split('.')[1];
  return JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
};

const SECRET = randomBytes(32);

check('Cookie 名字前缀正确', () => {
  const cookie = mintBrowserSessionCookie('http://127.0.0.1:3080', SECRET);
  assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\./);
});

check('payload 绑定 authority 与有效期', () => {
  const cookie = mintBrowserSessionCookie('http://127.0.0.1:3080', SECRET, { lifetimeMs: 60_000 });
  const payload = decodePayload(cookie);
  assert.equal(payload.authority, '127.0.0.1:3080');
  assert.equal(payload.version, 1);
  assert.equal(payload.expiresAt - payload.issuedAt, 60_000);
});

check('同一 authority 的 Cookie 名稳定', () => {
  const a = mintBrowserSessionCookie('http://127.0.0.1:3080', SECRET);
  const b = mintBrowserSessionCookie('http://127.0.0.1:3080', SECRET);
  assert.equal(a.split('=')[0], b.split('=')[0]);
});

check('不同 authority 的 Cookie 名不同', () => {
  const a = mintBrowserSessionCookie('http://127.0.0.1:3080', SECRET);
  const b = mintBrowserSessionCookie('http://127.0.0.1:9999', SECRET);
  assert.notEqual(a.split('=')[0], b.split('=')[0]);
});

// ── 密钥读取（造一个假 DSH_HOME）─────────────────────────────
function withFakeHome(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), content, 'utf8');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return fn();
  } finally {
    process.env.DSH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const yaml = (secret) => [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  `      secret: ${secret}`,
  '  deepseek-account-platform/default:',
  '    kind: grant',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-xxx',
  '',
].join('\n');

check('读到 32 字节密钥', () => {
  const secret = b64url(SECRET);
  const got = withFakeHome(yaml(secret), () => readBrowserSessionSecret());
  assert.ok(got);
  assert.equal(got.byteLength, 32);
  assert.equal(got.toString('hex'), SECRET.toString('hex'));
});

check('密钥长度不对时返回 null', () => {
  const got = withFakeHome(yaml(b64url(randomBytes(16))), () => readBrowserSessionSecret());
  assert.equal(got, null);
});

check('文件不存在时返回 null', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now());
  try {
    assert.equal(readBrowserSessionSecret(), null);
  } finally {
    process.env.DSH_HOME = prev;
  }
});

check('块外同名字段不会被误读', () => {
  const text = yaml(b64url(SECRET))
    .replace('refs:\n  DEEPSEEK_API_KEY: sk-xxx', 'refs:\n  secret: ' + b64url(randomBytes(32)));
  const got = withFakeHome(text, () => readBrowserSessionSecret());
  assert.equal(got.toString('hex'), SECRET.toString('hex'));
});

console.log(`\n${passed} 项通过`);
