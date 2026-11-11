-- Each subpage belongs directly to one course offering.
CREATE TABLE "CourseSubpage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "offeringId" TEXT NOT NULL REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "creationFingerprint" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "document" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "draftTitle" TEXT,
  "draftDocument" JSONB,
  "draftSavedAt" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("draftTitle" IS NULL) = ("draftDocument" IS NULL) AND ("draftTitle" IS NULL) = ("draftSavedAt" IS NULL)),
  CHECK ("publishedAt" IS NOT NULL OR "draftDocument" IS NOT NULL)
);
CREATE INDEX "CourseSubpage_offeringId_createdAt_id_idx" ON "CourseSubpage"("offeringId", "createdAt", "id");
