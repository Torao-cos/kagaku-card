#!/usr/bin/env node
/*
 * tools/deploy.js — docs/ を Cloudflare Pages プロジェクト kagaku-card にデプロイする
 *
 *   npm run deploy            （npm run ship = test → build → push。deploy は別コマンド）
 *   node tools/deploy.js --check   … 認証情報の解決と Pages プロジェクトの読み取り確認だけ（デプロイしない）
 *
 * 認証情報はリポジトリに置かない。company の共通ローダー経由で読む:
 *   CLOUDFLARE_PAGES_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
 *   （環境変数 → D:/claude_projects/company/.env の順。ローダーの場所は env COMPANY_SECRETS_LOADER で上書き可）
 *   環境変数 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID が既にあればそれを優先。
 *   旧 claude_share/control の平文ファイルは 2026-10-05 に廃止。
 *
 * wrangler.jsonc（Workers 用）が同じディレクトリにあると Pages デプロイが拒否されるため、
 * docs/ を一時ディレクトリにコピーしてそこから実行する。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'kagaku-card';
const LOADER = process.env.COMPANY_SECRETS_LOADER || 'D:/claude_projects/company/tools/load-secrets.js';

function loadCreds() {
  try {
    const { getSecret } = require(LOADER);
    return {
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || getSecret('CLOUDFLARE_PAGES_API_TOKEN'),
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || getSecret('CLOUDFLARE_ACCOUNT_ID'),
    };
  } catch (e) {
    console.error('✗ 認証情報を読めない（loader: ' + LOADER + '）: ' + e.message);
    process.exit(2);
  }
}

async function check() {
  const c = loadCreds();
  console.log('token length ' + c.CLOUDFLARE_API_TOKEN.length + ' / account id length ' + c.CLOUDFLARE_ACCOUNT_ID.length);
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + c.CLOUDFLARE_ACCOUNT_ID + '/pages/projects/' + PROJECT,
    { headers: { Authorization: 'Bearer ' + c.CLOUDFLARE_API_TOKEN } });
  const j = await r.json().catch(() => ({}));
  console.log('GET pages/projects/' + PROJECT + ': HTTP ' + r.status + ' success=' + j.success + (j.result ? ' subdomain=' + j.result.subdomain : ''));
  process.exitCode = r.ok ? 0 : 1;
}

function main() {
  const dist = path.join(ROOT, 'docs');
  if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('✗ docs/index.html がない。先に npm run build'); process.exit(1); }
  const version = fs.existsSync(path.join(dist, 'version.txt')) ? fs.readFileSync(path.join(dist, 'version.txt'), 'utf8').trim() : '?';
  const creds = loadCreds();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kagaku-deploy-'));
  fs.cpSync(dist, path.join(tmp, 'dist'), { recursive: true });
  const env = Object.assign({}, process.env, creds);
  console.log('→ Cloudflare Pages / ' + PROJECT + ' へデプロイ (version ' + version + ')');
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'pages', 'deploy', 'dist', '--project-name', PROJECT, '--branch', 'main', '--commit-dirty=true'],
    { cwd: tmp, env, stdio: 'inherit', shell: process.platform === 'win32' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) { console.error('✗ デプロイ失敗'); process.exit(r.status || 1); }
  console.log('✓ 本番URL: https://' + PROJECT + '.pages.dev/  （反映確認: curl -s https://' + PROJECT + '.pages.dev/version.txt → ' + version + '）');
}

if (process.argv.includes('--check')) check().catch(e => { console.error(e.message); process.exit(1); });
else main();
