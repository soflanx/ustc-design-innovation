export type EditorialRecord = {
  slug: string;
  category: string;
  kicker: string;
  title: string;
  excerpt: string;
  image?: { src: string; alt: string; caption: string; width: number; height: number };
  imagePosition?: string;
  sections: readonly { title: string; body: string }[];
  takeaway: string;
};

const workshopImage = {
  src: '/images/portal/design-workshop.jpg',
  alt: '围绕工作台进行创作的参与者',
  caption: '工作坊场景示意 · Gu Ko / Pexels',
  width: 1400,
  height: 1071,
};

const modelImage = {
  src: '/images/portal/architectural-model.jpg',
  alt: '桌面上用于讨论空间关系的建筑模型',
  caption: '模型场景示意 · Tima Miroshnichenko / Pexels',
  width: 1600,
  height: 1067,
};

const discussionImage = {
  src: '/images/portal/student-discussion.jpg',
  alt: '三名学生围绕桌面笔记展开讨论',
  caption: '小组讨论场景示意 · Andy Barbour / Pexels',
  width: 1600,
  height: 1067,
};

const presentationImage = {
  src: '/images/portal/student-presentation.jpg',
  alt: '学生在图书馆向老师和同伴分享想法',
  caption: '分享汇报场景示意 · Kampus Production / Pexels',
  width: 1600,
  height: 1067,
};

const campusImage = {
  src: '/images/portal/campus-conversation.jpg',
  alt: '两名学生在校园走廊中边走边交流',
  caption: '校园交流场景示意 · Zen Chung / Pexels',
  width: 1600,
  height: 790,
};

// These anonymous editorial samples are separate from published course records.
export const newsFeatures: readonly EditorialRecord[] = [
  {
    slug: 'different-perspectives',
    category: '国际交流',
    kicker: '让世界走进讨论',
    title: '在不同的语境里，重新理解同一个问题',
    excerpt: '带着各自的生活经验相遇，在一次共同讨论中，发现问题还有另一种看法。',
    image: discussionImage,
    sections: [
      { title: '从一段日常经验开始', body: '讨论从一个简单的问题展开：初次来到一座陌生的校园，我们怎样找到方向？有人想到地图，有人先寻找可以提问的人，也有人更在意自己是否读得懂路牌。看似相同的情境，因为各自的经历，出现了不同的起点。' },
      { title: '把不同理解放到同一张纸上', body: '参与者用草图说明自己的判断，再由伙伴复述听到的需求。交流的重点渐渐从“哪一个方案更好”，转向“我们还没有理解谁”。语言、环境和习惯的差异，成为重新定义问题的线索。' },
      { title: '带走一个新的问题', body: '分享结束时，每个人留下一个仍然想追问的问题。下一次讨论可以从这些问题继续：把不同的视角放进具体情境，让交流与设计尝试彼此推动。' },
    ],
    takeaway: '交流的价值，也在于让熟悉的问题重新变得值得好奇。',
  },
  {
    slug: 'work-in-progress',
    category: '阶段汇报',
    kicker: '把过程带到大家面前',
    title: '分享的不只是答案，还有一路上的尝试',
    excerpt: '从第一张草图到可以体验的原型，让每一次选择、修改与未解的问题都有机会被看见。',
    image: presentationImage,
    sections: [
      { title: '让过程成为展示的一部分', body: '汇报桌上并排摆着最初的草图、被放弃的方案和新一版原型。小组先讲述观察到了什么，再解释为什么作出眼前的选择。那些没有走通的路径，同样帮助听众理解设计是怎样一步步变化的。' },
      { title: '把反馈变成下一步的线索', body: '听众可以走近原型，试着使用，再提出具体的问题。讨论围绕使用情境、容易误解的地方和还没有被验证的假设展开。小组记录分歧，也记录哪些反馈需要回到现场进一步了解。' },
      { title: '用一个行动接续汇报', body: '结束时，每个小组选择最值得继续验证的一件事：补充一次观察、调整一个交互，或者邀请新的使用者体验。汇报因此成为下一轮尝试的起点。' },
    ],
    takeaway: '一个还在生长的想法，也值得被认真地分享。',
  },
];

