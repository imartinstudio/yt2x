const canUseColor = (): boolean => process.stderr.isTTY === true && process.env.NO_COLOR === undefined;

const style = (code: string, text: string): string =>
  canUseColor() ? `\u001b[${code}m${text}\u001b[0m` : text;

export const cliBold = (text: string): string => style("1", text);
export const cliRed = (text: string): string => style("31;1", text);
export const cliYellow = (text: string): string => style("33;1", text);
export const cliCyan = (text: string): string => style("36;1", text);

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const linesFrom = (input: string | string[], maxLines: number): string[] => {
  const rawLines = Array.isArray(input) ? input : input.split(/\r?\n/);
  return rawLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
};

export const printCliErrorBlock = (input: {
  command: string;
  subject?: string;
  reason: string | string[];
  details?: string;
  hints?: string[];
  retryCommand?: string;
}): void => {
  if (process.stderr.isTTY === true) {
    process.stderr.write("\n");
  }

  const target = input.subject !== undefined ? ` for ${input.subject}` : "";
  console.error(cliRed(`ERROR yt2x ${input.command} failed${target}`));
  console.error("");
  console.error(cliBold("Reason:"));
  for (const line of linesFrom(input.reason, 5)) {
    console.error(`  ${line}`);
  }
  if (input.details !== undefined) {
    console.error("");
    console.error(`${cliBold("Details:")} ${input.details}`);
  }
  if ((input.hints !== undefined && input.hints.length > 0) || input.retryCommand !== undefined) {
    console.error("");
    console.error(cliBold("Hint:"));
    for (const hint of input.hints ?? []) {
      console.error(`  ${hint}`);
    }
    if (input.retryCommand !== undefined) {
      console.error("");
      console.error(cliCyan(input.retryCommand));
    }
  }
};
