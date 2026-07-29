import { createInterface } from "node:readline/promises";
import { Writable, type Readable } from "node:stream";
import type { PromptPort } from "../domain.js";

export class ReadlinePrompter implements PromptPort {
  readonly interactive: boolean;

  constructor(
    private readonly inputStream: Readable & { readonly isTTY?: boolean },
    private readonly outputStream: Writable & { readonly isTTY?: boolean },
  ) {
    this.interactive =
      inputStream.isTTY === true && outputStream.isTTY === true;
  }

  async input(message: string): Promise<string> {
    if (!this.interactive) throw new Error("Interactive input is unavailable");
    const readline = createInterface({
      input: this.inputStream,
      output: this.outputStream,
    });
    try {
      return (await readline.question(`${message}: `)).trim();
    } finally {
      readline.close();
    }
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    for (;;) {
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";
      const answer = (await this.input(`${message} ${suffix}`)).toLowerCase();
      if (answer === "") return defaultValue;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
      this.outputStream.write("Please answer yes or no.\n");
    }
  }

  async secret(message: string): Promise<string> {
    if (!this.interactive) throw new Error("Interactive input is unavailable");
    this.outputStream.write(`${message}: `);
    const muted = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback();
      },
    });
    const readline = createInterface({
      input: this.inputStream,
      output: muted,
      terminal: true,
    });
    try {
      return (await readline.question("")).trim();
    } finally {
      readline.close();
      this.outputStream.write("\n");
    }
  }
}
