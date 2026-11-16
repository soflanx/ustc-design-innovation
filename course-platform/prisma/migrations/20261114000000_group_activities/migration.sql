BEGIN;

CREATE TABLE "GroupActivity" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "nextStep" TEXT NOT NULL DEFAULT '',
    "occurredOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "requestFingerprint" TEXT NOT NULL,
    CONSTRAINT "GroupActivity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GroupActivity_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupActivity_authorId_offeringId_fkey" FOREIGN KEY ("authorId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "GroupActivity_id_offeringId_key" ON "GroupActivity"("id", "offeringId");
CREATE INDEX "GroupActivity_offeringId_groupId_withdrawnAt_createdAt_idx" ON "GroupActivity"("offeringId", "groupId", "withdrawnAt", "createdAt");

CREATE TABLE "GroupActivityParticipant" (
    "offeringId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "courseMemberId" TEXT NOT NULL,
    CONSTRAINT "GroupActivityParticipant_pkey" PRIMARY KEY ("activityId", "courseMemberId"),
    CONSTRAINT "GroupActivityParticipant_activityId_offeringId_fkey" FOREIGN KEY ("activityId", "offeringId") REFERENCES "GroupActivity"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupActivityParticipant_courseMemberId_offeringId_fkey" FOREIGN KEY ("courseMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "GroupActivityFile" (
    "offeringId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "GroupActivityFile_pkey" PRIMARY KEY ("activityId", "fileId"),
    CONSTRAINT "GroupActivityFile_activityId_offeringId_fkey" FOREIGN KEY ("activityId", "offeringId") REFERENCES "GroupActivity"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupActivityFile_fileId_offeringId_fkey" FOREIGN KEY ("fileId", "offeringId") REFERENCES "FileObject"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "GroupActivityFile_activityId_position_key" ON "GroupActivityFile"("activityId", "position");

COMMIT;
