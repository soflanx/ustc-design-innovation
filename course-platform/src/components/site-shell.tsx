import Link from 'next/link';
import type { ReactNode } from 'react';

export type SiteUser = { name: string; roleLabel?: string };
type PageContext = 'public' | 'workspace';
type CourseContext = { label: string; fullName: string };

export function SiteHeader({ currentUser, context = 'public', courseContext }: { currentUser?: SiteUser | null; context?: PageContext; courseContext?: CourseContext }) {
  return <header className={`site-header${courseContext ? ' course-site-header' : ''}`}><div className="container header-inner">
    <div className="header-identity"><Link href="/" className="site-brand">设计创新</Link>{courseContext && <span className="header-course" title={courseContext.fullName}>{courseContext.label}</span>}</div>
    <nav className="site-nav" aria-label="主导航">
      {context === 'public' ? <><a href="/#news">动态</a><a href="/#stories">故事</a><Link href="/courses">课程</Link><Link className="public-entry" href="/workspace">{currentUser ? '我的课程' : '师生入口'}</Link></> : <Link href="/workspace?view=all">全部课程</Link>}
      {currentUser && context === 'workspace' && <details className="account-menu"><summary>{currentUser.name}</summary><div className="account-menu-content"><Link href="/login">切换演示身份</Link><form action="/api/logout" method="post"><button type="submit" className="link-button">退出登录</button></form></div></details>}
    </nav>
  </div></header>;
}

export function SiteFooter({ context = 'public' }: { context?: PageContext }) {
  if (context === 'workspace') return <footer className="site-footer"><div className="container">本地演示 · 人物与内容均为示例</div></footer>;
  return <footer className="site-footer public-footer"><div className="container">
    <div className="public-footer-main"><Link className="site-brand" href="/">设计创新</Link><nav aria-label="页脚导航"><a href="/#news">交流与现场</a><a href="/#stories">学生故事</a><Link href="/courses">课程与学期</Link></nav></div>
    <div className="public-footer-bottom"><span>前端样稿 · 内容与图片为展示示例</span><Link href="/workspace">师生入口</Link></div>
  </div></footer>;
}

export function PageShell({ children, currentUser, context = 'public', homeLayout = false, courseContext }: { children: ReactNode; currentUser?: SiteUser | null; context?: PageContext; homeLayout?: boolean; courseContext?: CourseContext }) {
  return <div className={`site-shell ${context}-shell${homeLayout ? ' editorial-home' : ''}`}><a className="skip-link" href="#main-content">跳到主要内容</a><SiteHeader currentUser={currentUser} context={context} courseContext={courseContext}/><main id="main-content">{children}</main><SiteFooter context={context}/></div>;
}
