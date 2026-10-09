import { styleText } from "node:util";

export function highlight(text: string, tone: "cyan" | "green" | "yellow" | "red", color = false): string {
  return color ? styleText(tone, text, { validateStream: false }) : text;
}
