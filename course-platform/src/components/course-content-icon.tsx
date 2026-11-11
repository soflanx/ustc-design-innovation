import type { ReactNode } from 'react';

export type CourseIconName = 'text' | 'heading' | 'list' | 'numbered' | 'check' | 'quote' | 'info' | 'warning' | 'goal' | 'toggle' | 'chevronDown' | 'image' | 'assignment' | 'resource' | 'group' | 'database' | 'grid' | 'link' | 'more' | 'close' | 'arrowUp' | 'arrowDown' | 'copy' | 'trash' | 'insertAbove' | 'insertBelow' | 'split' | 'plus' | 'external' | 'search' | 'grip' | 'undo';

const drawings: Record<CourseIconName, ReactNode> = {
  text: <><path d="M4 5h16M12 5v14M8 19h8"/></>,
  heading: <><path d="M5 5v14M19 5v14M5 12h14"/></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/></>,
  numbered: <><path d="M10 6h10M10 12h10M10 18h10M3 4h1v5M2.5 9h3M2.5 14a1.5 1.5 0 0 1 3 0c0 1-3 2-3 4h3"/></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/></>,
  quote: <><path d="M9 7H4v6h5V7ZM20 7h-5v6h5V7ZM9 13c0 3-2 4-4 4M20 13c0 3-2 4-4 4"/></>,
  info: <><circle cx="12" cy="12" r="8.5"/><path d="M12 11v6M12 7v.1"/></>,
  warning: <><path d="m12 3 9.5 17h-19L12 3ZM12 9v5M12 17v.1"/></>,
  goal: <><circle cx="12" cy="12" r="8.5"/><path d="m8 12 3 3 5-6"/></>,
  toggle: <path d="m9 5 7 7-7 7"/>,
  chevronDown: <path d="m5 9 7 7 7-7"/>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 4-6 5 7"/></>,
  assignment: <><path d="M9 4H5v17h14V4h-4M9 3h6v4H9zM8 12l1 1 2-2M8 17l1 1 2-2M14 12h2M14 17h2"/></>,
  resource: <><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h6"/></>,
  group: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
  database: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M3 15h18"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  link: <><path d="m10 8 2-2a5 5 0 0 1 7 7l-2 2M14 16l-2 2a5 5 0 0 1-7-7l2-2M9 15l6-6"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  arrowUp: <path d="M12 20V4m-6 6 6-6 6 6"/>,
  arrowDown: <path d="M12 4v16m-6-6 6 6 6-6"/>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
  trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
  insertAbove: <><rect x="4" y="13" width="16" height="7" rx="1"/><path d="M12 3v7M8.5 6.5h7"/></>,
  insertBelow: <><rect x="4" y="4" width="16" height="7" rx="1"/><path d="M12 14v7M8.5 17.5h7"/></>,
  split: <><path d="M5 3v6h14V3M5 21v-6h14v6M3 12h18"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  external: <><path d="M14 3h7v7M21 3 10 14M10 5H4v15h15v-6"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  undo: <path d="M8 4 3 9l5 5M4 9h10a6 6 0 0 1 0 12"/>,
  grip: <><circle cx="8" cy="5" r="1"/><circle cx="16" cy="5" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="8" cy="19" r="1"/><circle cx="16" cy="19" r="1"/></>,
};

export function CourseContentIcon({ name, size = 18, className }: { name: CourseIconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{drawings[name]}</svg>;
}
