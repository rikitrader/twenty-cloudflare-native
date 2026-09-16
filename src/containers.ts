/** Retired compatibility exports. Production no longer deploys containers. */
import { Container } from "./container-compat";
import type { Env } from "./types";

export const AGENT_PORT = 2021;
export const JOB_EXECUTOR_PORT = 2022;
export const JOB_GATEWAY_HOST = "twenty-queue.internal";
export const EVENT_GATEWAY_HOST = "twenty-events.internal";

export class TwentyContainer extends Container<Env> {}
export class TwentyServer extends Container<Env> {}
export class TwentyWorker extends Container<Env> {}
export class TwentyBackup extends Container<Env> {}
