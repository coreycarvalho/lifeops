import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadConfig, type Env } from "./config";

/**
 * The deployment behaviours of issue #6 that live in files rather than in TypeScript.
 *
 * "One volume", "migrations run once with nothing racing them", "web and worker are separate
 * processes" and "main publishes a multi-arch image" are all properties of docker-compose.yml
 * and the publish workflow. They are as load-bearing as anything in src/ — a second service
 * quietly given its own volume breaks backups, and nobody would notice until a restore.
 *
 * So they are asserted here, from the real files. The one thing this cannot check is that the
 * image builds and runs; that is `docker buildx build` and `docker compose up`, per the
 * issue's own note that the real-host run is the operator's.
 */

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

type Service = {
  image: string;
  command: string[];
  volumes: string[];
  environment: Record<string, string>;
  ports?: string[];
  extra_hosts?: string[];
  restart?: string;
  depends_on?: Record<string, { condition: string }>;
};

const compose = parse(read("docker-compose.yml")) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const services = compose.services;

const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
  .scripts;

describe("compose services", () => {
  it("ships the three processes the design calls for, and nothing else", () => {
    // No model server: inference is not co-located (docs/DECISIONS.md). No database
    // service either — SQLite is a file on the volume.
    expect(Object.keys(services).sort()).toEqual(["init", "web", "worker"]);
  });

  it("runs the web app and the extraction worker as separate processes", () => {
    // Extraction takes minutes per dump. Sharing a process with the request handler would
    // put that latency in front of the user, which is the thing the echo exists to avoid.
    expect(services.web.command).not.toEqual(services.worker.command);
    expect(services.worker.command.join(" ")).toContain("worker");
    expect(services.web.command.join(" ")).toContain("start");
  });

  it("runs migrations in one place, before anything that uses the database", () => {
    // Two services racing to migrate the same SQLite file is the failure this ordering
    // exists to prevent, and `depends_on` alone would not give it — only the completed
    // condition does.
    expect(services.init.command.join(" ")).toContain("init");
    for (const name of ["web", "worker"] as const) {
      expect(services[name].depends_on).toEqual({
        init: { condition: "service_completed_successfully" },
      });
      expect(services[name].command.join(" ")).not.toMatch(/init|migrate/);
    }
    expect(services.init.restart).toBe("no");
  });

  it("checks the endpoint before it applies migrations", () => {
    // The compose command is only as good as what it runs. Preflight first, so a
    // misconfigured endpoint fails before anything touches the operator's data.
    expect(scripts.init).toBe("npm run preflight && npm run db:migrate");
  });

  it("keeps web and worker running, and lets init stay finished", () => {
    expect(services.web.restart).toBe("unless-stopped");
    expect(services.worker.restart).toBe("unless-stopped");
  });

  it("lets the processes that call the model reach the Docker host", () => {
    // Without this, http://host.docker.internal:11434/v1 does not resolve and the operator
    // is pushed back towards `localhost`, which is the container.
    for (const name of ["init", "worker"] as const) {
      expect(services[name].extra_hosts).toContain(
        "host.docker.internal:host-gateway",
      );
    }
  });

  it("publishes only the web app", () => {
    expect(services.web.ports).toHaveLength(1);
    expect(services.worker.ports).toBeUndefined();
    expect(services.init.ports).toBeUndefined();
  });

  it("runs one published image for all three", () => {
    const images = new Set(Object.values(services).map((s) => s.image));
    expect(images.size).toBe(1);
    expect([...images][0]).toMatch(/^ghcr\.io\/[\w.-]+\/[\w.-]+:/);
  });
});

