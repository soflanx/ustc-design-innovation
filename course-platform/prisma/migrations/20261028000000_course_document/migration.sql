-- Additive: existing text and linked records remain intact until the first block-editor save.
ALTER TABLE "CourseFocus" ADD COLUMN "document" JSONB;
ALTER TABLE "CourseFocus" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CourseFocus" ADD CONSTRAINT "CourseFocus_revision_nonnegative" CHECK ("revision" >= 0);