export const studentStories: readonly EditorialRecord[] = [
  {
    slug: 'learning-to-notice',
    category: '学生手记',
    kicker: '个人观察 · 从问题出发',
    title: '走出熟悉的答案，学会重新提问',
    excerpt: '一次从校园日常开始的观察，让“我想做什么”慢慢变成“他们真正需要什么”。',
    image: campusImage,
    imagePosition: 'center',
    sections: [
      { title: '最初，我已经有了一个方案', body: '拿到开放的设计题目后，第一反应是把自己熟悉的技术用进去。功能清单很快写满了一页，可真正走到使用场景里，却发现人们的困扰与设想不太一样：他们需要的，也许只是一个及时而清楚的提示。' },
      { title: '先让观察改变自己的判断', body: '于是，笔记里开始多出一些细小的记录：人在哪一步停下来，会先看向哪里，又会怎样向身边的人求助。访谈也不再急着介绍方案，而是请对方讲一段真实的经历。问题的边界在这些细节中逐渐清楚。' },
      { title: '一个更小、也更具体的开始', body: '新的尝试没有追求更多功能，而是先回应一个具体的需要。回头看，收获不只是做出了什么，更是愿意暂时放下答案，让一个陌生人的经验进入自己的思考。' },
    ],
    takeaway: '开始设计之前，先给自己一点时间，认真看见一个人。',
  },
  {
    slug: 'making-together',
    category: '小组记录',
    kicker: '跨学科协作 · 共同制作',
    title: '我们把分歧，做成了第一个原型',
    excerpt: '当每个人都从不同的地方出发，动手做一个看得见的东西，成了继续讨论的方式。',
    image: workshopImage,
    sections: [
      { title: '同一个词，原来有不同的意思', body: '小组第一次讨论时，每个人都赞同“让使用更方便”，却描绘出很不一样的方案。有人关注步骤，有人关心感受，也有人先计算实现成本。讨论很热烈，却很难决定从哪里开始。' },
      { title: '先做出来，再一起看', body: '大家决定各自用纸和胶带做出最关键的一步。粗糙的模型让隐藏在语言里的分歧变得具体：手要放在哪里、信息怎样出现、下一步是否容易理解。成员轮流扮演使用者，开始对同一个东西提出意见。' },
      { title: '留下选择背后的理由', body: '合并方案时，小组没有只保留最后的成品，也把每次修改的理由记在旁边。新的成员能顺着这些记录接上讨论，原先不同的知识与习惯，也逐渐成为共同设计的资源。' },
    ],
    takeaway: '合作有时从一个很小的动作开始：把自己的想法放到大家眼前。',
  },
  {
    slug: 'first-user-test',
    category: '实践笔记',
    kicker: '原型测试 · 在反馈中调整',
    title: '第一次，把想法交给陌生人使用',
    excerpt: '不急着解释设计，而是观察对方怎样理解它。一次卡顿，也可能指向下一次改进。',
    image: modelImage,
    sections: [
      { title: '忍住立刻解释的冲动', body: '原型准备好后，最期待的是听到肯定。可第一位体验者在开始的地方停了下来。设计者原本想马上解释，最后选择先观察，再问对方此刻正在寻找什么。' },
      { title: '把意外当作有用的信息', body: '测试笔记分成两栏：一栏写观察到的动作，另一栏写自己的猜测。把两者分开之后，讨论不必急于证明原方案正确，而能围绕哪些地方需要进一步了解展开。' },
      { title: '让下一版回答一个问题', body: '这一轮只调整最容易产生误解的提示，再邀请新的体验者使用。每次修改都对应一个明确的疑问，原型因此不只是展示想法的工具，也成为学习的工具。' },
    ],
    takeaway: '当设计离开自己的手，新的理解才刚刚开始。',
  },
];
