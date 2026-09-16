/**
 * Compatibility types for the retired Containers runtime.
 * Production no longer binds or invokes containers; native D1 routes are
 * authoritative. These no-op primitives keep historical canary/release code
 * type-safe while it is being retired without pulling the Containers SDK into
 * the Worker bundle.
 */
export class Container<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  protected envVars: Record<string, string> = {};
  static outboundByHost: Record<string, unknown> = {};

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async start(): Promise<void> {
    throw new Error("Container runtime retired; use Cloudflare-native queues and D1");
  }

  async destroy(): Promise<void> {}

  async quiesce(): Promise<void> {
    await this.destroy();
  }

  async warm(): Promise<void> {
    await this.start();
  }

  async onStart(): Promise<void> {}
  onStop(): void {}

  async startAndWaitForPorts(_ports: number | number[], _options?: unknown): Promise<void> {
    await this.start();
  }

  containerFetch(_request: Request, _port?: number): Promise<Response> {
    return Promise.resolve(new Response("Container runtime retired", { status: 410 }));
  }

  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(new Response("Container runtime retired", { status: 410 }));
  }
}

type ContainerStub = {
  fetch(request: Request): Promise<Response>;
  warm(): Promise<void>;
  destroy(): Promise<void>;
  quiesce(): Promise<void>;
};

export function getContainer(_namespace: unknown, _name: string): ContainerStub {
  return {
    fetch: async () => new Response("Container runtime retired", { status: 410 }),
    warm: async () => {},
    destroy: async () => {},
    quiesce: async () => {},
  };
}

export function getRandom(namespace: unknown, _replicas: number): ContainerStub {
  return getContainer(namespace, "native-retired");
}

export const ContainerProxy = class {};
