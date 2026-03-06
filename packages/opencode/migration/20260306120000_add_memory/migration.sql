CREATE TABLE `memory` (
	`version_id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`scope` text NOT NULL,
	`path` text NOT NULL,
	`session` text,
	`project_id` text,
	`workspace` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`version` integer NOT NULL,
	`is_current` integer NOT NULL,
	`author_model` text NOT NULL,
	`description` text NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`session`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_card_idx` ON `memory` (`card_id`);
--> statement-breakpoint
CREATE INDEX `memory_path_idx` ON `memory` (`scope`,`path`);
--> statement-breakpoint
CREATE INDEX `memory_session_idx` ON `memory` (`session`);
--> statement-breakpoint
CREATE INDEX `memory_project_idx` ON `memory` (`project_id`);
--> statement-breakpoint
CREATE INDEX `memory_workspace_idx` ON `memory` (`workspace`);
