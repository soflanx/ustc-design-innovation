import Link from 'next/link';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { DEMO_USERS, demoAuthEnabled } from '@/lib/demo-config';
import { DEFAULT_RETURN_TO, normalizeReturnTo } from '@/lib/return-to';
import styles from './login.module.css';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[]; returnTo?: string | string[] }> }) {
  const user = await getCurrentUser();
  const { error, returnTo: requestedTarget } = await searchParams;
  const returnTo = normalizeReturnTo(requestedTarget);
  return <PageShell currentUser={user}><div className={`container ${styles.page}`}>
    <header className={styles.heading}><h1>进入课程空间</h1><p>本地演示使用虚构账号。{returnTo !== DEFAULT_RETURN_TO && '登录后返回刚才打开的页面。'}</p></header>
    {user && <p className={styles.currentAccount}>当前账号：{user.name}。<Link href={returnTo}>{returnTo === DEFAULT_RETURN_TO ? '进入我的课程' : '返回刚才的页面'} →</Link></p>}
    {error && <p role="alert" className="notice error">无法进入演示账号，请重新选择。</p>}
    {demoAuthEnabled() ? <div className={styles.accounts}>{DEMO_USERS.map(account => <form key={account.id} action="/api/demo-login" method="post" className={styles.account}>
      <input type="hidden" name="userId" value={account.id}/><input type="hidden" name="returnTo" value={returnTo}/>
      <div><h2>{account.label}</h2><p>{account.description}</p></div>
      <button type="submit" aria-label={`使用${account.label}身份`}>进入<span aria-hidden="true">→</span></button>
    </form>)}</div> : <p className="notice">当前环境未开启演示登录。</p>}
  </div></PageShell>;
}
