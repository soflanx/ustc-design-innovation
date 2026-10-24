import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as { coursePrisma?: PrismaClient };

export const db = globalForPrisma.coursePrisma ?? new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.coursePrisma = db;