describe("state on one volume", () => {
  it("declares exactly one volume", () => {
    // Issue #1 leaves the backup strategy open; one volume is the constraint that keeps
    // every later choice a copy rather than a migration.
    expect(Object.keys(compose.volumes)).toEqual(["lifeops-data"]);
  });

  it("mounts that volume, and only that volume, into every service", () => {
    for (const [name, service] of Object.entries(services)) {
      expect(service.volumes, name).toEqual(["lifeops-data:/data"]);
    }
  });

  it("puts the database on it, whatever the operator's .env says", () => {
    // `environment` wins over `env_file`, deliberately: where state lives inside the
    // container is a packaging fact. An operator who could move it off the volume could
    // silently make "back up one volume" false.
    for (const [name, service] of Object.entries(services)) {
      expect(service.environment.LIFEOPS_DB_PATH, name).toMatch(/^\/data\//);
    }
  });
});

describe("the documented configuration", () => {
  const envExample = read(".env.example");

  /** Every name the file mentions, whether it is set or shown commented out. */
  const documented = new Set(
    [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );

  /** Only the ones actually set — what an operator gets by copying the file unedited. */
  const defaults: Env = Object.fromEntries(
    [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]),
  );

  it("names every variable the app reads", () => {
    // "An operator following the documented setup knows every variable they must set."
    // Read out of config.ts rather than listed here, so a new variable fails this test
    // instead of being undocumented.
    const readByApp = new Set(
      read("src/config.ts").match(/\b(?:LIFEOPS|LLM|WORKER|EXTRACTION)_[A-Z0-9_]+\b/g),
    );
    expect(readByApp.size).toBeGreaterThan(0);
    for (const name of readByApp) {
      expect(documented, `${name} is undocumented`).toContain(name);
    }
  });

  it("boots as shipped, once Compose has pinned the database path", () => {
    // The strongest version of "documented configuration works": the file's own values,
    // under the same precedence Compose applies, are a valid config.
    const config = loadConfig({ ...defaults, ...services.init.environment });

    expect(config.dbPath).toBe("/data/lifeops.db");
    expect(config.llm.model).not.toBe("");
  });

  it("needs no secret, and says so", () => {
    // Invariant 4's practical dividend: no account, no key, no rotation.
    expect(documented).toContain("LLM_API_KEY");
    expect(defaults.LLM_API_KEY).toBe("");
    expect(loadConfig({ ...defaults, ...services.init.environment }).llm.apiKey)
      .toBeUndefined();
    expect(envExample).toMatch(/no secret/i);
  });

  it("does not hand a container an endpoint of localhost", () => {
    // It would pass config validation and fail at the first extraction, which is the whole
    // trap. The default points at the Docker host instead.
    expect(defaults.LLM_BASE_URL).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(defaults.LLM_BASE_URL).toContain("/v1");
  });
});

describe("the image", () => {
  const dockerfile = read("Dockerfile");
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

  it("carries the migrations it has to apply at runtime", () => {
    // drizzle-kit is a devDependency and is not in the image; the migrator reads this SQL.
    // Without it the stack starts against a database with no tables.
    expect(runtimeStage).toMatch(/^COPY drizzle /m);
  });

  it("carries the source the worker and CLIs run from", () => {
    expect(runtimeStage).toMatch(/^COPY src /m);
    expect(runtimeStage).toContain("tsconfig.json");
  });

  it("does not run as root", () => {
    expect(runtimeStage).toMatch(/^USER node$/m);
  });

  it("keeps the toolchain out of what ships", () => {
    // Compilers belong to the stage that builds better-sqlite3, not to the image an
    // operator runs on a Pi.
    expect(runtimeStage).not.toContain("apt-get");
    expect(dockerfile).toContain("npm prune --omit=dev");
  });

  it("creates the state directory so a named volume inherits its ownership", () => {
    // A root-owned volume mounted under a non-root user is a stack that starts and cannot
    // write, which reads as a database error rather than a permissions one.
    expect(runtimeStage).toMatch(/mkdir -p \/data[\s\S]*chown node:node \/data/);
  });
});

describe("publishing", () => {
  const workflow = parse(read(".github/workflows/publish.yml")) as {
    on: { push: { branches: string[] }; pull_request: unknown };
    jobs: Record<
      string,
      {
        permissions: Record<string, string>;
        steps: {
          uses?: string;
          if?: string;
          with?: Record<string, string>;
        }[];
      }
    >;
  };
  const steps = workflow.jobs.image.steps;
  const buildStep = steps.find((s) => s.uses?.startsWith("docker/build-push-action"));

  it("builds for both architectures", () => {
    // arm64 is the sizing target (a Pi-class box); amd64 is what most operators have spare.
    expect(buildStep?.with?.platforms).toBe("linux/amd64,linux/arm64");
  });

  it("builds on pull requests without pushing, and pushes from main", () => {
    // Building on PRs is what keeps "runs on arm64" continuously true rather than
    // discovered on the operator's hardware.
    expect(workflow.on.push.branches).toContain("main");
    expect(workflow.on).toHaveProperty("pull_request");
    expect(buildStep?.with?.push).toBe("${{ github.event_name == 'push' }}");
  });

  it("publishes to GHCR, and only asks for a token when it is going to", () => {
    const login = steps.find((s) => s.uses?.startsWith("docker/login-action"));
    expect(login?.with?.registry).toBe("ghcr.io");
    expect(login?.if).toBe("github.event_name == 'push'");

    const meta = steps.find((s) => s.uses?.startsWith("docker/metadata-action"));
    expect(meta?.with?.images).toContain("ghcr.io/");
    expect(workflow.jobs.image.permissions.packages).toBe("write");
  });
});
