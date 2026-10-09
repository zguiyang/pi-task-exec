import { PassThrough, type Readable, type Writable } from "node:stream";

export interface InteractionChoice<T> { value: T; label: string; hint?: string }
export interface Interaction {
  select<T>(question: string, choices: readonly InteractionChoice<T>[], defaultValue?: T): Promise<T | null>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}
export interface ArrowInteractionOptions { input: Readable; output: Writable }

/** Lazy loading keeps prompt dependencies out of stdio MCP startup. */
export function createArrowInteraction({ input, output }: ArrowInteractionOptions): Interaction {
  const select = async <T>(question: string, choices: readonly InteractionChoice<T>[], defaultValue?: T): Promise<T | null> => {
    if (!choices.length) return null;
    const terminal = output as Writable & { isTTY?: boolean; columns?: number };
    if (terminal.isTTY && terminal.columns !== undefined && terminal.columns < 1) {
      const error = new Error("Interactive prompt requires a terminal with a nonzero width");
      Object.assign(error, { code: "interaction_failed" });
      throw error;
    }
    const raw = input as Readable & { isRaw?: boolean; setRawMode?: (enabled: boolean) => unknown };
    const wasRaw = raw.isRaw === true;
    const wasPaused = input.isPaused();
    const wasFlowing = input.readableFlowing === true;
    // Keep source stream errors outside readline's unhandled-error forwarding.
    const promptInput = new PassThrough();
    const controller = new AbortController();
    let streamError: Error | undefined;
    let completed = false;
    const fail = (error: Error): void => { streamError = error; controller.abort(); };
    const end = (): void => fail(new Error("Terminal input closed before the prompt completed"));
    input.once("error", fail);
    output.once("error", fail);
    const interrupt = (): void => fail(new Error("Interactive prompt interrupted"));
    input.once("end", end);
    input.once("close", end);
    process.once("SIGTERM", interrupt);
    process.once("SIGINT", interrupt);
    try {
      raw.setRawMode?.(true);
      input.pipe(promptInput);
      const prompts = await import("@clack/prompts");
      // Numeric values preserve the injectable interface's arbitrary value types.
      const initial = choices.findIndex((choice) => Object.is(choice.value, defaultValue));
      const result = await prompts.select({
        message: question,
        options: choices.map((choice, value) => ({ value, label: choice.label, ...(choice.hint ? { hint: choice.hint } : {}) })),
        initialValue: Math.max(0, initial), input: promptInput, output, signal: controller.signal,
      });
      if (streamError) throw streamError;
      completed = true;
      return prompts.isCancel(result) ? null : choices[result]?.value ?? null;
    } catch (error) {
      const failure = new Error(`Interactive prompt failed: ${streamError?.message ?? (error instanceof Error ? error.message : String(error))}`);
      Object.assign(failure, { code: "interaction_failed" });
      throw failure;
    } finally {
      if (!completed) controller.abort();
      input.unpipe(promptInput);
      promptInput.destroy();
      input.removeListener("error", fail);
      output.removeListener("error", fail);
      input.removeListener("end", end);
      input.removeListener("close", end);
      process.removeListener("SIGTERM", interrupt);
      process.removeListener("SIGINT", interrupt);
      let restorationFailed = false;
      try { raw.setRawMode?.(wasRaw); } catch { restorationFailed = true; }
      if (wasPaused || !wasFlowing) input.pause();
      else input.resume();
      if (!output.destroyed) {
        try { output.write("\u001b[?25h"); } catch { restorationFailed = true; }
      }
      if (completed && restorationFailed) {
        const error = new Error("Interactive prompt failed to restore the terminal state");
        Object.assign(error, { code: "interaction_failed" });
        throw error;
      }
    }
  };
  return {
    select,
    confirm: async (question, defaultValue = false) => (await select(question, [{ value: true, label: "Yes" }, { value: false, label: "No" }], defaultValue)) === true,
  };
}
