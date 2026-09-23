#!/usr/bin/env node
/*
 * tools/push.js — main ブランチを GitHub（Torao-cos/kagaku-card）へ push する
 *
 *   npm run push   （npm run ship の最後にも走る）
 *
 * 認証: リポ限定の fine-grained PAT（Contents: Read&Write）。リポジトリには置かない。
 *   1) 環境変数 KAGAKU_GH_TOKEN
 *   2) 環境変数 KAGAKU_GH_CREDS が指すテキストファイル（「Token: github_pat_…」の行を含む）
 *   3) 既定のファイル（owner の OneDrive 上・git 管理外）
 * トークンは remote URL に埋めず、この1回の push だけ Authorization ヘッダで渡す（git config やログに残さない）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CREDS = 'C:/Users/Yasuhiro/OneDrive/事業用フォルダ/claude_share/control/github-kagaku-card-pat.txt';
const REMOTE = 'https://github.com/Torao-cos/kagaku-card.git';

function loadToken() {
  if (process.env.KAGAKU_GH_TOKEN) return process.env.KAGAKU_GH_TOKEN;
  const file = process.env.KAGAKU_GH_CREDS || DEFAULT_CREDS;
  if (!fs.existsSync(file)) { console.error('✗ GitHub トークンが見つからない: ' + file); process.exit(2); }
  const m = /Token:\s*(github_pat_[A-Za-z0-9_]+)/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) { console.error('✗ トークンファイルの形式が想定と違う: ' + file); process.exit(2); }
  return m[1];
}

function git(args, extraEnv) {
  return spawnSync('git', args, { cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, extraEnv || {}) });
}

function main() {
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (dirty) { console.error('✗ 未コミットの変更があります。先に commit してください:\n' + dirty); process.exit(1); }
  const remotes = spawnSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8' }).stdout.split(/\s+/);
  if (remotes.indexOf('origin') < 0) git(['remote', 'add', 'origin', REMOTE]);
  const b64 = Buffer.from('x-access-token:' + loadToken()).toString('base64');
  const r = git(['-c', 'http.extraheader=AUTHORIZATION: basic ' + b64, 'push', 'origin', 'main']);
  if (r.status !== 0) { console.error('✗ push 失敗'); process.exit(r.status || 1); }
  console.log('✓ GitHub: https://github.com/Torao-cos/kagaku-card');
}
main();
