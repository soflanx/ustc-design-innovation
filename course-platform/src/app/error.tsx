'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="container section stack"><h1>暂时无法加载页面</h1><p>请稍后重试。如果本地数据库尚未启动，请先启动项目数据库。</p><div><button type="button" className="button primary" onClick={reset}>重新加载</button></div></div>;
}
