ALTER TABLE `agent_configs` ADD `permission_mode` text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `permission_mode` text;