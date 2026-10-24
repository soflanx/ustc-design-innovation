import Link from 'next/link';
import { PageShell } from '@/components/site-shell';

export default function NotFound() {
  return <PageShell><div className="container section stack"><h1>页面暂不可访问</h1><p>内容可能尚未公开，或当前账号没有访问权限。</p><div className="inline-actions"><Link className="button primary" href="/workspace">我的课程</Link><Link className="button secondary" href="/">返回首页</Link></div></div></PageShell>;
}
