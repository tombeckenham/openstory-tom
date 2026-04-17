import { defineCollection, defineConfig } from '@content-collections/core';
import matter from 'gray-matter';
import { z } from 'zod';

const docs = defineCollection({
  name: 'docs',
  directory: './src/content/docs',
  include: '**/*.md',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.string(),
    order: z.number(),
    content: z.string(),
  }),
  transform: (data) => {
    const { content: body } = matter(data.content);
    const slug = data._meta.path;
    return {
      ...data,
      body,
      slug,
    };
  },
});

export default defineConfig({
  content: [docs],
});
