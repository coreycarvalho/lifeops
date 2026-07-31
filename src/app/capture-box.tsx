"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureEcho } from "@/capture";

/**
 * One box. Type, capture, get told what the system understood.
 *
 * There is nothing here to classify with — no category, no tag, no folder (invariant 1),
 * and nothing to configure. The only two controls are "capture" and "wrong".
 *
 * Capture confirms the moment the text is stored. Extraction takes 15 seconds to several
 * minutes on a local model, so waiting for it would mean a spinner instead of a
 * confirmation, and the user could not stop remembering — which is the entire point
 * (docs/DECISIONS.md). The summary fills in afterwards.
 */

/** Long enough not to hammer the endpoint, short enough that the echo feels like it lands. */
const POLL_MS = 3000;

/**
 * Nothing more is coming for this capture.
 *
 * A failure is *not* settled while the worker still has attempts left for it — stopping
 * there would leave the user staring at an error the very next attempt fixed, until they
 * happened to reload.
 */
const settled = (capture: CaptureEcho) =>
  capture.status === "done" ||
  (capture.status === "failed" && !capture.retrying);

export function CaptureBox({ recent }: { recent: CaptureEcho[] }) {
  const [captures, setCaptures] = useState(recent);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async (id: string) => {
    const response = await fetch(`/api/dumps/${id}`);
    if (!response.ok) return;
    const fresh = (await response.json()) as CaptureEcho;
    setCaptures((current) =>
      current.map((capture) => (capture.id === fresh.id ? fresh : capture)),
    );
  }, []);

  useEffect(() => {
    const waiting = captures.filter((capture) => !settled(capture));
    if (waiting.length === 0) return;

    const timer = setInterval(() => {
      for (const capture of waiting) void refresh(capture.id);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [captures, refresh]);

  async function capture(event: React.FormEvent) {
    event.preventDefault();
    if (text.trim() === "" || capturing) return;

    setCapturing(true);
    setError(null);
    try {
      const response = await fetch("/api/dumps", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lifeops-source": "web",
        },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error("That did not save. Try again?");

      const stored = (await response.json()) as CaptureEcho;
      // Cleared only once the text is definitely stored — losing a dump to a failed
      // request would be the one unforgivable bug in this box.
      setText("");
      setCaptures((current) => [{ ...stored, flaggedWrong: false }, ...current]);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setCapturing(false);
      box.current?.focus();
    }
  }

  async function flagWrong(id: string) {
    const mark = (flaggedWrong: boolean) =>
      setCaptures((current) =>
        current.map((c) => (c.id === id ? { ...c, flaggedWrong } : c)),
      );

    setError(null);
    mark(true);
    try {
      const response = await fetch(`/api/dumps/${id}/wrong`, { method: "POST" });
      if (!response.ok) throw new Error("That did not save. Try again?");
    } catch (problem) {
      // The flag is the trust affordance: showing "marked wrong" for something the database
      // never recorded is worse than not offering the button at all. Put it back.
      mark(false);
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-8">
      <form onSubmit={capture} className="flex flex-col gap-3">
        <label htmlFor="dump" className="text-sm text-zinc-500">
          What&apos;s on your mind?
        </label>
        <textarea
          id="dump"
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          autoFocus
          placeholder="Anything. It gets filed for you."
          className="w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm leading-6 outline-none focus:border-zinc-500 dark:border-zinc-700"
        />
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={capturing || text.trim() === ""}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
          >
            Capture
          </button>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
        </div>
      </form>

      {captures.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {captures.map((capture) => (
            <li
              key={capture.id}
              className="flex items-start justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <p className="text-sm leading-6">{capture.echo}</p>
              {capture.flaggedWrong ? (
                <span className="shrink-0 text-xs text-zinc-500">
                  marked wrong
                </span>
              ) : capture.status !== "done" ? null : (
                <button
                  type="button"
                  onClick={() => flagWrong(capture.id)}
                  aria-label={`Mark this wrong: ${capture.echo}`}
                  className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                >
                  Wrong
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
