export type PublicProjectDemo = {
  question: string;
  audience: string;
  attempt: string;
  nextQuestion: string;
  introduction: string;
  steps: readonly { title: string; body: string }[];
};

// Practice prompts belong to this example slug, not to every public project.
const projectDemos: Readonly<Record<string, PublicProjectDemo>> = {
  'campus-wayfinding-demo': {
    question: '第一次来到校园的人，怎样更容易找到要去的地方？',
    audience: '第一次到访校园的人',
    attempt: '把路线与地标做成可以讨论的导览原型',
    nextQuestion: '走到分岔时，哪些信息能帮助人作出判断？',
    introduction: '以一段校园步行路线为练习情境，尝试用信息设计回应初次到访者的寻路需要。图中的路线、地点与标记用于讨论导览方式。',
    steps: [
      {
        title: '理解问题',
        body: '可以先把“从校园入口走向图书馆”设为练习情境，列出沿途需要判断方向的位置。若开展真实练习，下一步可邀请初次到访者边走边说出正在寻找的信息，记录停顿、回头和提问的位置，再据此修订问题。',
      },
      {
        title: '制作原型',
        body: '参照示意图，将起点、目的地、路线和可识别的地标画在同一张图上。可以用纸面草图尝试不同的箭头、名称和路口提示，让他人能够指出哪里读得懂、哪里还需要解释。',
      },
      {
        title: '如何验证',
        body: '下一步可把原型放到实际路线中，请不熟悉路线的人尝试使用。关注他们在分岔处寻找什么、是否需要额外询问，以及如何确认已经走对方向。保留使用过程与修改理由，再决定哪些信息需要补充或删减。',
      },
    ],
  },
};

export function getProjectDemo(slug: string): PublicProjectDemo | undefined {
  return Object.hasOwn(projectDemos, slug) ? projectDemos[slug] : undefined;
}
