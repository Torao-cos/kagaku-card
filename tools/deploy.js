#!/usr/bin/env node
/*
 * tools/deploy.js — dist/ を Cloudflare Pages プロジェクト kagaku-card にデプロイする
 *
 *   npm run deploy   （npm run ship = test → build → deploy）
 *
 * 認証情報はリポジトリに置かない。次の順で探す:
 *   1) 環境変数 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
 *   2) 環境変数 KAGAKU_CF_CREDS が指すテキストファイル（「Account ID: …」「API Token (...): …」の行を含む）
 *   3) 既定のファイル（owner の OneDrive 上・git 管理外）
 *
 * wrangler.jsonc（Workers 用）が同じディレクトリにあると Pages デプロイが拒否されるため、
 * dist/ を一時ディレクトリにコピーしてそこから実行する。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'kagaku-card';
const DEFAULT_CREDS = 'C:/Users/Yasuhiro/OneDrive/事業用フォルダ/claude_share/control/cloudflare-tango-quiz-credentials.txt';

function loadCreds() {
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) return {};
  const file = process.env.KAGAKU_CF_CREDS || DEFAULT_CREDS;
  if (!fs.existsSync(file)) {
    console.error('✗ 認証情報が見つからない。CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を環境変数に入れるか、KAGAKU_CF_CREDS でファイルを指定してください。');
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const tok = /API Token[^:]*:\s*(\S+)/.exec(text);
  const acc = /Account ID:\s*([0-9a-f]{32})/.exec(text);
  if (!tok || !acc) { console.error('✗ 認証ファイルの形式が想定と違う: ' + file); process.exit(2); }
  return { CLOUDFLARE_API_TOKEN: tok[1], CLOUDFLARE_ACCOUNT_ID: acc[1] };
}

function main() {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('✗ dist/index.html がない。先に npm run build'); process.exit(1); }
  const version = fs.existsSync(path.join(dist, 'version.txt')) ? fs.readFileSync(path.join(dist, 'version.txt'), 'utf8').trim() : '?';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kagaku-deploy-'));
  fs.cpSync(dist, path.join(tmp, 'dist'), { recursive: true });
  const env = Object.assign({}, process.env, loadCreds());
  console.log('→ Cloudflare Pages / ' + PROJECT + ' へデプロイ (version ' + version + ')');
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'pages', 'deploy', 'dist', '--project-name', PROJECT, '--branch', 'main', '--commit-dirty=true'],
    { cwd: tmp, env, stdio: 'inherit', shell: process.platform === 'win32' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) { console.error('✗ デプロイ失敗'); process.exit(r.status || 1); }
  console.log('✓ 本番URL: https://' + PROJECT + '.pages.dev/  （反映確認: curl -s https://' + PROJECT + '.pages.dev/version.txt → ' + version + '）');
}
main();
