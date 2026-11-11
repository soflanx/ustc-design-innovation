type LearningTopic = {
  title: string;
  description: string;
  link?: { href: string; label: string };
};

type LearningPath = {
  id: string;
  title: string;
  description: string;
  image: { src: string; alt: string; width: number; height: number };
  topics: readonly LearningTopic[];
};

export const learningPaths: readonly LearningPath[] = [
  {
    id: 'exchange',
    title: '交流',
    description: '清楚表达设计思路，理解不同意见。通过讨论与分享，把反馈转化为下一步的修改。',
    image: { src: '/images/portal/student-discussion.jpg', alt: '学生围绕桌面笔记交流各自的想法', width: 1600, height: 1067 },
    topics: [
      {
        title: '跨文化交流',
        description: '围绕共同问题交流调研发现，比较不同文化与生活环境中的需求，理解不同判断背后的原因。',
      },
      {
        title: '分享与反馈',
        description: '用草图、原型和阶段汇报说明设计选择，通过同伴与教师的提问，为下一轮修改找到依据。',
      },
    ],
  },
  {
    id: 'practice',
    title: '实践',
    description: '从发现问题到验证方案。通过观察、访谈与原型测试，学习依据证据作出设计选择。',
    image: { src: '/images/portal/studio-hero.jpg', alt: '参与者在工作台前制作和调整模型', width: 2400, height: 1600 },
    topics: [
      {
        title: '观察与访谈',
        description: '走进具体场景，观察人们的行动，听他们讲述经历。区分事实与猜测，找到需要回应的问题。',
      },
      {
        title: '原型与测试',
        description: '用模型、界面或情境演示呈现设想，邀请使用者体验，记录遇到的困难，让修改有据可循。',
      },
    ],
  },
  {
    id: 'collaboration',
    title: '合作',
    description: '与不同背景的伙伴共同完成设计。通过跨学科项目，练习分工、沟通与共同决策。',
    image: { src: '/images/portal/design-workshop.jpg', alt: '参与者在同一张工作台上制作与讨论', width: 1400, height: 1071 },
    topics: [
      {
        title: '课程内协作',
        description: '不同专业的同学共同调研、讨论与制作，用清楚的记录和持续沟通处理分歧，在分工中相互学习。',
      },
      {
        title: '国际合作',
        description: '国际合作可围绕共同课题开展，与海外师生交流调研和原型，比较方案在不同文化与环境中的表现。',
        link: { href: '#partners', label: '查看合作与交流' },
      },
      {
        title: '企业合作',
        description: '企业可提供实际问题、行业经验和测试场景，参与原型反馈，帮助学生理解技术、成本与应用条件。',
      },
    ],
  },
];
