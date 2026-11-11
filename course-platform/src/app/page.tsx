import Link from 'next/link';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { getPublicCourses, getPublicCourseNews } from '@/lib/queries';
import { displayDate } from '@/lib/policy';
import { getPostImage } from '@/lib/editorial-images';
import { newsFeatures, stories, type EditorialRecord } from '@/lib/home-editorial';
import { NewsCardLink, NewsCarousel } from '@/components/news-carousel';
import { HeroSlideshow } from '@/components/hero-slideshow';
import { learningPaths } from '@/lib/home-learning';
import { offeringCourseTitle } from '@/lib/course-label';
import styles from './portal-home.module.css';

export const dynamic = 'force-dynamic';

function Arrow() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function StoryPreview({ story, featured = false }: { story: EditorialRecord; featured?: boolean }) {
  return <article className={featured ? styles.storyFeature : styles.storyBrief}>
    <Link className={styles.storyLink} href={`/stories/${story.slug}`} aria-labelledby={`home-story-${story.slug}`}>
      <div className={styles.storyCopy}>
        <p className={styles.storyCategory}>{story.category}{featured && <span>{story.kicker}</span>}</p>
        <h3 id={`home-story-${story.slug}`}>{featured ? story.title.split('，').map((phrase, index, phrases) => <span key={index}>{phrase}{index < phrases.length - 1 ? '，' : ''}</span>) : story.title}</h3>
        {featured && <p className={styles.storyExcerpt}>{story.excerpt}</p>}
      </div>
      {story.image && <div className={styles.storyPhoto}><img src={story.image.src} alt={story.image.alt} style={{ objectPosition: story.imagePosition }} width={story.image.width} height={story.image.height} loading="lazy"/></div>}
      <span className={styles.storyRead}>{featured ? '读这段经历' : <span className="sr-only">阅读故事</span>}<Arrow/></span>
    </Link>
  </article>;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ news?: string | string[] }> }) {
  const [user, courses, { news: readArticle }] = await Promise.all([getCurrentUser(), getPublicCourses(), searchParams]);
  const homeOfferings = courses.flatMap(course => {
    const current = course.offerings.filter(offering => offering.status === 'ACTIVE');
    const selected = current.length ? current : course.offerings.slice(0, 1);
    return selected.map(offering => ({ ...offering, course }));
  }).sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || b.term.startDate.getTime() - a.term.startDate.getTime());
  const displayedCourseIds = [...new Set(homeOfferings.map(offering => offering.courseId))];
  const news = await getPublicCourseNews(displayedCourseIds);
  const newsCards = [
    ...news.map(post => ({ slug: post.slug, category: '课程新闻', title: post.title, image: getPostImage(post.slug), href: `/news/${post.slug}`, date: post.publishedAt ? displayDate(post.publishedAt) : null })),
    ...newsFeatures.map(post => ({ ...post, href: `/updates/${post.slug}`, date: null as string | null })),
  ];
  const returnIndex = readArticle === undefined ? undefined : newsCards.findIndex(card => card.href === readArticle);

  return <PageShell currentUser={user} homeLayout>
    <HeroSlideshow/>

    <section id="learning" className={styles.learningSection} aria-labelledby="learning-title">
      <h2 id="learning-title" className="sr-only">我们的学习方式：交流、实践、合作</h2>
      <div className={styles.learningChapters}>
        {learningPaths.map(path => <article id={`learning-${path.id}`} className={styles.learningPath} key={path.id} aria-labelledby={`learning-${path.id}-title`}>
          <div className={styles.learningLead}>
            <h3 id={`learning-${path.id}-title`}>{path.title}</h3>
          </div>
          <div className={styles.learningPhoto}><img src={path.image.src} alt={path.image.alt} width={path.image.width} height={path.image.height} loading="lazy"/></div>
          <p className={styles.learningIntroduction}>{path.description}</p>
          <div className={styles.learningTopics}>
            {path.topics.map(topic => <div className={styles.learningTopic} key={topic.title}>
              <h4>{topic.title}</h4>
              <p>{topic.description}</p>
              {topic.link && <Link className={styles.learningRead} href={topic.link.href}>{topic.link.label}<Arrow/></Link>}
            </div>)}
          </div>
        </article>)}
      </div>
      <p className={styles.learningNote}>图片为学习场景示意。</p>
    </section>

    <section id="partners" className={styles.partnersSection} aria-labelledby="partners-title">
      <div className={styles.partnersHeading}>
        <h2 id="partners-title">合作与交流</h2>
        <a href="https://sugar-network.org/network/" target="_blank" rel="noreferrer">SUGAR 全球网络 ↗</a>
      </div>
      <div className={styles.partnerNames}>
        <a className={styles.stanfordName} href="https://www.stanford.edu/" target="_blank" rel="noreferrer" aria-label="Stanford University，打开官方网站">Stanford<span>University</span></a>
        <a className={styles.sugarName} href="https://sugar-network.org/" target="_blank" rel="noreferrer" aria-label="SUGAR Network，打开官方网站">SUGAR<span>Design Innovation Network</span></a>
        <a className={styles.aaltoName} href="https://designfactory.aalto.fi/" target="_blank" rel="noreferrer" aria-label="Aalto Design Factory，打开官方网站">Aalto<span>Design Factory</span></a>
        <a className={styles.tongjiName} href="https://tjdi.tongji.edu.cn/" target="_blank" rel="noreferrer" aria-label="同济大学设计创意学院，打开官方网站">同济大学<span>设计创意学院</span></a>
        <a className={styles.kyotoName} href="https://www.d-lab.kit.ac.jp/program-me310sugar/" target="_blank" rel="noreferrer" aria-label="Kyoto Institute of Technology，打开官方网站">KYOTO<span>Institute of Technology</span></a>
      </div>
      <p className={styles.partnersFootnote}>合作网络展示样稿</p>
    </section>

    <section id="news" className={styles.newsSection} aria-labelledby="news-title">
      {newsCards.length ? <NewsCarousel returnIndex={returnIndex}>
        {newsCards.map(post => <article className={styles.newsCard} key={post.href}>
          <NewsCardLink href={post.href}>
            <div className={`${styles.newsVisual} ${!post.image ? styles.newsPoster : ''}`}>
              {post.image ? <img src={post.image.src} alt={post.image.alt} width={post.image.width} height={post.image.height} loading="lazy"/> : <div className={styles.posterType} aria-hidden="true"><span>DESIGN<br/>INNOVATION</span><span>新的学期<br/>新的探索。</span></div>}
              <span className={styles.cardCategory}>{post.category}</span>
            </div>
            <div className={styles.newsCardBody}>
              {post.date && <div className={styles.cardMeta}><span>{post.date}</span></div>}
              <h3>{post.title}</h3>
              <span className={styles.newsRead}><span className="sr-only">阅读新闻</span><Arrow/></span>
            </div>
          </NewsCardLink>
        </article>)}
      </NewsCarousel> : <><div className={styles.newsHeading}><h2 id="news-title">新闻</h2></div><p className="empty-state">暂无已发布新闻。</p></>}
    </section>

    <section id="stories" className={styles.storiesSection} aria-labelledby="stories-title">
      <div className={styles.storiesLayout}>
        <div className={styles.storiesHeading}>
          <h2 id="stories-title">故事</h2>
          <p className={styles.storiesIntroduction}>记录课程中的人物经历、项目过程与设计思考。</p>
          {stories.length > 0 && <Link className={styles.allStoriesLink} href="/stories">查看全部故事<Arrow/></Link>}
        </div>
        <div className={styles.storiesReading}>
          {stories[1] && <StoryPreview story={stories[1]} featured/>}
          <div className={styles.moreStories}>
            {stories[0] && <StoryPreview story={stories[0]}/>}
            {stories[2] && <StoryPreview story={stories[2]}/>}
          </div>
          {!stories.length && <p className="empty-state">暂无已发布故事。</p>}
        </div>
      </div>
    </section>

    {homeOfferings.length > 0 && <section id="courses" className={`container ${styles.courseSection}`} aria-labelledby="course-title">
      <div className={styles.courseLayout}>
        <div className={styles.courseIntro}><h2 id="course-title">课程与学期</h2><Link className={styles.inlineLink} href="/courses">查看课程目录<Arrow/></Link></div>
        <div className={styles.courseContent}>
          {homeOfferings.map(offering => <Link className={styles.semester} href={`/courses/${offering.id}`} key={offering.id}>
            <div>
              <h3 className={styles.semesterName}>{offeringCourseTitle(offering)}</h3>
              <p className={styles.semesterDates}><span>{offering.term.name}</span><span>{displayDate(offering.term.startDate)} — {displayDate(offering.term.endDate)}</span></p>
            </div>
            <span className={styles.semesterState}>{offering.status === 'ACTIVE' ? '进行中' : '已归档'}</span><Arrow/>
          </Link>)}
        </div>
      </div>
    </section>}
  </PageShell>;
}
