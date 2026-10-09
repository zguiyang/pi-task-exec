export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};
