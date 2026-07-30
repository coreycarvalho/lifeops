/**
 * Entrypoint for the one-shot `migrate` container that runs before web and worker start.
 * Kept separate from `migrate.ts` so importing the migrator does not execute it.
 */
import { getDbPath } from "@/config";
import { openDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";

const dbPath = getDbPath();
const folder = migrationsFolder();

console.log(`Applying migrations from ${folder} to ${dbPath}`);
runMigrations(openDb(dbPath), folder);
console.log("Migrations applied.");
