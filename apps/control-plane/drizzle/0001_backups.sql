CREATE TABLE `backup_configs` (
	`project_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`stanza` text NOT NULL,
	`repo_type` text DEFAULT 'posix' NOT NULL,
	`repo_config_enc` text,
	`interval_hours` integer DEFAULT 24 NOT NULL,
	`full_every_days` integer DEFAULT 7 NOT NULL,
	`retention_full` integer DEFAULT 4 NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`archiving_healthy` integer,
	`archiving_checked_at` integer,
	`archiving_error` text,
	`awaiting_first_backup` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`job_id` text,
	`type` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`size_bytes` integer,
	`error` text,
	`verification` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_runs_project_idx` ON `backup_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `restore_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`detail` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `restore_checks_project_idx` ON `restore_checks` (`project_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `backup_volume_name` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `source_repo_volume_name` text;