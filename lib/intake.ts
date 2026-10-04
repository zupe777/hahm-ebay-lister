// Process selected photo files two at a time. Each failure is reported as
// "filename: reason" with a meaningful reason. A failure that will repeat for
// every remaining file (e.g. browser storage full) stops the import and says
// how many photos were not added.

import { describeError } from "./storage-health";

export interface ProcessOptions {
  describe?: (e: unknown) => string;
  stopOn?: (e: unknown) => boolean;
}

export async function processFiles<T>(
  files: File[],
  limit: number,
  process: (file: File) => Promise<T>,
  opts: ProcessOptions = {},
): Promise<{ values: T[]; errors: string[]; notProcessed: number }> {
  const describe = opts.describe ?? describeError;
  const selected = files.slice(0, Math.max(0, limit));
  const results: (T | undefined)[] = new Array(selected.length);
  const errors: string[] = [];
  let cursor = 0;
  let stop: unknown;
  let started = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, selected.length) }, async () => {
      while (cursor < selected.length && stop === undefined) {
        const i = cursor++;
        started++;
        try {
          results[i] = await process(selected[i]);
        } catch (e) {
          errors.push(`${selected[i].name}: ${describe(e)}`);
          if (opts.stopOn?.(e) && stop === undefined) stop = e;
        }
      }
    }),
  );
  const notProcessed = selected.length - started;
  if (notProcessed > 0)
    errors.push(
      `${notProcessed} more photo${notProcessed === 1 ? " was" : "s were"} not added: ${describe(stop)}`,
    );
  if (files.length > selected.length)
    errors.push(
      `${files.length - selected.length} photos exceed the batch limit and were not added.`,
    );
  return {
    values: results.filter((v): v is T => v !== undefined),
    errors,
    notProcessed,
  };
}
