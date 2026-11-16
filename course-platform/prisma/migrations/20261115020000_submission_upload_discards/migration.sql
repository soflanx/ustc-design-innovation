CREATE TABLE "SubmissionUploadDiscard" (
  "ownerId" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubmissionUploadDiscard_pkey" PRIMARY KEY ("ownerId", "offeringId", "assignmentId", "fileId"),
  CONSTRAINT "SubmissionUploadDiscard_ownerId_fkey" FOREIGN KEY ("ownerId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SubmissionUploadDiscard_assignmentId_offeringId_fkey" FOREIGN KEY ("assignmentId", "offeringId")
    REFERENCES "Assignment"("id", "offeringId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SubmissionUploadDiscard_expiresAt_idx" ON "SubmissionUploadDiscard"("expiresAt");
CREATE INDEX "SubmissionUploadDiscard_assignmentId_offeringId_idx" ON "SubmissionUploadDiscard"("assignmentId", "offeringId");
