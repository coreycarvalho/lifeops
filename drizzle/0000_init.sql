CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`dump_id` text NOT NULL,
	`created_at` text NOT NULL,
	`description` text NOT NULL,
	`direction` text NOT NULL,
	`counterparty_entity_id` text,
	`due_date` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` text,
	`thread_id` text,
	FOREIGN KEY (`dump_id`) REFERENCES `dumps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`counterparty_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "commitments_direction" CHECK("commitments"."direction" in ('owed_to_me', 'owed_by_me')),
	CONSTRAINT "commitments_status" CHECK("commitments"."status" in ('open', 'done', 'dropped'))
);
--> statement-breakpoint
CREATE INDEX `commitments_dump_idx` ON `commitments` (`dump_id`);--> statement-breakpoint
CREATE INDEX `commitments_direction_status_due_idx` ON `commitments` (`direction`,`status`,`due_date`);--> statement-breakpoint
CREATE TABLE `decision_entities` (
	`decision_id` text NOT NULL,
	`entity_id` text NOT NULL,
	PRIMARY KEY(`decision_id`, `entity_id`),
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decision_entities_entity_idx` ON `decision_entities` (`entity_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`dump_id` text NOT NULL,
	`created_at` text NOT NULL,
	`decision` text NOT NULL,
	`reasoning` text,
	`decided_on` text NOT NULL,
	`thread_id` text,
	FOREIGN KEY (`dump_id`) REFERENCES `dumps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `decisions_dump_idx` ON `decisions` (`dump_id`);--> statement-breakpoint
CREATE INDEX `decisions_decided_on_idx` ON `decisions` (`decided_on`);--> statement-breakpoint
CREATE TABLE `dumps` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`raw_text` text NOT NULL,
	`source` text NOT NULL,
	`extraction_status` text DEFAULT 'pending' NOT NULL,
	`extraction_version` integer,
	`extraction_attempts` integer DEFAULT 0 NOT NULL,
	`extraction_error` text,
	`extracted_at` text,
	`echo` text,
	`flagged_wrong_at` text,
	CONSTRAINT "dumps_source" CHECK("dumps"."source" in ('web', 'api')),
	CONSTRAINT "dumps_extraction_status" CHECK("dumps"."extraction_status" in ('pending', 'processing', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `dumps_status_created_idx` ON `dumps` (`extraction_status`,`created_at`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`dump_id` text NOT NULL,
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`notes` text,
	FOREIGN KEY (`dump_id`) REFERENCES `dumps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entities_type" CHECK("entities"."type" in ('person', 'provider', 'property', 'company', 'account', 'other'))
);
--> statement-breakpoint
CREATE INDEX `entities_dump_idx` ON `entities` (`dump_id`);--> statement-breakpoint
CREATE INDEX `entities_name_idx` ON `entities` (`name`);--> statement-breakpoint
CREATE TABLE `entity_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`alias` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_aliases_entity_alias_idx` ON `entity_aliases` (`entity_id`,`alias`);--> statement-breakpoint
CREATE INDEX `entity_aliases_alias_idx` ON `entity_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `event_entities` (
	`event_id` text NOT NULL,
	`entity_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `entity_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_entities_entity_idx` ON `event_entities` (`entity_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`dump_id` text NOT NULL,
	`created_at` text NOT NULL,
	`title` text NOT NULL,
	`occurs_on` text NOT NULL,
	`occurs_at_time` text,
	`location` text,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`prep_requirements` text,
	`thread_id` text,
	FOREIGN KEY (`dump_id`) REFERENCES `dumps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "events_status" CHECK("events"."status" in ('upcoming', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `events_dump_idx` ON `events` (`dump_id`);--> statement-breakpoint
CREATE INDEX `events_occurs_on_idx` ON `events` (`occurs_on`);--> statement-breakpoint
CREATE TABLE `retrieval_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`query` text,
	`mode` text NOT NULL,
	`success` integer,
	`notes` text,
	CONSTRAINT "retrieval_log_mode" CHECK("retrieval_log"."mode" in ('search', 'trigger', 'dashboard_tap'))
);
--> statement-breakpoint
CREATE INDEX `retrieval_log_created_idx` ON `retrieval_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`dump_id` text NOT NULL,
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`dump_id`) REFERENCES `dumps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "threads_status" CHECK("threads"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `threads_dump_idx` ON `threads` (`dump_id`);--> statement-breakpoint
CREATE TABLE `trigger_fires` (
	`id` text PRIMARY KEY NOT NULL,
	`rule` text NOT NULL,
	`fired_at` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text DEFAULT 'fired' NOT NULL,
	CONSTRAINT "trigger_fires_subject_type" CHECK("trigger_fires"."subject_type" in ('event', 'commitment', 'thread')),
	CONSTRAINT "trigger_fires_status" CHECK("trigger_fires"."status" in ('fired', 'dismissed', 'acted'))
);
--> statement-breakpoint
CREATE INDEX `trigger_fires_subject_idx` ON `trigger_fires` (`subject_type`,`subject_id`,`rule`);