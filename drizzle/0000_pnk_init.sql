CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"full_name" text NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_code" text NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"last_name" text NOT NULL,
	"suffix" text,
	"birthday" date,
	"purok_grupo" text,
	"date_of_oath" date,
	"current_destination_id" uuid,
	"language" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"date_inactive" date,
	"inactive_reason" text,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teachers_teacher_code_unique" UNIQUE("teacher_code")
);
--> statement-breakpoint
CREATE TABLE "dako" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dako_code" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"date_established" date NOT NULL,
	"purok_grupo" text,
	"worship_day" text NOT NULL,
	"worship_time" text NOT NULL,
	"language" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"date_disabled" date,
	"disable_reason" text,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dako_dako_code_unique" UNIQUE("dako_code")
);
--> statement-breakpoint
CREATE TABLE "weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"iso_week_number" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"availability_status" text NOT NULL,
	"reason" text,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_id" uuid NOT NULL,
	"dako_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"assignment_type" text NOT NULL,
	"assignment_source" text DEFAULT 'MANUAL' NOT NULL,
	"status" text DEFAULT 'ASSIGNED' NOT NULL,
	"is_override" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"old_teacher_id" uuid,
	"new_teacher_id" uuid,
	"old_assignment_type" text,
	"new_assignment_type" text,
	"old_status" text,
	"new_status" text,
	"changed_by" uuid,
	"change_reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dako_anniversary_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dako_id" uuid NOT NULL,
	"anniversary_year" integer NOT NULL,
	"notification_type" text NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_type" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"scheduled_for" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_current_destination_id_dako_id_fk" FOREIGN KEY ("current_destination_id") REFERENCES "public"."dako"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_availability" ADD CONSTRAINT "teacher_availability_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_availability" ADD CONSTRAINT "teacher_availability_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_dako_id_dako_id_fk" FOREIGN KEY ("dako_id") REFERENCES "public"."dako"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_history" ADD CONSTRAINT "assignment_history_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_history" ADD CONSTRAINT "assignment_history_old_teacher_id_teachers_id_fk" FOREIGN KEY ("old_teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_history" ADD CONSTRAINT "assignment_history_new_teacher_id_teachers_id_fk" FOREIGN KEY ("new_teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_history" ADD CONSTRAINT "assignment_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dako_anniversary_notifications" ADD CONSTRAINT "dako_anniversary_notifications_dako_id_dako_id_fk" FOREIGN KEY ("dako_id") REFERENCES "public"."dako"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "teachers_status_idx" ON "teachers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "teachers_language_idx" ON "teachers" USING btree ("language");--> statement-breakpoint
CREATE INDEX "teachers_purok_grupo_idx" ON "teachers" USING btree ("purok_grupo");--> statement-breakpoint
CREATE INDEX "teachers_current_destination_idx" ON "teachers" USING btree ("current_destination_id");--> statement-breakpoint
CREATE INDEX "dako_status_idx" ON "dako" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dako_language_idx" ON "dako" USING btree ("language");--> statement-breakpoint
CREATE INDEX "dako_purok_grupo_idx" ON "dako" USING btree ("purok_grupo");--> statement-breakpoint
CREATE INDEX "dako_date_established_idx" ON "dako" USING btree ("date_established");--> statement-breakpoint
CREATE UNIQUE INDEX "weeks_year_iso_week_number_key" ON "weeks" USING btree ("year","iso_week_number");--> statement-breakpoint
CREATE INDEX "weeks_year_idx" ON "weeks" USING btree ("year");--> statement-breakpoint
CREATE UNIQUE INDEX "teacher_availability_teacher_week_key" ON "teacher_availability" USING btree ("teacher_id","week_id");--> statement-breakpoint
CREATE INDEX "teacher_availability_week_status_idx" ON "teacher_availability" USING btree ("week_id","availability_status");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_week_dako_type_key" ON "assignments" USING btree ("week_id","dako_id","assignment_type");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_week_teacher_key" ON "assignments" USING btree ("week_id","teacher_id");--> statement-breakpoint
CREATE INDEX "assignments_week_idx" ON "assignments" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX "assignments_dako_idx" ON "assignments" USING btree ("dako_id");--> statement-breakpoint
CREATE INDEX "assignments_teacher_idx" ON "assignments" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "assignments_type_idx" ON "assignments" USING btree ("assignment_type");--> statement-breakpoint
CREATE INDEX "assignment_history_assignment_idx" ON "assignment_history" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_history_changed_at_idx" ON "assignment_history" USING btree ("changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dako_anniv_dedupe_key" ON "dako_anniversary_notifications" USING btree ("dako_id","anniversary_year","notification_type");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_scheduled_idx" ON "notifications" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "notifications_read_idx" ON "notifications" USING btree ("read_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");