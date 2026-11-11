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

export const newsFeatures: readonly EditorialRecord[] = [];
export const stories: readonly EditorialRecord[] = [];
