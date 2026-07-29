import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ReadlinePrompter } from "../src/prompts/readline-prompter.js";

function terminal(): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY: true });
}

describe("interactive prompt adapter", () => {
  it("reads ordinary visible input and rejects input without a TTY", async () => {
    const input = terminal();
    const output = terminal();
    const prompter = new ReadlinePrompter(input, output);
    const answer = prompter.input("Workspace");
    input.write("  ./repo  \n");
    await expect(answer).resolves.toBe("./repo");

    const headless = new ReadlinePrompter(new PassThrough(), new PassThrough());
    await expect(headless.input("Unavailable")).rejects.toThrow("unavailable");
    await expect(headless.secret("Unavailable")).rejects.toThrow("unavailable");
  });

  it("captures an activation URL without echoing the one-time secret", async () => {
    const input = terminal();
    const output = terminal();
    let visible = "";
    output.on("data", (chunk) => (visible += String(chunk)));
    const prompter = new ReadlinePrompter(input, output);

    const result = prompter.secret("Activation URL");
    input.write("https://shared.hivemnd.cloud/eigen/enroll?token=secret\n");

    await expect(result).resolves.toContain("token=secret");
    expect(visible).toBe("Activation URL: \n");
    expect(visible).not.toContain("secret");
  });

  it("re-prompts confirmations until the answer is yes or no", async () => {
    const input = terminal();
    const output = terminal();
    let visible = "";
    output.on("data", (chunk) => (visible += String(chunk)));
    const prompter = new ReadlinePrompter(input, output);

    const result = prompter.confirm("Continue?", true);
    input.write("perhaps\n");
    setTimeout(() => input.write("yes\n"), 5);

    await expect(result).resolves.toBe(true);
    expect(visible).toContain("Please answer yes or no.");
  });

  it.each([
    { answer: "", fallback: false, expected: false },
    { answer: "n", fallback: true, expected: false },
    { answer: "YES", fallback: false, expected: true },
  ])(
    "accepts confirmation answer '$answer'",
    async ({ answer, fallback, expected }) => {
      const input = terminal();
      const output = terminal();
      const prompter = new ReadlinePrompter(input, output);
      const result = prompter.confirm("Continue?", fallback);
      input.write(`${answer}\n`);
      await expect(result).resolves.toBe(expected);
    },
  );
});
