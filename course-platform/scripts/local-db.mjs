import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.local');
const data = path.join(local, 'postgres');
const socket = path.join(local, 'socket');
const passwordFile = path.join(local, 'db-password');
const port = '55433';
const user = 'design_local';
const database = 'design_innovation';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`无法执行 ${command}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 失败：${result.stderr || result.stdout}`);
  return result.stdout;
}

function running() {
  return existsSync(path.join(data, 'PG_VERSION')) && spawnSync('pg_ctl', ['-D', data, 'status'], { stdio: 'ignore' }).status === 0;
}

try {
  const action = process.argv[2] || 'start';
  if (action === 'stop') {
    if (running()) run('pg_ctl', ['-D', data, 'stop', '-m', 'fast', '-w']);
    console.log('项目独立数据库已停止；数据文件保留。');
    process.exit(0);
  }
  if (action !== 'start') throw new Error('仅支持 start / stop');
  mkdirSync(local, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  if (!existsSync(passwordFile)) {
    if (existsSync(path.join(data, 'PG_VERSION'))) throw new Error('数据库已存在但密码文件缺失，请人工恢复；不会重建已有数据。');
    writeFileSync(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const password = readFileSync(passwordFile, 'utf8').trim();
  if (!existsSync(path.join(data, 'PG_VERSION'))) {
    run('initdb', ['-D', data, '-U', user, '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile', passwordFile, '--encoding=UTF8', '--locale=C']);
  }
  if (!running()) {
    run('pg_ctl', ['-D', data, '-l', path.join(local, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k '${socket}'`, '-w', 'start']);
  }
  const env = { ...process.env, PGPASSWORD: password, PGHOST: '127.0.0.1', PGPORT: port, PGUSER: user };
  const found = run('psql', ['-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${database}'`], { env });
  if (!found.trim()) run('createdb', [database], { env });
  const envFile = path.join(root, '.env');
  if (!existsSync(envFile)) {
    const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
    writeFileSync(envFile, `DATABASE_URL=${url}\nAPP_URL=http://127.0.0.1:4174\nDEMO_AUTH_ENABLED=true\n`, { mode: 0o600 });
  }
  chmodSync(passwordFile, 0o600);
  console.log(`项目数据库运行于 127.0.0.1:${port}，数据库 ${database}。`);
  console.log('本地配置已准备；运行 npm run db:migrate 和 npm run db:seed 初始化表与演示数据。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
