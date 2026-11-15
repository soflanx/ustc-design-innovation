import Link from 'next/link';
import { PageShell } from '@/components/site-shell';
import { PortalImage } from '@/components/portal-image';
import { getCurrentUser } from '@/lib/auth';
import { getLegacyPublicProjects } from '@/lib/queries';
import { listPublicShowcaseProjects } from '@/lib/group-showcase';
import { showcaseReadHref } from '@/lib/group-showcase-contract';
import { getPostImage } from '@/lib/editorial-images';
import styles from './projects.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: '项目', description: '按学期查阅设计创新课程已公开的项目。' };

type Project = Awaited<ReturnType<typeof listPublicShowcaseProjects>>[number];

export default async function ProjectsPage() {
  const [user, projects, articles] = await Promise.all([getCurrentUser(), listPublicShowcaseProjects(), getLegacyPublicProjects()]);
  const terms = new Map<string, { term: Project['term']; projects: Project[] }>();
  for (const project of projects) {
    const section = terms.get(project.term.id);
    if (section) section.projects.push(project);
    else terms.set(project.term.id, { term: project.term, projects: [project] });
  }
  const sections = [...terms.values()].sort((a, b) => b.term.startDate.getTime() - a.term.startDate.getTime() || a.term.id.localeCompare(b.term.id));

  return <PageShell currentUser={user}><div className={`container ${styles.page}`}>
    <h1>项目</h1>
    {!projects.length && !articles.length && <p className="empty-state">暂无已公开的项目。</p>}
    {sections.map(({ term, projects }) => <section className={styles.group} key={term.id} aria-labelledby={`term-${term.id}`}>
      <h2 id={`term-${term.id}`}>{term.name}</h2>
      <ul className={styles.grid}>
        {projects.map(project => <li key={project.groupId}>
          <Link href={`${showcaseReadHref(project.offeringId, project.groupId, 'PUBLIC')}?from=projects`} prefetch={false}>
            <PortalImage image={project.cover ?? undefined} ratio="4 / 3"/>
            <h3>{project.title}</h3>
            {project.summary && <p>{project.summary}</p>}
          </Link>
        </li>)}
      </ul>
    </section>)}
    {articles.length > 0 && <section className={styles.group} aria-labelledby="project-articles">
      <h2 id="project-articles">过往项目文章</h2>
      <ul className={styles.grid}>
        {articles.map(article => <li key={article.slug}>
          <Link href={`/news/${encodeURIComponent(article.slug)}`}>
            <PortalImage image={getPostImage(article.slug)} ratio="4 / 3"/>
            <h3>{article.title}</h3>
            {article.excerpt && <p>{article.excerpt}</p>}
          </Link>
        </li>)}
      </ul>
    </section>}
  </div></PageShell>;
}
