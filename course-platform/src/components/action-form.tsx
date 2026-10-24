'use client';

import { useActionState, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { FormState } from '@/lib/form-state';

export function ActionForm({ action, children, submitLabel, className = 'stack', disabled = false }: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  children: ReactNode;
  submitLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const router = useRouter();
  useEffect(() => {
    if (state.redirectTo) router.push(state.redirectTo);
    else if (state.success) router.refresh();
  }, [state, router]);
  return <form action={formAction} className={className}>{children}{state.error && <p className="notice error" role="alert">{state.error}</p>}{state.success && <p className="notice" role="status">{state.success}</p>}<div><button type="submit" className="button primary" disabled={pending || disabled}>{pending ? '正在保存…' : submitLabel}</button></div></form>;
}
