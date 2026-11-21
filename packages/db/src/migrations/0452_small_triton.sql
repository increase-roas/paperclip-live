CREATE TABLE "agent_readiness_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"check_id" text NOT NULL,
	"note" text,
	"attested_by_user_id" text NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_readiness_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"include_live" boolean DEFAULT false NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "agent_readiness_attestations" ADD CONSTRAINT "agent_readiness_attestations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_readiness_reports" ADD CONSTRAINT "agent_readiness_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_readiness_attestations_subject_check_uq" ON "agent_readiness_attestations" USING btree ("company_id","subject_type","subject_id","check_id");--> statement-breakpoint
CREATE INDEX "agent_readiness_attestations_company_idx" ON "agent_readiness_attestations" USING btree ("company_id","attested_at");--> statement-breakpoint
CREATE INDEX "agent_readiness_reports_company_started_idx" ON "agent_readiness_reports" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_readiness_reports_company_status_idx" ON "agent_readiness_reports" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_readiness_reports_running_uq" ON "agent_readiness_reports" USING btree ("company_id") WHERE "agent_readiness_reports"."status" = 'running';