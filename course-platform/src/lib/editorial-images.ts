// Images belong to specific demo content, never to an item's position in a list.
type EditorialImage = { src: string; alt: string; caption: string; width: number; height: number };

const postImages: Record<string, EditorialImage> = {
  '2026-observation-workshop': {
    src: '/images/portal/design-workshop.jpg',
    alt: '工作坊中围绕工作台进行制作的参与者',
    caption: '工作坊场景示意 · Gu Ko / Pexels',
    width: 1400, height: 1071,
  },
  'campus-wayfinding-demo': {
    src: '/images/portal/campus-wayfinding.svg',
    alt: '校园导览原型示意图，以深色路线连接宿舍、教学楼与图书馆',
    caption: '校园导览原型示意 · 非真实学生作品',
    width: 1200, height: 800,
  },
};

export function getPostImage(slug: string): EditorialImage | undefined { return postImages[slug]; }

export function getCourseImage(slug: string): EditorialImage | undefined {
  if (slug !== 'design-thinking') return undefined;
  return {
    src: '/images/portal/studio-hero.jpg',
    alt: '工作台前的模型制作过程',
    caption: '模型制作场景示意 · Ron Lach / Pexels',
    width: 2400, height: 1600,
  };
}
