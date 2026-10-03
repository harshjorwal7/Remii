ALTER TABLE "credit_ledger" ADD COLUMN "idempotency_key" text;
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_unique" ON "credit_ledger" USING btree ("idempotency_key");
