import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCourseManager } from '@/lib/access';
import { db } from '@/lib/db';
import { createOfferingAction } from '@/lib/actions';
import { displayDate } from '@/lib/policy';
import { PageShell } from '@/components/site-shell';
import { ActionForm } from '@/components/action-form';

export default async function NewOfferingPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const { user, course } = await requireCourseManager(courseId);
  if (course.slug === 'design-thinking' || course.slug === 'design-practice') {
    redirect(`/manage/courses/new?preset=${course.slug === 'design-thinking' ? 'thinking' : 'practice'}`);
  }
  const terms = await db.term.findMany({ orderBy: { startDate: 'desc' }, include: { offerings: { where: { courseId }, select: { id: true } } } });
  return <PageShell currentUser={user} context="workspace"><div className="container section stack"><Link className="breadcrumb" href="/workspace">← 返回工作台</Link><header className="page-heading"><p className="muted">{course.title}</p><h1>开设新学期</h1></header><section className="panel"><p className="field-help">新学期以筹备状态创建，课程负责人自动加入。学生、小组与助教分工需重新安排。</p><ActionForm action={createOfferingAction.bind(null, courseId)} submitLabel="创建本期开课"><div className="form-field"><label htmlFor="term-id">选择已有学期</label><select id="term-id" name="termId" defaultValue=""><option value="">创建新学期（填写下方信息）</option>{terms.map(term => <option value={term.id} key={term.id} disabled={!!term.offerings.length}>{term.name} · {displayDate(term.startDate)}{term.offerings.length ? '（本课程已开设）' : ''}</option>)}</select><p className="field-help">选择已有学期时，无需填写下方学期名称和日期。</p></div><fieldset className="stack" style={{ border: '1px solid var(--line)', padding: 20 }}><legend>新学期信息</legend><div className="form-field"><label htmlFor="term-name">学期名称</label><input id="term-name" name="termName" maxLength={100} placeholder="例如：2027 春"/></div><div className="form-grid"><div className="form-field"><label htmlFor="start-date">开始日期</label><input id="start-date" type="date" name="startDate"/></div><div className="form-field"><label htmlFor="end-date">结束日期</label><input id="end-date" type="date" name="endDate"/></div></div></fieldset><div className="form-field"><label htmlFor="description">本期开课介绍</label><textarea id="description" name="description" maxLength={2000} rows={5} defaultValue={course.description}/></div></ActionForm></section></div></PageShell>;
}
