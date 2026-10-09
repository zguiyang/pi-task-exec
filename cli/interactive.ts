import { emitKeypressEvents } from "node:readline";

export interface InteractionChoice<T> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Injectable interactive seam. The CLI never calls `readline` directly; the
 * real terminal implementation and the tests both satisfy this interface, so
 * approval/cancellation behavior is testable without a TTY.
 */
export interface Interaction {
  /** Resolve to the chosen value, or null when the user cancels (Esc/Ctrl-C). */
  select<T>(question: string, choices: readonly InteractionChoice<T>[], defaultValue?: T): Promise<T | null>;
  /** Resolve true only for an explicit Yes; No or cancel resolves false. */
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}

export interface ArrowInteractionOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

type KeypressListener = (_character: string, key: { name?: string; ctrl?: boolean } | undefined) => void;

interface RawCapableInput {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume(): void;
  on(event: "keypress", listener: KeypressListener): void;
  removeListener(event: "keypress", listener: KeypressListener): void;
}

const REQUEST_UP = (lines: number): string => `\u001b[${lines}A`;
const CLEAR_LINE = "\u001b[2K";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

/**
 * Minimal arrow-key selector. Renders the choices, moves the pointer with
 * Up/Down (and j/k), accepts with Enter, and cancels with Esc/Ctrl-C/q.
 * Cancellation never mutates anything; callers treat `null` as a no-op.
 */
export function createArrowInteraction(options: ArrowInteractionOptions): Interaction {
  const { input, output } = options;
  const rawInput = input as unknown as RawCapableInput;

  const select = <T>(question: string, choices: readonly InteractionChoice<T>[], defaultValue?: T): Promise<T | null> => {
    if (choices.length === 0) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      const initial = choices.findIndex((choice) => choice.value === defaultValue);
      let index = initial >= 0 ? initial : 0;
      let settled = false;
      let lineCount = 0;
      const wasRaw = rawInput.isRaw === true;

      const render = (first: boolean): void => {
        if (!first && lineCount > 0) output.write(REQUEST_UP(lineCount));
        const lines = [`? ${question}`];
        choices.forEach((choice, choiceIndex) => {
          const pointer = choiceIndex === index ? "❯" : " ";
          const hint = choice.hint ? `  ${choice.hint}` : "";
          lines.push(`  ${pointer} ${choice.label}${hint}`);
        });
        output.write(`${lines.map((line) => `${CLEAR_LINE}${line}`).join("\n")}\n`);
        lineCount = lines.length;
      };

      const cleanup = (): void => {
        input.removeListener("keypress", onKeypress);
        if (typeof rawInput.setRawMode === "function") rawInput.setRawMode(wasRaw);
        output.write(SHOW_CURSOR);
      };

      const finish = (value: T | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onKeypress: KeypressListener = (_character, key): void => {
        const name = key?.name;
        if (name === "up" || name === "k") {
          index = (index - 1 + choices.length) % choices.length;
          render(false);
        } else if (name === "down" || name === "j") {
          index = (index + 1) % choices.length;
          render(false);
        } else if (name === "return" || name === "enter") {
          finish(choices[index]?.value ?? null);
        } else if (name === "escape" || name === "q" || (key?.ctrl === true && name === "c")) {
          finish(null);
        }
      };

      emitKeypressEvents(input);
      if (typeof rawInput.setRawMode === "function") rawInput.setRawMode(true);
      input.resume();
      output.write(HIDE_CURSOR);
      render(true);
      input.on("keypress", onKeypress);
    });
  };

  const confirm = (question: string, defaultValue = false): Promise<boolean> =>
    select(
      question,
      [
        { value: true, label: "Yes" },
        { value: false, label: "No" },
      ],
      defaultValue,
    ).then((value) => value === true);

  return { select, confirm };
}
