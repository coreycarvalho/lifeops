import { connection } from "next/server";
import { listRecentCaptures } from "@/capture";
import { getMaxExtractionAttempts } from "@/config";
import { getDb } from "@/db/client";
import { CaptureBox } from "./capture-box";

export default async function Home() {
  // better-sqlite3 is synchronous and would otherwise run during prerendering, on a machine
  // with no database volume. This is the documented way to keep the read at request time.
  await connection();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <h1 className="text-lg font-semibold tracking-tight">LifeOps</h1>
      <CaptureBox recent={listRecentCaptures(getDb(), getMaxExtractionAttempts())} />
    </main>
  );
}
