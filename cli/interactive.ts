import { PassThrough, type Readable, type Writable } from "node:stream";

export interface InteractionChoice<T> { value: T; label: string; hint?: string }
export interface Interaction {
  select<T>(question: string, choices: readonly InteractionChoice<T>[], defaultValue?: T): Promise<T | null>;
  /**
   * Keyboard-only multi-select (space toggles, arrows move, enter submits).
   * Resolves `null` when cancelled, or the chosen values in choice order —
   * an explicit "nothing selected" submit resolves to `[]`.
   */
  multiSelect<T>(question: string, choices: readonly InteractionChoice<T>[], defaultValues?: readonly T[]): Promise<T[] | null>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}
export interface ArrowInteractionOptions { input: Readable; output: Writable }

/** Streams/signals shared by one @clack/prompts prompt inside a managed session. */
interface PromptSession { input: PassThrough; output: Writable; signal: AbortSignal }

/** Lazy loading keeps prompt dependencies out of stdio MCP startup. */
async function runPromptSession<R>(
  { input, output }: ArrowInteractionOptions,
  run: (session: PromptSession) => Promise<R>,
): Promise<R> {
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
    const result = await run({ input: promptInput, output, signal: controller.signal });
    if (streamError) throw streamError;
    completed = true;
    return result;
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
}

export function createArrowInteraction({ input, output }: ArrowInteractionOptions): Interaction {
  const io: ArrowInteractionOptions = { input, output };
  // Numeric values preserve the injectable interface's arbitrary value types.
  const optionsFor = <T>(choices: readonly InteractionChoice<T>[]) =>
    choices.map((choice, value) => ({ value, label: choice.label, ...(choice.hint ? { hint: choice.hint } : {}) }));

  const select = async <T>(question: string, choices: readonly InteractionChoice<T>[], defaultValue?: T): Promise<T | null> => {
    if (!choices.length) return null;
    return runPromptSession(io, async (session) => {
      const prompts = await import("@clack/prompts");
      const initial = choices.findIndex((choice) => Object.is(choice.value, defaultValue));
      const result = await prompts.select({
        message: question,
        options: optionsFor(choices),
        initialValue: Math.max(0, initial),
        input: session.input,
        output: session.output,
        signal: session.signal,
      });
      return prompts.isCancel(result) ? null : choices[result]?.value ?? null;
    });
  };

  const multiSelect = async <T>(
    question: string,
    choices: readonly InteractionChoice<T>[],
    defaultValues?: readonly T[],
  ): Promise<T[] | null> => {
    if (!choices.length) return null;
    return runPromptSession(io, async (session) => {
      const prompts = await import("@clack/prompts");
      const wanted = defaultValues ?? [];
      const initialValues = choices.flatMap((choice, index) => (wanted.some((value) => Object.is(value, choice.value)) ? [index] : []));
      const result = await prompts.multiselect({
        message: question,
        options: optionsFor(choices),
        initialValues,
        // An empty submit is a legitimate answer; null means cancelled only.
        required: false,
        input: session.input,
        output: session.output,
        signal: session.signal,
      });
      if (prompts.isCancel(result)) return null;
      const picked = new Set(result);
      return choices.filter((_choice, index) => picked.has(index)).map((choice) => choice.value);
    });
  };

  return {
    select,
    multiSelect,
    confirm: async (question, defaultValue = false) => (await select(question, [{ value: true, label: "Yes" }, { value: false, label: "No" }], defaultValue)) === true,
  };
}
