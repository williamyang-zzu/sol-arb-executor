import { rename, writeFile } from "node:fs/promises";
import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";

export function computeBudgetInstructions(
  computeUnitLimit: number,
  computeUnitPriceMicroLamports: number,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPriceMicroLamports,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
  ];
}

export function sanitizedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /((?:[?&]|\b)(?:api-key|apikey|access_token|token|key)=)[^&\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]");
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

export function scheduledBroadcastTimestamp(
  scheduleStartedAtMs: number,
  firstOrdinal: number,
  ordinal: number,
  intervalMs: number,
): number {
  return scheduleStartedAtMs + (ordinal - firstOrdinal) * intervalMs;
}

export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Concurrency limit must be a positive safe integer");
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolvePromise) => {
      this.waiters.push(() => {
        this.active += 1;
        resolvePromise();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

export class AsyncManifestWriter {
  private dirty = false;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly path: string,
    private readonly render: () => string,
  ) {}

  request(): void {
    this.dirty = true;
    if (!this.writing) this.writing = this.drain();
  }

  async flush(): Promise<void> {
    this.request();
    while (this.writing) await this.writing;
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        const temporaryPath = `${this.path}.tmp`;
        await writeFile(temporaryPath, this.render());
        await rename(temporaryPath, this.path);
      }
    } finally {
      this.writing = null;
      if (this.dirty) this.writing = this.drain();
    }
  }
}
