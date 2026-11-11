'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function SubmissionHistory({ count, children }: { count: number; children: ReactNode }) {
  const history = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function revealLinkedVersion() {
      const id = window.location.hash.slice(1);
      if (!id.startsWith('version-')) return;
      const target = document.getElementById(id);
      const section = history.current;
      if (!target || !section?.contains(target) || section.open) return;
      section.open = true;
      target.scrollIntoView({ block: 'start' });
    }
    revealLinkedVersion();
    window.addEventListener('hashchange', revealLinkedVersion);
    return () => window.removeEventListener('hashchange', revealLinkedVersion);
  }, []);
  return <details ref={history}><summary>更正历史与旧成果（{count}）</summary>{children}</details>;
}
