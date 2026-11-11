'use client';

import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import Link from 'next/link';
import styles from '@/app/portal-home.module.css';

export function NewsCardLink({ href, children }: { href: string; children: ReactNode }) {
  function rememberCard() {
    // Keep Next's routing state intact and annotate only the entry we are leaving.
    try {
      const courseNewsCard = { article: href, page: window.location.href };
      window.history.replaceState({ ...window.history.state, courseNewsCard }, '');
    } catch { /* Navigation still works if the browser refuses the history update. */ }
  }
  return <Link className={styles.newsCardLink} href={href} data-news-card={href} onNavigate={rememberCard}>{children}</Link>;
}

export function NewsCarousel({ children, returnIndex }: { children: ReactNode; returnIndex?: number }) {
  const rail = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const [active, setActive] = useState(Math.max(0, returnIndex ?? 0) + 1);
  const count = Children.count(children);

  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    const savedCard = window.history.state?.courseNewsCard;
    let index = returnIndex;
    if (savedCard?.page === window.location.href && typeof savedCard.article === 'string') {
      index = Array.from(element.children).findIndex(slide => slide.querySelector('[data-news-card]')?.getAttribute('data-news-card') === savedCard.article);
    }
    if (index === undefined) return;
    const first = element.firstElementChild;
    const target = element.children.item(Math.max(0, index));
    if (first && target) {
      const left = target.getBoundingClientRect().left - first.getBoundingClientRect().left;
      element.scrollTo({ left, behavior: 'instant' });
    }
  }, [returnIndex]);

  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const update = () => {
      setEdges({ start: element.scrollLeft <= 2, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 });
      const width = element.firstElementChild?.getBoundingClientRect().width ?? element.clientWidth;
      const step = width + parseFloat(getComputedStyle(element).columnGap || '0');
      setActive(Math.min(count, Math.max(1, Math.round(element.scrollLeft / step) + 1)));
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { element.removeEventListener('scroll', update); observer.disconnect(); };
  }, [count]);

  function move(direction: number) {
    const element = rail.current;
    const firstCard = element?.firstElementChild;
    if (!element || !firstCard) return;
    const distance = firstCard.getBoundingClientRect().width + parseFloat(getComputedStyle(element).columnGap || '0');
    element.scrollBy({ left: direction * distance, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  function handleKey(event: KeyboardEvent<HTMLUListElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowRight' ? 1 : -1);
    }
  }

  return <>
    <div className={styles.newsHeading}>
      <h2 id="news-title">新闻</h2>
    </div>
    <ul id="news-rail" className={styles.newsRail} ref={rail} tabIndex={0} aria-label="课程新闻，可左右滚动" onKeyDown={handleKey}>
      {Children.map(children, (child, index) => <li className={styles.newsSlide} data-active={index + 1 === active}>{child}</li>)}
    </ul>
    <div className={styles.carouselControls} aria-label="新闻翻页">
      <span className={styles.carouselCount} aria-live="polite" aria-atomic="true"><span className="sr-only">第 </span>{String(active).padStart(2, '0')}<span className="sr-only"> 条，共 </span><span aria-hidden="true"> / </span><span>{String(count).padStart(2, '0')}</span><span className="sr-only"> 条新闻</span></span>
      <button type="button" aria-label="上一条新闻" aria-controls="news-rail" disabled={edges.start} onClick={() => move(-1)}><span aria-hidden="true">←</span></button>
      <button type="button" aria-label="下一条新闻" aria-controls="news-rail" disabled={edges.end} onClick={() => move(1)}><span aria-hidden="true">→</span></button>
    </div>
  </>;
}
