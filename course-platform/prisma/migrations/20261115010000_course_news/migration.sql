ALTER TABLE "Post" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publishedRevision" INTEGER,
  ADD COLUMN "creationFingerprint" TEXT,
  ADD COLUMN "useLegacyCover" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "publishedCoverId" TEXT;

ALTER TABLE "Post" ADD CONSTRAINT "Post_revision_order"
  CHECK ("revision" >= 0 AND ("publishedRevision" IS NULL OR "publishedRevision" BETWEEN 0 AND "revision"));

CREATE TABLE "PostNewsDraft" (
  "postId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "useLegacyCover" BOOLEAN NOT NULL DEFAULT false,
  "coverId" TEXT,
  CONSTRAINT "PostNewsDraft_pkey" PRIMARY KEY ("postId"),
  CONSTRAINT "PostNewsDraft_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "NewsImage" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "alt" TEXT NOT NULL,
  "caption" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "contentType" TEXT NOT NULL,
  "bytes" BYTEA NOT NULL,
  CONSTRAINT "NewsImage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NewsImage_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NewsImage_format" CHECK ("contentType" = 'image/webp' AND "width" > 0 AND "height" > 0 AND octet_length("bytes") > 0)
);

CREATE UNIQUE INDEX "NewsImage_id_postId_key" ON "NewsImage"("id", "postId");
CREATE INDEX "NewsImage_postId_idx" ON "NewsImage"("postId");
CREATE UNIQUE INDEX "Post_publishedCoverId_id_key" ON "Post"("publishedCoverId", "id");
CREATE UNIQUE INDEX "PostNewsDraft_coverId_postId_key" ON "PostNewsDraft"("coverId", "postId");

ALTER TABLE "Post" ADD CONSTRAINT "Post_publishedCoverId_id_fkey"
  FOREIGN KEY ("publishedCoverId", "id") REFERENCES "NewsImage"("id", "postId");
ALTER TABLE "PostNewsDraft" ADD CONSTRAINT "PostNewsDraft_coverId_postId_fkey"
  FOREIGN KEY ("coverId", "postId") REFERENCES "NewsImage"("id", "postId");
