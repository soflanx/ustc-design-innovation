'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import styles from './hero-slideshow.module.css';

const photos = [
  { src: '/images/portal/student-presentation.jpg', label: '分享与交流', position: 'center 45%', mobilePosition: '55% center', width: 1600, height: 1067 },
  { src: '/images/portal/studio-hero.jpg', label: '动手实践', position: 'center 52%', mobilePosition: '67% center', width: 2400, height: 1600 },
  { src: '/images/portal/design-workshop.jpg', label: '共同制作', position: 'center 48%', mobilePosition: '65% center', width: 1400, height: 1071 },
] as const;

function Chevron({ previous = false }: { previous?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={previous ? 'm14 6-6 6 6 6' : 'm10 6 6 6-6 6'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function HeroSlideshow() {
  const root = useRef<HTMLElement>(null);
  const rotationIntent = useRef<boolean | null>(null);
  const [active, setActive] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(preference.matches);
    setAutoPlay(!preference.matches);
    const motionChanged = () => {
      setReducedMotion(preference.matches);
      if (preference.matches) setAutoPlay(false);
    };
    const visibilityChanged = () => setPageVisible(!document.hidden);
    visibilityChanged();
    preference.addEventListener('change', motionChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.15 });
    if (root.current) observer.observe(root.current);
    return () => {
      preference.removeEventListener('change', motionChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!autoPlay || reducedMotion || !inView || !pageVisible) return;
    const timer = window.setInterval(() => setActive(current => (current + 1) % photos.length), 7000);
    return () => window.clearInterval(timer);
  }, [autoPlay, reducedMotion, inView, pageVisible]);

  function move(direction: number) {
    setAutoPlay(false);
    setActive(current => (current + direction + photos.length) % photos.length);
  }

  return <section ref={root} className={styles.hero} aria-labelledby="home-title" aria-roledescription="照片轮播" onFocusCapture={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setAutoPlay(false);
  }}>
    <div id="hero-photos" className={styles.photos} aria-hidden="true">
      {photos.map((photo, index) => <img key={photo.src} className={styles.photo} data-active={active === index} src={photo.src} alt="" width={photo.width} height={photo.height} fetchPriority={index === 0 ? 'high' : 'low'} style={{ '--photo-position': photo.position, '--mobile-position': photo.mobilePosition } as CSSProperties}/>)}
    </div>
    <div className={styles.scrim} aria-hidden="true"/>
    <div className={styles.content}>
      <p className={styles.identity}>中国科学技术大学 · 设计创新</p>
      <h1 id="home-title"><span>让更多人，</span><span><span className={styles.phrase}>拥有塑造未来</span><span className={styles.phrase}>的能力。</span></span></h1>
    </div>
    <div className={styles.footer}>
      <p className={styles.caption} aria-live={autoPlay ? 'off' : 'polite'} aria-atomic="true"><span>{photos[active].label}</span><span>学习场景示意</span><span className="sr-only">，第 {active + 1} 张，共 {photos.length} 张照片</span></p>
      <div className={styles.controls} role="group" aria-label="首页照片控制">
        <span className={styles.count} aria-hidden="true">{String(active + 1).padStart(2, '0')}<span> / {String(photos.length).padStart(2, '0')}</span></span>
        <button type="button" aria-label="上一张首页照片" aria-controls="hero-photos" onClick={() => move(-1)}><Chevron previous/></button>
        <button type="button" aria-label="下一张首页照片" aria-controls="hero-photos" onClick={() => move(1)}><Chevron/></button>
        {!reducedMotion && <button type="button" aria-label={autoPlay ? '暂停照片轮播' : '播放照片轮播'} aria-controls="hero-photos" onPointerDown={() => { rotationIntent.current = !autoPlay; }} onPointerCancel={() => { rotationIntent.current = null; }} onBlur={() => { rotationIntent.current = null; }} onClick={() => {
          // Pointer intent precedes focus-induced pausing; keyboard activation uses current state.
          setAutoPlay(rotationIntent.current ?? !autoPlay);
          rotationIntent.current = null;
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{autoPlay ? <path d="M7 5h3v14H7zm7 0h3v14h-3z"/> : <path d="m8 5 11 7-11 7z"/>}</svg>
        </button>}
      </div>
    </div>
  </section>;
}
