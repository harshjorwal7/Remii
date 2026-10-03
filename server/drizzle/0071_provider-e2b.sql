ALTER TABLE "bot_computers" ALTER COLUMN "provider" SET DEFAULT 'e2b';--> statement-breakpoint
ALTER TABLE "user_computers" ALTER COLUMN "provider" SET DEFAULT 'e2b';--> statement-breakpoint
-- Retag the existing rows.
--
-- `provider` is a record of what is behind a row, and leaving it reading `daytona` while the code
-- provisions E2B would make every one of those rows a lie that costs an operator an hour to notice.
--> statement-breakpoint
UPDATE "user_computers" SET "provider" = 'e2b' WHERE "provider" = 'daytona';--> statement-breakpoint
UPDATE "bot_computers" SET "provider" = 'e2b' WHERE "provider" = 'daytona';--> statement-breakpoint
-- Release the sandbox ids, which are Daytona's and mean nothing to E2B.
--
-- The provisioner would repair this on first use anyway — `Sandbox.getInfo` on a Daytona id misses,
-- the row's id is cleared and a fresh desktop is provisioned — so this is not strictly required for
-- correctness. It is required for HONESTY, and specifically for the status column: a row left saying
-- RUNNING over a machine that does not exist is what the settings page would render as "Awake" until
-- somebody touched the computer, which is a lie visible to a person rather than to a log.
--
-- `desiredStatus` is reset alongside because it records that this process has taken responsibility for
-- waking a machine, and there is nothing here to wake.
--> statement-breakpoint
UPDATE "user_computers"
SET "sandbox_id" = NULL,
    "status" = 'NONE',
    "desired_status" = 'RUNNING',
    "display_width" = NULL,
    "display_height" = NULL
WHERE "provider" = 'e2b' AND "sandbox_id" IS NOT NULL AND "status" NOT IN ('DELETED', 'NONE', 'DELETING');--> statement-breakpoint
UPDATE "bot_computers"
SET "sandbox_id" = NULL,
    "status" = 'NONE',
    "desired_status" = 'RUNNING',
    "display_width" = NULL,
    "display_height" = NULL
WHERE "provider" = 'e2b' AND "sandbox_id" IS NOT NULL AND "status" NOT IN ('DELETED', 'NONE', 'DELETING');