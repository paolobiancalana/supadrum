import type {
  CredentialBundle,
  ProjectConfig,
  SupadrumConfig
} from "./config.js";
import type { ExecutionResult, Job, Session } from "./domain.js";
import { SqliteStore } from "./store.js";

export type ResolvedCredentials = Record<keyof CredentialBundle, string>;

export interface CredentialProvider {
  resolve(
    project: string,
    config: ProjectConfig
  ): Promise<ResolvedCredentials>;
}

export interface Executor {
  mount(
    project: string,
    config: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<void>;
  drain(): Promise<void>;
  unmount(): Promise<void>;
  execute(
    job: Job,
    config: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult>;
}

export class MissingCredentialsError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing credentials: ${missing.join(", ")}`);
    this.name = "MissingCredentialsError";
  }
}

interface RunnerOptions {
  readonly now?: () => Date;
  readonly leaseMs?: number;
}

export class Runner {
  readonly #store: SqliteStore;
  readonly #config: SupadrumConfig;
  readonly #credentials: CredentialProvider;
  readonly #executor: Executor;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  #activeProject: string | null = null;
  #activeSession: string | null = null;
  #activeCredentials: ResolvedCredentials | null = null;
  #activeCredentialMode: "dry-run" | "live" | null = null;
  #activeProjectConfig: ProjectConfig | null = null;

  constructor(
    store: SqliteStore,
    config: SupadrumConfig,
    credentials: CredentialProvider,
    executor: Executor,
    options: RunnerOptions = {}
  ) {
    this.#store = store;
    this.#config = config;
    this.#credentials = credentials;
    this.#executor = executor;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? 60_000;
  }

  async tick(): Promise<Job | null> {
    this.#store.expireStaleJobs(this.#now());
    const activeSession = this.#store.findOpenSession();
    if (activeSession) {
      await this.#resumeSession(activeSession);
      return this.#runSession(activeSession.id);
    }

    for (const scheduled of this.#store.listSchedulable()) {
      let candidate = scheduled;
      const project = this.#config.projects[candidate.project];
      if (!project) {
        this.#store.transition(candidate.id, "failed", null, {
          error: `Unknown project: ${candidate.project}`
        });
        continue;
      }
      if (!project.capabilities.includes(candidate.capability)) {
        this.#store.transition(candidate.id, "failed", null, {
          error: `Project ${candidate.project} lacks ${candidate.capability}`
        });
        continue;
      }
      if (
        (candidate.operation === "migration.plan" ||
          candidate.operation === "migration.baseline" ||
          candidate.operation === "migration.apply" ||
          (candidate.operation === "session.open" &&
            candidate.capability === "migrations")) &&
        project.migrations !== "owner"
      ) {
        const owner = Object.entries(this.#config.projects).find(
          ([, configured]) =>
            configured.chamber === project.chamber &&
            configured.migrations === "owner"
        )?.[0];
        this.#store.transition(candidate.id, "failed", null, {
          error: owner
            ? `Migration owner for chamber ${project.chamber} is ${owner}`
            : `Chamber ${project.chamber} has no migration owner`
        });
        continue;
      }
      if (candidate.requires_approval && candidate.approved_at === null) {
        if (this.#config.approval_mode === "manual") {
          this.#store.transition(candidate.id, "waiting_approval");
          continue;
        }
        candidate = this.#store.approve(
          candidate.id,
          "policy:automatic"
        );
      }

      let credentials: ResolvedCredentials;
      try {
        credentials =
          this.#activeProject === project.chamber &&
          this.#activeCredentials &&
          this.#activeCredentialMode === project.mode
            ? this.#activeCredentials
            : await this.#credentials.resolve(
                candidate.project,
                project
              );
      } catch (error) {
        if (error instanceof MissingCredentialsError) {
          this.#store.transition(candidate.id, "waiting_credentials", {
            missing: error.missing
          });
          continue;
        }
        this.#store.transition(candidate.id, "failed", null, {
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      const leaseExpiresAt = new Date(
        this.#now().getTime() + this.#leaseMs
      ).toISOString();
      let job = this.#store.grantIfSchedulable(
        candidate.id,
        leaseExpiresAt
      );
      if (!job) continue;

      try {
        await this.#mount(job.project, project, credentials);
        job = this.#store.transition(job.id, "running");
        if (job.operation === "session.open") {
          const session = this.#store.activateSession(
            String(job.payload.session_id)
          );
          this.#activeSession = session.id;
          this.#activeCredentials = credentials;
          this.#activeProjectConfig = project;
          job = this.#store.transition(job.id, "verifying", {
            session_id: session.id,
            expires_at: session.expires_at
          });
          return this.#store.transition(job.id, "completed", null, {
            lease_expires_at: null,
            result: {
              output: {
                session_id: session.id,
                expires_at: session.expires_at
              },
              verification: { active: true }
            }
          });
        }
        const result = await this.#executor.execute(
          job,
          project,
          credentials
        );
        job = this.#store.transition(job.id, "verifying", {
          verification: result.verification
        });
        job = this.#store.transition(job.id, "completed", null, {
          lease_expires_at: null,
          result
        });
      } catch (error) {
        job = this.#store.transition(job.id, "failed", null, {
          lease_expires_at: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      await this.#settleMount();
      return job;
    }

    await this.#unmount();
    return null;
  }

  async close(): Promise<void> {
    await this.#unmount();
  }

  async #mount(
    projectName: string,
    project: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<void> {
    if (this.#activeProject === project.chamber) {
      if (this.#activeCredentialMode !== project.mode) {
        await this.#executor.mount(
          project.chamber,
          project,
          credentials
        );
      }
      this.#activeCredentials = credentials;
      this.#activeCredentialMode = project.mode;
      return;
    }
    await this.#unmount();
    await this.#executor.mount(project.chamber, project, credentials);
    this.#activeProject = project.chamber;
    this.#activeCredentials = credentials;
    this.#activeCredentialMode = project.mode;
  }

  async #settleMount(): Promise<void> {
    const next = this.#store.listSchedulable().find((job) => {
      if (
        this.#config.approval_mode === "manual" &&
        job.requires_approval &&
        job.approved_at === null
      ) {
        return false;
      }
      const project = this.#config.projects[job.project];
      return project?.capabilities.includes(job.capability) === true;
    });
    const nextChamber = next
      ? this.#config.projects[next.project]?.chamber
      : undefined;
    if (!next || nextChamber !== this.#activeProject) {
      await this.#unmount();
    }
  }

  async #unmount(): Promise<void> {
    if (this.#activeProject === null) return;
    await this.#executor.drain();
    await this.#executor.unmount();
    this.#activeProject = null;
    this.#activeSession = null;
    this.#activeCredentials = null;
    this.#activeCredentialMode = null;
    this.#activeProjectConfig = null;
  }

  async #resumeSession(session: Session): Promise<void> {
    if (session.status === "closing" || this.#isExpired(session)) return;
    if (this.#activeSession === session.id) return;
    const project = this.#config.projects[session.project];
    if (!project) {
      this.#store.finishSession(session.id, "lease_expired");
      return;
    }
    const credentials = await this.#credentials.resolve(
      session.project,
      project
    );
    await this.#mount(session.project, project, credentials);
    this.#activeSession = session.id;
    this.#activeCredentials = credentials;
    this.#activeProjectConfig = project;
  }

  async #runSession(sessionId: string): Promise<Job | null> {
    const session = this.#store.getSession(sessionId);
    if (session.status === "closing" || this.#isExpired(session)) {
      const status =
        session.status === "closing" ? "closed" : "lease_expired";
      await this.#unmount();
      this.#store.finishSession(sessionId, status);
      return null;
    }

    const job = this.#store.listSessionJobs(sessionId)[0];
    if (!job) return null;
    const project = this.#activeProjectConfig;
    const credentials = this.#activeCredentials;
    if (!project || !credentials) {
      throw new Error(`Session chamber is not mounted: ${sessionId}`);
    }

    let current = this.#store.transition(job.id, "granted", null, {
      lease_expires_at: session.expires_at
    });
    try {
      current = this.#store.transition(current.id, "running");
      const result = await this.#executor.execute(
        current,
        project,
        credentials
      );
      current = this.#store.transition(current.id, "verifying", {
        verification: result.verification
      });
      current = this.#store.transition(current.id, "completed", null, {
        lease_expires_at: null,
        result
      });
      this.#store.heartbeatSession(sessionId);
      return current;
    } catch (error) {
      return this.#store.transition(current.id, "failed", null, {
        lease_expires_at: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #isExpired(session: Session): boolean {
    return (
      session.expires_at !== null &&
      new Date(session.expires_at).getTime() <= this.#now().getTime()
    );
  }
}
