import Link from 'next/link';
import { PageShell } from '@/components/site-shell';
import { getCurrentUser } from '@/lib/auth';
import { getPublicCourses, getPublicCourseNews } from '@/lib/queries';
import { displayDate } from '@/lib/policy';
import { getCourseImage, getPostImage } from '@/lib/editorial-images';
import { newsFeatures, studentStories, type EditorialRecord } from '@/lib/home-editorial';
import { NewsCarousel } from '@/components/news-carousel';
import styles from './portal-home.module.css';

export const dynamic = 'force-dynamic';

function Arrow() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function StoryPreview({ story, featured = false }: { story: EditorialRecord; featured?: boolean }) {
  return <article className={featured ? styles.storyFeature : styles.storyBrief}>
    <Link className={styles.studentStoryLink} href={`/stories/${story.slug}`} aria-labelledby={`home-story-${story.slug}`}>
      {story.image && <div className={styles.storyPhoto}><img src={story.image.src} alt={story.image.alt} style={{ objectPosition: story.imagePosition }} width={story.image.width} height={story.image.height} loading="lazy"/></div>}
      <div className={styles.storyCopy}>
        <p className={styles.storyCategory}>{story.category}</p>
        <h3 id={`home-story-${story.slug}`}>{story.title.split('，').map((part, index, parts) => <span className={styles.storyTitlePhrase} key={index}>{part}{index < parts.length - 1 ? '，' : ''}</span>)}</h3>
        <p className={styles.storyExcerpt}>{story.excerpt}</p>
        <span className={styles.storyRead}>阅读故事<Arrow/></span>
      </div>
    </Link>
  </article>;
}

