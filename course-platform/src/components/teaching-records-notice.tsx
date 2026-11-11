'use client';

import Link from 'next/link';
import { createContext, useState, type ReactNode } from 'react';

type Notice = { message: string; historyHref?: string; recordHref?: string };

export const TeachingRecordsNoticeContext = createContext<((notice: Notice) => void) | null>(null);

export function TeachingRecordsNotice({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice>();
  return <TeachingRecordsNoticeContext.Provider value={setNotice}>
    <div>
      <div role="status">
        {notice && <p className="notice">
          {notice.message}
          {notice.recordHref && <> <a href={notice.recordHref}>查看刚保存的记录</a></>}
          {notice.historyHref && <> <Link href={notice.historyHref} prefetch={false}>查看历史</Link></>}
        </p>}
      </div>
      {children}
    </div>
  </TeachingRecordsNoticeContext.Provider>;
}
