import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
async function main() {
  const users = [
    ['demo-teacher', '演示教师（虚构）'], ['demo-ta', '演示助教（虚构）'],
    ['demo-student-a', '演示学生 A（虚构）'], ['demo-student-b', '演示学生 B（虚构）'],
    ['demo-admin', '演示管理员（虚构）'],
  ];
  for (const [id, name] of users) await prisma.user.upsert({where:{id},update:{},create:{id,name,email:`${id}@example.invalid`,isDemo:true,isAdmin:id==='demo-admin'}});
  await prisma.course.upsert({where:{id:'course-thinking'},update:{},create:{id:'course-thinking',slug:'design-thinking',title:'设计创新思维',description:'以真实问题为起点，探索设计研究与创新实践。所有演示人物与项目均为虚构。'}});
  await prisma.courseStaff.upsert({where:{courseId_userId:{courseId:'course-thinking',userId:'demo-teacher'}},update:{},create:{courseId:'course-thinking',userId:'demo-teacher',role:'TEACHER'}});
  for (const year of [2026,2025]) {
    const current=year===2026; const termId=`term-${year}-autumn`; const offeringId=`offering-thinking-${year}-autumn`;
    await prisma.term.upsert({where:{id:termId},update:{},create:{id:termId,slug:`${year}-autumn`,name:`${year} 年秋季学期`,status:current?'ACTIVE':'ARCHIVED',startDate:new Date(`${year}-09-01T00:00:00+08:00`),endDate:new Date(`${year+1}-01-20T00:00:00+08:00`)}});
    await prisma.courseOffering.upsert({where:{id:offeringId},update:{},create:{id:offeringId,courseId:'course-thinking',termId,title:`设计创新思维 · ${year} 秋季`,description:current?'从观察到洞察，从想法到原型。':'往期课程档案（虚构演示数据）。',status:current?'ACTIVE':'ARCHIVED'}});
    for (const [userId,role] of [['demo-teacher','TEACHER'],['demo-ta','TA'],['demo-student-a','STUDENT'],['demo-student-b','STUDENT']] as const) await prisma.courseMember.upsert({where:{offeringId_userId:{offeringId,userId}},update:{},create:{id:`${offeringId}-${userId}`,offeringId,userId,role}});
  }
  const offeringId='offering-thinking-2026-autumn';
  for (const suffix of ['a','b']) {
    const groupId=`group-${suffix}`; const courseMemberId=`${offeringId}-demo-student-${suffix}`;
    await prisma.group.upsert({where:{id:groupId},update:{},create:{id:groupId,offeringId,name:suffix==='a'?'第一组 · 观察者':'第二组 · 探索者',description:'虚构演示小组'}});
    // Preserve existing joins/exits and never silently move a student on rerun.
    if (!await prisma.groupMember.findFirst({where:{offeringId,courseMemberId}})) await prisma.groupMember.create({data:{id:`membership-${suffix}`,offeringId,groupId,courseMemberId}});
  }
  const taId=`${offeringId}-demo-ta`;
  if (!await prisma.taGroupAssignment.findFirst({where:{groupId:'group-a',courseMemberId:taId}})) await prisma.taGroupAssignment.create({data:{id:'ta-assignment-a',offeringId,groupId:'group-a',courseMemberId:taId}});
  await prisma.resource.upsert({
    where: { id: 'demo-resource-observation' }, update: {},
    create: {
      id: 'demo-resource-observation', offeringId, title: '观察记录与访谈提纲（演示）',
      body: '这是一份虚构课程的演示资料。\n\n观察记录\n记录发生的时间、地点和行为，把看到的事实与自己的解释分开。\n\n访谈提纲\n1. 请描述一次最近遇到的问题。\n2. 当时你采取了什么办法？\n3. 哪一步最费力？\n\n提交时请隐去受访者的真实姓名与联系方式。',
      status: 'PUBLISHED', visibility: 'OFFERING',
    },
  });
  for (const assignment of [
    { id: 'demo-assignment-observation', title: '日常观察记录（演示）', mode: 'INDIVIDUAL' as const, description: '这是一项虚构演示作业。\n\n选择校园生活中的一个场景，记录三条可观察的事实，并提出一个值得进一步了解的问题。请在正文中说明观察场景、记录和问题。' },
    { id: 'demo-assignment-prototype', title: '校园导览：问题定义与原型（演示）', mode: 'GROUP' as const, description: '这是一项虚构演示作业，由小组内一人代表全组提交。\n\n结合观察与访谈，写清目标使用者、遇到的问题和关键证据；描述一个低成本原型，以及下一步如何验证。请在正文中列出本次分工。' },
  ]) await prisma.assignment.upsert({
    where: { id: assignment.id }, update: {},
    create: { ...assignment, offeringId, status: 'PUBLISHED' },
  });
  const posts = [
    {id:'news-2026-welcome',slug:'2026-autumn-welcome',title:'2026 秋季设计创新课程开启',excerpt:'从身边的问题出发，开始一段设计探索。',body:'这是虚构演示新闻：本学期我们将通过观察、访谈与原型实践，共同探索创新的可能。',type:'NEWS' as const,date:'2026-10-12'},
    {id:'news-2026-workshop',slug:'2026-observation-workshop',title:'观察与洞察工作坊',excerpt:'走入生活现场，记录值得解决的小问题。',body:'这是虚构演示新闻：工作坊围绕观察记录与问题定义展开，帮助同学们将日常发现转化为设计机会。',type:'NEWS' as const,date:'2026-10-16'},
    {id:'project-campus-wayfinding',slug:'campus-wayfinding-demo',title:'让校园路径更友好',excerpt:'通过信息设计，探索更清晰的校园导览体验。',body:'这是虚构演示成果：小组从新生的寻路体验出发，提出校园导览原型，用设计回应日常需求。',type:'PROJECT' as const,date:'2026-10-17'},
  ];
  for (const {date,...post} of posts) await prisma.post.upsert({where:{id:post.id},update:{},create:{...post,offeringId,authorId:'demo-teacher',status:'PUBLISHED',visibility:'PUBLIC',publishedAt:new Date(`${date}T10:00:00+08:00`)}});
}
main().finally(()=>prisma.$disconnect());
