import { StringDecoder } from "node:string_decoder";

export class CredentialSetupCancelledError extends Error {
  constructor() {
    super("Credential setup cancelled");
    this.name = "CredentialSetupCancelledError";
  }
}

export async function readMaskedSecret(
  label: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): Promise<string> {
  if (
    !input.isTTY ||
    !output.isTTY ||
    typeof input.setRawMode !== "function"
  ) {
    throw new Error("Interactive credential entry requires a TTY");
  }

  const previousRawMode = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;
  const decoder = new StringDecoder("utf8");
  const characters: string[] = [];
  let terminalSequence:
    | "none"
    | "escape"
    | "csi"
    | "string"
    | "string-escape" = "none";

  output.write(label.padEnd(18));
  input.setRawMode(true);

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      try {
        input.setRawMode(previousRawMode);
      } finally {
        if (!wasFlowing) input.pause();
        output.write("\n");
      }
    };

    const finish = (
      outcome:
        | { readonly value: string }
        | { readonly error: Error }
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("error" in outcome) {
        reject(outcome.error);
      } else {
        resolve(outcome.value);
      }
    };

    const consume = (text: string): void => {
      for (const character of text) {
        if (terminalSequence === "escape") {
          terminalSequence =
            character === "["
              ? "csi"
              : "P]^_".includes(character)
                ? "string"
                : "none";
          continue;
        }
        if (terminalSequence === "csi") {
          const code = character.codePointAt(0) ?? 0;
          if (code >= 0x40 && code <= 0x7e) {
            terminalSequence = "none";
          }
          continue;
        }
        if (terminalSequence === "string") {
          if (character === "\x07") terminalSequence = "none";
          if (character === "\x1b") {
            terminalSequence = "string-escape";
          }
          continue;
        }
        if (terminalSequence === "string-escape") {
          terminalSequence = character === "\\" ? "none" : "string";
          continue;
        }
        if (character === "\x1b") {
          terminalSequence = "escape";
          continue;
        }
        if (character === "\x9b") {
          terminalSequence = "csi";
          continue;
        }
        if (character === "\r" || character === "\n") {
          finish({ value: characters.join("") });
          return;
        }
        if (character === "\x03" || character === "\x04") {
          finish({ error: new CredentialSetupCancelledError() });
          return;
        }
        if (character === "\x7f" || character === "\b") {
          if (characters.pop() !== undefined) output.write("\b \b");
          continue;
        }
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) continue;
        characters.push(character);
        output.write("•");
      }
    };

    function onData(chunk: Buffer | string): void {
      consume(
        typeof chunk === "string"
          ? chunk
          : decoder.write(chunk)
      );
    }

    function onEnd(): void {
      finish({ error: new CredentialSetupCancelledError() });
    }

    function onError(): void {
      finish({ error: new Error("Credential input failed") });
    }

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}
