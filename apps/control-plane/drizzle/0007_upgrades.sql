CREATE TABLE `upgrades` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_major` integer NOT NULL,
	`to_major` integer NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`job_id` text,
	`previous_volume_name` text,
	`previous_image` text,
	`previous_discarded_at` integer,
	`manifest_before` text,
	`manifest_after` text,
	`error` text,
	`started_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `upgrades_project_idx` ON `upgrades` (`project_id`,`started_at`);