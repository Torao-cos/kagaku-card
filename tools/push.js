#!/usr/bin/env node
/*
 * tools/push.js — main ブランチを GitHub（Torao-cos/kagaku-card）へ push する
 *
 *   npm run push   （npm run ship の最後にも走る）
 *   node tools/push.js --check   … トークン解決＋ git ls-remote（読み取りのみ・push しない）
 *
 * 認証: リポ限定の fine-grained PAT（Contents: Read&Write）。リポジトリには置かない。
 *   1) 環境変数 KAGAKU_GH_TOKEN
 *   2) company 共通ローダーの GITHUB_PAT_KAGAKU_CARD（環境変数 → D:/claude_projects/company/.env）
 *      ローダーの場所は env COMPANY_SECRETS_LOADER で上書き可。旧 claude_share/control の平文ファイルは 2026-10-05 に廃止。
 * トークンは remote URL に埋めず、この1回の push だけ Authorization ヘッダで渡す（git config やログに残さない）。
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REMOTE = 'https://github.com/Torao-cos/kagaku-card.git';
const LOADER = process.env.COMPANY_SECRETS_LOADER || 'D:/claude_projects/company/tools/load-secrets.js';

function loadToken() {
  if (process.env.KAGAKU_GH_TOKEN) return process.env.KAGAKU_GH_TOKEN;
  try {
    return require(LOADER).getSecret('GITHUB_PAT_KAGAKU_CARD');
  } catch (e) {
    console.error('✗ GitHub トークンを読めない（loader: ' + LOADER + '）: ' + e.message);
    process.exit(2);
  }
}

function git(args, extraEnv) {
  return spawnSync('git', args, { cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, extraEnv || {}) });
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const b64 = Buffer.from('x-access-token:' + loadToken()).toString('base64');
  const auth = ['-c', 'http.extraheader=AUTHORIZATION: basic ' + b64];
  if (checkOnly) {
    const r = git(auth.concat(['ls-remote', '--heads', REMOTE]));
    if (r.status !== 0) { console.error('✗ ls-remote 失敗'); process.exit(r.status || 1); }
    console.log('✓ 認証OK（読み取りのみ）');
    return;
  }
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (dirty) { console.error('✗ 未コミットの変更があります。先に commit してください:\n' + dirty); process.exit(1); }
  const remotes = spawnSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8' }).stdout.split(/\s+/);
  if (remotes.indexOf('origin') < 0) git(['remote', 'add', 'origin', REMOTE]);
  const r = git(auth.concat(['push', 'origin', 'main']));
  if (r.status !== 0) { console.error('✗ push 失敗'); process.exit(r.status || 1); }
  console.log('✓ GitHub: https://github.com/Torao-cos/kagaku-card');
}
main();
