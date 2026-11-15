import Link from 'next/link';
import { PageShell } from '@/components/site-shell';
import { PortalImage } from '@/components/portal-image';
import { getCurrentUser } from '@/lib/auth';
import { getPublicCourses } from '@/lib/queries';
import { listPublicShowcaseProjects } from '@/lib/group-showcase';
import { showcaseReadHref } from '@/lib/group-showcase-contract';
import { getCourseImage, getHomeImage } from '@/lib/editorial-images';
import { courseKinds } from '@/lib/home-courses';
import { partners, teachingTeam } from '@/lib/home-people';
import styles from './portal-home.module.css';

export const dynamic = 'force-dynamic';

const HOME_PROJECTS = 6;

export default async function HomePage() {
  const [user, courses, projects] = await Promise.all([getCurrentUser(), getPublicCourses(), listPublicShowcaseProjects(HOME_PROJECTS)]);

  return <PageShell currentUser={user}>
    <section className={styles.hero} aria-labelledby="home-title">
      <h1 id="home-title"><span>让更多人，</span><span><span className={styles.phrase}>拥有塑造未来</span><span className={styles.phrase}>的能力。</span></span></h1>
      <p className={styles.lead}>中国科学技术大学的设计创新课程。理实交融，从一个真实的问题做到一个可以检验的原型。</p>
      <PortalImage image={getHomeImage()} ratio="21 / 9" priority/>
    </section>

    <section className={styles.block} aria-labelledby="courses-title">
      <h2 id="courses-title">两门课</h2>
      <div className={styles.courses}>
        {courseKinds.map(kind => {
          const offerings = courses.find(course => course.slug === kind.slug)?.offerings ?? [];
          // The running term first; otherwise the most recent public one.
          const offering = offerings.find(item => item.status === 'ACTIVE') ?? offerings[0];
          const body = <>
            <PortalImage image={getCourseImage(kind.slug)} ratio="3 / 2"/>
            <h3>{kind.title}{kind.parts && <span>{kind.parts}</span>}</h3>
            <p>{kind.position}</p>
            <p className={styles.courseTerm}>{offering ? <>{offering.term.name}<span aria-hidden="true"> →</span></> : '本期暂未开课'}</p>
          </>;
          return offering
            ? <Link className={styles.course} href={`/courses/${offering.id}`} key={kind.slug}>{body}</Link>
            : <div className={styles.course} key={kind.slug}>{body}</div>;
        })}
      </div>
    </section>

    <section className={`${styles.block} ${styles.band}`} aria-labelledby="projects-title">
      <div className={styles.blockHead}>
        <h2 id="projects-title">课程项目</h2>
        <Link href="/projects">全部项目<span aria-hidden="true"> →</span></Link>
      </div>
      {projects.length > 0 && <ul className={styles.projects}>
        {projects.map(project => <li key={project.groupId}>
          <Link href={`${showcaseReadHref(project.offeringId, project.groupId, 'PUBLIC')}?from=home`} prefetch={false}>
            <PortalImage image={project.cover ?? undefined} ratio="4 / 3"/>
            <h3>{project.title}</h3>
            <p>{project.term.name}</p>
          </Link>
        </li>)}
      </ul>}
    </section>

    <section className={styles.block} aria-labelledby="partners-title">
      <h2 id="partners-title">{teachingTeam.length ? '合作与团队' : '合作'}</h2>
      <ul className={styles.partners}>
        {partners.map(partner => <li key={partner.name}><a href={partner.href} target="_blank" rel="noreferrer">{partner.name}</a></li>)}
      </ul>
      {teachingTeam.length > 0 && <ul className={styles.team}>
        {teachingTeam.map(member => <li key={member.name}>
          <span>{member.href ? <a href={member.href} target="_blank" rel="noreferrer">{member.name}</a> : member.name}</span>
          <span>{member.role}</span>
        </li>)}
      </ul>}
      <p className={styles.note}>合作信息为样稿，以教学团队的正式材料为准。</p>
    </section>
  </PageShell>;
}
