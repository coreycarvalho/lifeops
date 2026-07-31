// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureEcho } from "@/capture";
import { CaptureBox } from "./capture-box";

/**
 * The capture box is the trust mechanism made visible: dump, get told it landed, get told
 * what was understood, say "wrong" if it wasn't. These tests drive it the way a person does.
 *
 * The API is stubbed at `fetch` — the endpoints themselves are covered against a real
 * database in src/app/api/dumps/route.test.ts.
 *
 * Timers are faked throughout so the polling interval can be stepped over deliberately
 * rather than waited out.
 */

type Stubbed = { status: number; body: unknown };

/** Canned responses by "METHOD /path". Every request is recorded. */
let routes: Map<string, Stubbed>;
let calls: { method: string; url: string }[];

function stub(key: string, body: unknown, status = 200) {
  routes.set(key, { body, status });
}

/** Let every pending fetch settle and React re-render. */
const flush = () => act(async () => {});

/** Step over one poll interval, then let the responses land. */
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(3000)));

beforeEach(() => {
  vi.useFakeTimers();
  routes = new Map();
  calls = [];
  // A hand-rolled response rather than `new Response(...)`: reading a real response body
  // goes through a stream that waits on timers, and the timers here are faked.
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const canned = routes.get(`${method} ${url}`) ?? {
      status: 500,
      body: { error: "not stubbed" },
    };
    return {
      ok: canned.status < 400,
      status: canned.status,
      json: async () => canned.body,
    };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const CAPTURED: CaptureEcho = {
  id: "dump-1",
  capturedAt: "2026-06-01T09:00:00.000Z",
  status: "pending",
  echo: "Captured. Working out what's in it…",
  flaggedWrong: false,
  retrying: false,
};

const SUMMARISED: CaptureEcho = {
  ...CAPTURED,
  status: "done",
  echo: "Got it: tilt table test → Jun 22; waiting on Ray: send the furnace quote",
};

async function dump(text: string) {
  fireEvent.change(screen.getByLabelText(/what's on your mind/i), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: /capture/i }));
  await flush();
}

const box = () => screen.getByLabelText(/what's on your mind/i);
const polls = () => calls.filter((c) => c.method === "GET").length;

describe("dumping something in", () => {
  it("asks nothing about how to file it", () => {
    render(<CaptureBox recent={[]} />);

    // Invariant 1: the box and the capture button are the whole interface. Anything that
    // asked the user to classify would show up as one of these.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(box()).toBeTruthy();
  });

  it("confirms the moment the text is stored, without waiting for the model", async () => {
    // Behaviour 12. Extraction takes minutes; the confirmation must not.
    stub("POST /api/dumps", CAPTURED, 201);
    render(<CaptureBox recent={[]} />);

    await dump("furnace guy is sending a quote by friday");

    expect(screen.getByText("Captured. Working out what's in it…")).toBeTruthy();
    // Nothing has been asked about extraction yet — the confirmation is not waiting on it.
    expect(polls()).toBe(0);
  });

  it("empties the box so the next thought can go straight in", async () => {
    stub("POST /api/dumps", CAPTURED, 201);
    render(<CaptureBox recent={[]} />);

    await dump("furnace quote by friday");

    expect(box()).toHaveProperty("value", "");
  });

  it("keeps the text in the box when the capture failed", async () => {
    // Losing a dump to a failed request is the one unforgivable bug in this box.
    stub("POST /api/dumps", { error: "nope" }, 500);
    render(<CaptureBox recent={[]} />);

    await dump("furnace quote by friday");

    expect(box()).toHaveProperty("value", "furnace quote by friday");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("replaces the confirmation with a summary of what was captured", async () => {
    // Behaviour 1: the one-line summary arrives later, and replaces the confirmation.
    stub("POST /api/dumps", CAPTURED, 201);
    stub("GET /api/dumps/dump-1", SUMMARISED);
    render(<CaptureBox recent={[]} />);

    await dump("furnace guy is sending a quote by friday");
    expect(screen.getByText("Captured. Working out what's in it…")).toBeTruthy();

    await tick();

    expect(screen.getByText(SUMMARISED.echo)).toBeTruthy();
    expect(screen.queryByText("Captured. Working out what's in it…")).toBeNull();
  });

  it("shows the failure when extraction failed", async () => {
    // Behaviour 6, at the surface the user actually looks at.
    stub("POST /api/dumps", CAPTURED, 201);
    stub("GET /api/dumps/dump-1", {
      ...CAPTURED,
      status: "failed",
      echo: "Captured, but extraction failed: endpoint refused the connection",
    });
    render(<CaptureBox recent={[]} />);

    await dump("furnace quote by friday");
    await tick();

    expect(screen.getByText(/extraction failed/i)).toBeTruthy();
  });

  it("keeps asking about a failure the worker will retry", async () => {
    // The worker retries a failed dump while attempts remain. Treating the first failure as
    // final would leave the user reading an error that the next attempt fixed, until they
    // happened to reload — which is the trust mechanism quietly lying to them.
    const retryable = {
      ...CAPTURED,
      status: "failed" as const,
      echo: "Captured. Extraction failed, trying again: endpoint refused the connection",
      retrying: true,
    };
    stub("POST /api/dumps", CAPTURED, 201);
    stub("GET /api/dumps/dump-1", retryable);
    render(<CaptureBox recent={[]} />);

    await dump("furnace quote by friday");
    await tick();
    expect(screen.getByText(/trying again/i)).toBeTruthy();

    // The retry succeeds, and the summary arrives without a reload.
    stub("GET /api/dumps/dump-1", SUMMARISED);
    await tick();

    expect(screen.getByText(SUMMARISED.echo)).toBeTruthy();
    expect(screen.queryByText(/trying again/i)).toBeNull();
  });

  it("stops asking once a failure has run out of attempts", async () => {
    const terminal = {
      ...CAPTURED,
      status: "failed" as const,
      echo: "Captured, but extraction failed: endpoint refused the connection",
      retrying: false,
    };
    stub("POST /api/dumps", CAPTURED, 201);
    stub("GET /api/dumps/dump-1", terminal);
    render(<CaptureBox recent={[]} />);

    await dump("furnace quote by friday");
    await tick();
    expect(screen.getByText(terminal.echo)).toBeTruthy();

    const settled = polls();
    for (let i = 0; i < 10; i++) await tick();

    expect(polls()).toBe(settled);
  });

  it("stops asking once the summary has arrived", async () => {
    stub("POST /api/dumps", CAPTURED, 201);
    stub("GET /api/dumps/dump-1", SUMMARISED);
    render(<CaptureBox recent={[]} />);

    await dump("furnace quote by friday");
    await tick();
    expect(screen.getByText(SUMMARISED.echo)).toBeTruthy();

    const settled = polls();
    for (let i = 0; i < 10; i++) await tick();

    expect(polls()).toBe(settled);
  });
});

describe("saying the echo got it wrong", () => {
  it("records it", async () => {
    // Behaviour 8, first half.
    stub("POST /api/dumps/dump-1/wrong", { id: "dump-1", flaggedWrong: true });
    render(<CaptureBox recent={[SUMMARISED]} />);

    fireEvent.click(screen.getByRole("button", { name: /mark this wrong/i }));
    await flush();

    expect(screen.getByText(/marked wrong/i)).toBeTruthy();
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/dumps/dump-1/wrong",
    });
  });

  it("takes the flag back when the request did not save it", async () => {
    // Showing "marked wrong" for something the database never recorded is worse than not
    // offering the button: the affordance would be claiming a persistence it does not have.
    stub("POST /api/dumps/dump-1/wrong", { error: "nope" }, 500);
    render(<CaptureBox recent={[SUMMARISED]} />);

    fireEvent.click(screen.getByRole("button", { name: /mark this wrong/i }));
    await flush();

    expect(screen.queryByText(/marked wrong/i)).toBeNull();
    expect(screen.getByRole("button", { name: /mark this wrong/i })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("is not offered until there is a summary to be wrong about", () => {
    // "Captured. Working out what's in it…" is the system reporting on itself. The endpoint
    // refuses a flag against it, and the button that would send one is not shown.
    render(<CaptureBox recent={[CAPTURED]} />);

    expect(screen.queryByRole("button", { name: /mark this wrong/i })).toBeNull();
    expect(screen.getByText("Captured. Working out what's in it…")).toBeTruthy();
  });

  it("is still recorded after a reload", () => {
    // Behaviour 8, second half. A reload re-renders from what the server knows, so this is
    // the flag having actually been persisted — not page state that survived a re-render.
    render(<CaptureBox recent={[{ ...SUMMARISED, flaggedWrong: true }]} />);

    expect(screen.getByText(/marked wrong/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /mark this wrong/i })).toBeNull();
  });
});

describe("coming back to the page", () => {
  it("shows the echoes for captures made earlier", () => {
    // Extraction takes minutes. An echo that only lived in the page would almost never be
    // seen, and the trust mechanism would hold on paper only.
    render(<CaptureBox recent={[SUMMARISED]} />);
    expect(screen.getByText(SUMMARISED.echo)).toBeTruthy();
  });

  it("picks up where an unfinished extraction left off", async () => {
    stub("GET /api/dumps/dump-1", SUMMARISED);
    render(<CaptureBox recent={[CAPTURED]} />);

    await tick();

    expect(screen.getByText(SUMMARISED.echo)).toBeTruthy();
  });
});
