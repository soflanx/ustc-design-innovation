import { showcaseReadHref, type ShowcaseListing, type ShowcaseMaterial, type ShowcaseScope, type ShowcaseStory } from '@/lib/group-showcase-contract';
import styles from './group-showcase-story.module.css';

export function GroupShowcaseListing({ offeringId, scope, showcases }: {
  offeringId: string;
  scope: ShowcaseScope;
  showcases: ShowcaseListing[];
}) {
  if (!showcases.length) return null;
  return <section id="group-showcases" className={styles.listing} aria-labelledby="group-showcases-title">
    <h2 id="group-showcases-title">小组展示</h2>
    <ul>{showcases.map(showcase => <li key={showcase.groupId}>
      <a className={styles.listLink} href={showcaseReadHref(offeringId, showcase.groupId, scope)}>
        <div>
          <h3>{showcase.title}</h3>
          {showcase.summary && <p>{showcase.summary}</p>}
        </div>
        <span>{showcase.groupName}</span>
      </a>
    </li>)}</ul>
  </section>;
}

export function GroupShowcaseStory({ story, courseTitle, termName, materialHref }: {
  story: ShowcaseStory;
  courseTitle: string;
  termName: string;
  materialHref: (material: ShowcaseMaterial) => string | undefined;
}) {
  const views = story.materials.map(material => ({ material, href: materialHref(material) }));
  const cover = views.find(({ material, href }) => material.file?.image && href);
  const paragraphs = story.body.split(/\r?\n\s*\r?\n/u).filter(paragraph => paragraph.trim());
  return <article className={styles.story}>
    <header className={styles.header}>
      <h1>{story.title}</h1>
      {story.summary && <p className={styles.summary}>{story.summary}</p>}
      <p className={styles.byline}>{story.groupName} · {courseTitle} · {termName}</p>
    </header>
    {cover?.href && <figure className={styles.cover}>
      <img src={cover.href} alt={cover.material.caption || cover.material.file?.name || ''} referrerPolicy="no-referrer"/>
    </figure>}
    {paragraphs.length > 0 && <div className={styles.body}>
      {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    </div>}
    {views.length > 0 && <section className={styles.materials}>
      <h2>项目材料</h2>
      <ul>{views.map(({ material, href }) => <li key={material.id}>
        {material.caption && <p className={styles.caption}>{material.caption}</p>}
        <p className={styles.source}>{material.sourceLabel}</p>
        {material.text && <p className={styles.materialText}>{material.text}</p>}
        {href && material.file && <>
          {material.file.image && material.id !== cover?.material.id && <img
            className={styles.materialImage} src={href} alt={material.caption || material.file.name}
            loading="lazy" referrerPolicy="no-referrer"/>}
          <a className={styles.file} href={href} target="_blank" rel="noreferrer">{material.file.name}</a>
        </>}
      </li>)}</ul>
    </section>}
  </article>;
}
