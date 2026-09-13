CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`current_node` text,
	`task` text DEFAULT '' NOT NULL,
	`focus` text DEFAULT '' NOT NULL,
	`model` text,
	`api_url` text,
	`api_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_updated_idx` ON `agents` (`updated_at`);