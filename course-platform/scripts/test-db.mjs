import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

// Never run integration fixtures in the application's database.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('集成测试仅允许连接本机数据库。请先运行 npm run db:local。');
}
const testName = `design_test_${randomBytes(8).toString('hex')}`;
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const testUrl = new URL(base);
testUrl.pathname = `/${testName}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
let created = false;

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl.toString(), NODE_ENV: 'test' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`测试命令退出码 ${result.status}`);
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${testName}"`);
  created = true;
  run(path.join(root, 'node_modules/prisma/build/index.js'), ['migrate', 'deploy']);
  const files = readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.ts')).map(file => path.join(root, 'tests', file));
  // Files share this isolated database. Run fixtures serially so unrelated
  // Serializable transactions do not conflict; explicit concurrency tests
  // inside each file still exercise simultaneous application writes.
  run('--import', ['tsx', '--test', '--test-concurrency=1', ...files]);
} catch (error) {
  console.error(error instanceof Error ? error.message : '集成测试失败');
  process.exitCode = 1;
} finally {
  if (created) {
    await admin.query(`DROP DATABASE "${testName}" WITH (FORCE)`);
    console.log('隔离测试数据库已删除；开发数据保持不变。');
  }
  await admin.end();
}
