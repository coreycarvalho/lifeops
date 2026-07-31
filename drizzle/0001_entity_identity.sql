-- Entity identity is separated from entity provenance (issue #7).
-- `entities.dump_id` and `entity_aliases` both become rows in `entity_mentions`.
--
-- Order matters here, and it is not the order drizzle-kit generates. SQLite cannot drop a
-- column a foreign key names, so `entities` has to be rebuilt — and `DROP TABLE entities`
-- cascades to anything referencing it. `entity_mentions` is therefore created *after* the
-- rebuild, and the provenance it needs waits in a scratch table with no foreign keys of its
-- own, so nothing can cascade out from under it. src/db/migrate.ts also runs the whole
-- migration with foreign keys off, which is belt to this braces.
CREATE TABLE `__entity_provenance` (
	`entity_id` text NOT NULL,
	`dump_id` text NOT NULL,
	`alias` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__entity_provenance` ("entity_id", "dump_id", "alias")
	SELECT "id", "dump_id", "name" FROM `entities`;
--> statement-breakpoint
INSERT INTO `__entity_provenance` ("entity_id", "dump_id", "alias")
	SELECT a."entity_id", e."dump_id", a."alias"
	FROM `entity_aliases` a JOIN `entities` e ON e."id" = a."entity_id";
--> statement-breakpoint
DROP TABLE `entity_aliases`;--> statement-breakpoint
CREATE TABLE `__new_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`notes` text,
	CONSTRAINT "entities_type" CHECK("__new_entities"."type" in ('person', 'provider', 'property', 'company', 'account', 'other'))
);
--> statement-breakpoint
INSERT INTO `__new_entities`("id", "created_at", "name", "type", "notes") SELECT "id", "created_at", "name", "type", "notes" FROM `entities`;--> statement-breakpoint
DROP TABLE `entities`;--> statement-breakpoint
ALTER TABLE `__new_entities` RENAME TO `entities`;--> statement-breakpoint
CREATE INDEX `entities_name_idx` ON `entities` (`name`);--> statement-breakpoint
CREATE TABLE `entity_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`dump_id` text NOT NULL,
	`alias` text NOT NULL,
	`alias_normalized` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dump_id`) REFERENCES `dumps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_mentions_entity_dump_alias_idx` ON `entity_mentions` (`entity_id`,`dump_id`,`alias_normalized`);--> statement-breakpoint
CREATE INDEX `entity_mentions_alias_idx` ON `entity_mentions` (`alias_normalized`);--> statement-breakpoint
CREATE INDEX `entity_mentions_dump_idx` ON `entity_mentions` (`dump_id`);--> statement-breakpoint
-- `lifeops_normalize_alias` is normalizeAlias() from src/extraction/identity.ts, registered
-- on the connection by src/db/migrate.ts. It is called rather than reimplemented in SQL
-- because these values are only ever compared against what that function produces at
-- runtime, and SQLite's own `lower` is ASCII-only — a translation would leave every alias
-- with a non-ASCII capital in it unable to match anything, silently. Applying it here means
-- these migrations are run by `runMigrations`, not by piping the file into `sqlite3`.
-- A name and an alias that normalise the same are one mention, hence the GROUP BY.
INSERT INTO `entity_mentions` ("id", "entity_id", "dump_id", "alias", "alias_normalized")
	SELECT
		lower(
			hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
			substr(hex(randomblob(2)), 2) || '-' ||
			substr('89ab', abs(random()) % 4 + 1, 1) ||
			substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
		),
		"entity_id",
		"dump_id",
		min("alias"),
		"alias_normalized"
	FROM (
		SELECT
			p."entity_id" AS "entity_id",
			p."dump_id" AS "dump_id",
			p."alias" AS "alias",
			lifeops_normalize_alias(p."alias") AS "alias_normalized"
		FROM `__entity_provenance` p
	)
	WHERE "alias_normalized" <> ''
	GROUP BY "entity_id", "dump_id", "alias_normalized";
--> statement-breakpoint
DROP TABLE `__entity_provenance`;
