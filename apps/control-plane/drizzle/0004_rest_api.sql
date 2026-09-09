CREATE TABLE `api_configs` (
	`project_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`jwt_secret_enc` text NOT NULL,
	`authenticator_password_enc` text NOT NULL,
	`schemas` text DEFAULT 'public' NOT NULL,
	`max_rows` integer DEFAULT 1000 NOT NULL,
	`container_id` text,
	`container_name` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
