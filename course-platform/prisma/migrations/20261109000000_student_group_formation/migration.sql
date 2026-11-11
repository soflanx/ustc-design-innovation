CREATE TYPE "GroupRecruitmentMode" AS ENUM ('COURSE', 'INVITE', 'CLOSED');

ALTER TABLE "CourseOffering"
  ADD COLUMN "groupFormationWindowId" TEXT,
  ADD COLUMN "groupFormationClosesAt" TIMESTAMP(3),
  ADD COLUMN "groupFormationCapacity" INTEGER,
  ADD CONSTRAINT "CourseOffering_group_formation_window" CHECK (
    ("groupFormationWindowId" IS NULL AND "groupFormationClosesAt" IS NULL AND "groupFormationCapacity" IS NULL)
    OR ("status" <> 'ARCHIVED' AND "groupFormationWindowId" IS NOT NULL AND "groupFormationClosesAt" IS NOT NULL
      AND "groupFormationCapacity" IS NOT NULL AND "groupFormationCapacity" BETWEEN 2 AND 100)
  );

ALTER TABLE "Group"
  ADD COLUMN "recruitmentMode" "GroupRecruitmentMode",
  ADD COLUMN "recruitmentWindowId" TEXT,
  ADD COLUMN "recruitmentToken" TEXT,
  ADD COLUMN "recruitmentNote" TEXT NOT NULL DEFAULT '',
  ADD CONSTRAINT "Group_recruitment_configuration" CHECK (
    ("recruitmentMode" IS NULL AND "recruitmentWindowId" IS NULL AND "recruitmentToken" IS NULL)
    OR ("recruitmentMode" IS NOT NULL AND "recruitmentWindowId" IS NOT NULL
      AND ("recruitmentToken" IS NOT NULL) = ("recruitmentMode" = 'INVITE'))
  );

CREATE UNIQUE INDEX "Group_recruitmentToken_key" ON "Group"("recruitmentToken");
