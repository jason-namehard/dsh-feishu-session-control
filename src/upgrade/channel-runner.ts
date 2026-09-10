import { randomUUID } from 'node:crypto';

export interface ChannelUpdateRoute {
  chatId: string;
  threadId?: string;
  requesterId: string;
}

export interface ChannelUpdateRunResult {
  id: string;
  targetVersion: string;
  route: ChannelUpdateRoute;
  status: 'succeeded' | 'failed';
  error?: string;
}

export interface InProcessChannelUpdaterOptions {
  run(targetVersion: string): Promise<void>;
  complete(result: ChannelUpdateRunResult): Promise<void>;
  id?: () => string;
}

export type StartChannelUpdateResult =
  | { accepted: true; id: string }
  | { accepted: false; reason: 'busy'; id: string };

/** Runs one confirmed channel upgrade inside the active DSH process. */
export class InProcessChannelUpdater {
  private readonly id: () => string;
  private activeId: string | undefined;

  constructor(private readonly options: InProcessChannelUpdaterOptions) {
    this.id = options.id ?? randomUUID;
  }

  async start(
    targetVersion: string,
    route: ChannelUpdateRoute,
  ): Promise<StartChannelUpdateResult> {
    if (this.activeId) return { accepted: false, reason: 'busy', id: this.activeId };
    const id = this.id();
    this.activeId = id;
    void this.execute({ id, targetVersion, route });
    return { accepted: true, id };
  }

  private async execute(input: {
    id: string;
    targetVersion: string;
    route: ChannelUpdateRoute;
  }): Promise<void> {
    let result: ChannelUpdateRunResult;
    try {
      await this.options.run(input.targetVersion);
      result = { ...input, status: 'succeeded' };
    } catch (error) {
      result = {
        ...input,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeId = undefined;
    }
    await this.options.complete(result).catch(() => undefined);
  }
}