export default async function HomePage() {
  const [user, courses] = await Promise.all([getCurrentUser(), getPublicCourses()]);
  const featuredCourse = courses.find(course => course.slug === 'design-thinking') ?? courses.find(course => course.offerings.some(offering => offering.status === 'ACTIVE')) ?? courses[0];
  const heroImage = featuredCourse ? getCourseImage(featuredCourse.slug) : undefined;
  const news = await getPublicCourseNews(featuredCourse?.id);
  const newsCards = [
    ...newsFeatures.map(post => ({ ...post, href: `/updates/${post.slug}`, date: null as string | null })),
    ...news.map(post => ({ slug: post.slug, category: '课堂动态', title: post.title, excerpt: post.excerpt, image: getPostImage(post.slug), href: `/news/${post.slug}`, date: post.publishedAt ? displayDate(post.publishedAt) : null })),
  ];

  return <PageShell currentUser={user} homeLayout>
    <section className={styles.hero} aria-labelledby="home-title">
      <div className={`container ${styles.heroContent}`}>
        <div className={styles.heroCopy}>
          <p className={styles.heroIdentity}>中国科学技术大学 · {featuredCourse?.title ?? '设计创新课程'}</p>
          <h1 id="home-title"><span>让更多人，</span><span><span className={styles.heroPhrase}>拥有塑造未来</span><span className={styles.heroPhrase}>的能力。</span></span></h1>
          <p className={styles.heroDescription}>我们相信，每个人的经验都可能成为创造的起点。我们希望通过国际交流与真实设计实践，学习理解不同的人，把对世界的关心变成共同创造的行动。</p>
          <a className={styles.heroButton} href="#news">看看这里正在发生什么<Arrow/></a>
        </div>
        {heroImage && <figure className={styles.heroFigure}><img className={styles.heroImage} src={heroImage.src} alt={heroImage.alt} width={heroImage.width} height={heroImage.height} fetchPriority="high"/><figcaption className={styles.heroCaption}>{heroImage.caption}</figcaption></figure>}
      </div>
    </section>

    <section id="partners" className={`container ${styles.partnersSection}`} aria-labelledby="partners-title">
      <h2 id="partners-title">我们的合作者与交流网络</h2>
      <p className={styles.partnersIntro}>让不同的视角相遇，让好的想法一起向前。</p>
      <div className={styles.partnerNames}>
        <a className={styles.stanfordName} href="https://www.stanford.edu/" target="_blank" rel="noreferrer" aria-label="Stanford University，打开官方网站">Stanford<span>University</span></a>
        <a className={styles.sugarName} href="https://sugar-network.org/" target="_blank" rel="noreferrer" aria-label="SUGAR Network，打开官方网站">SUGAR<span>Design Innovation Network</span></a>
        <a className={styles.aaltoName} href="https://designfactory.aalto.fi/" target="_blank" rel="noreferrer" aria-label="Aalto Design Factory，打开官方网站">Aalto<span>Design Factory</span></a>
        <a className={styles.tongjiName} href="https://tjdi.tongji.edu.cn/" target="_blank" rel="noreferrer" aria-label="同济大学设计创意学院，打开官方网站">同济大学<span>设计创意学院</span></a>
        <a className={styles.kyotoName} href="https://www.d-lab.kit.ac.jp/program-me310sugar/" target="_blank" rel="noreferrer" aria-label="Kyoto Institute of Technology，打开官方网站">KYOTO<span>Institute of Technology</span></a>
      </div>
      <div className={styles.partnersFootnote}><span>合作网络展示样稿</span><a href="https://sugar-network.org/network/" target="_blank" rel="noreferrer">认识 SUGAR 全球设计创新网络 ↗</a></div>
    </section>

    <section id="news" className={styles.newsSection} aria-labelledby="news-title">
      <NewsCarousel>
        {newsCards.map(post => <article className={styles.newsCard} key={post.slug}>
          <Link className={styles.newsCardLink} href={post.href}>
            <div className={`${styles.newsVisual} ${!post.image ? styles.newsPoster : ''}`}>
              {post.image ? <img src={post.image.src} alt={post.image.alt} width={post.image.width} height={post.image.height} loading="lazy"/> : <div className={styles.posterType} aria-hidden="true"><span>DESIGN<br/>INNOVATION</span><span>新的学期<br/>新的探索。</span></div>}
              <span className={styles.cardCategory}>{post.category}</span>
            </div>
            <div className={styles.newsCardBody}>
              <div className={styles.cardMeta}>{post.date ? <span>{post.date}</span> : <span>内容样稿</span>}</div>
              <h3>{post.title}</h3>
              <span className={styles.newsRead}><span className="sr-only">阅读这则动态</span><Arrow/></span>
            </div>
          </Link>
        </article>)}
      </NewsCarousel>
    </section>

    <section id="stories" className={styles.storiesSection} aria-labelledby="stories-title">
      <div className={styles.storiesLayout}>
        <div className={styles.storiesHeading}>
          <h2 id="stories-title"><span>学生与小组</span><span>的故事</span></h2>
          <Link className={styles.allStoriesLink} href="/stories">查看全部故事<Arrow/></Link>
        </div>
        <div className={styles.storiesReading}>
          {studentStories[0] && <StoryPreview story={studentStories[0]} featured/>}
          {studentStories[2] && <StoryPreview story={studentStories[2]}/>}
          <p className={styles.storyNote}>学生与小组记录为内容展示样稿，照片为场景示意。</p>
        </div>
        {studentStories[1]?.image && <Link className={styles.storyInvitation} href={`/stories/${studentStories[1].slug}`} aria-label={`阅读小组记录：${studentStories[1].title}`}>
          <div className={styles.invitationPhoto}><img src={studentStories[1].image.src} alt={studentStories[1].image.alt} width={studentStories[1].image.width} height={studentStories[1].image.height} loading="lazy"/><span><Arrow/></span></div>
          <span className={styles.invitationCaption}>小组记录 · 我们把分歧，做成了第一个原型</span>
        </Link>}
      </div>
    </section>

    {!!featuredCourse && !!featuredCourse.offerings.length && <section id="courses" className={`container ${styles.courseSection}`} aria-labelledby="course-title">
      <div className={styles.courseLayout}>
        <div className={styles.courseIntro}><h2 id="course-title">课程与学期</h2><Link className={styles.inlineLink} href="/courses">查看课程目录<Arrow/></Link></div>
        <div className={styles.courseContent}><h3>{featuredCourse.title}</h3>
          <div>{featuredCourse.offerings.slice(0, 3).map(offering => <Link className={styles.semester} href={`/courses/${offering.id}`} key={offering.id}>
            <div><span className={styles.semesterName}>{offering.term.name}</span><span className={styles.semesterDates}>{displayDate(offering.term.startDate)} — {displayDate(offering.term.endDate)}</span></div>
            <span className={styles.semesterState}>{offering.status === 'ACTIVE' ? '进行中' : '已归档'}</span><Arrow/>
          </Link>)}</div>
        </div>
      </div>
    </section>}
  </PageShell>;
}
