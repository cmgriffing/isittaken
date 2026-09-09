import { VENUE_IDS, type VenueId } from "@isittaken/core";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { runCheck } from "./check.js";
import { parsePositiveInt, parseRegistryIds } from "./parse.js";
import { CLI_VERSION } from "./version.js";

const VENUE_LIST = VENUE_IDS.join(", ");

export function buildProgram(): Command {
  const program = new Command();

  // exitOverride must run before `check` is created: commander copies the
  // exit callback onto subcommands at creation time. Without it, subcommand
  // usage errors (missing names, bad flag values) call process.exit(1)
  // instead of surfacing here as exit code 2.
  program.exitOverride();

  program
    .name("isittaken")
    .version(CLI_VERSION)
    .description("Honest multi-registry package-name availability checks for humans and agents.");

  program
    .command("check")
    .description(
      [
        "Check one or more name candidates across package registries.",
        "",
        `venues (${VENUE_LIST}):`,
        "  npm, pypi, crates, rubygems, nuget, hex perform exact single-name checks.",
        "  maven, go, packagist are fuzzy for bare words (results carry fuzzy: true);",
        "  qualified input (vendor/name, group:artifact, a full module path) upgrades",
        "  them to exact checks.",
        "",
        "exit codes:",
        "  0  at least one (name, venue) result is available",
        "  1  none available (taken / invalid / unknown only)",
        "  2  usage error (bad flags, unknown venue id, no names)",
      ].join("\n"),
    )
    .argument("<names...>", "candidate names; multi-word phrases are normalized per venue")
    .option(
      "-r, --registry <ids>",
      `comma-separated venue ids to scope the run (default: all of ${VENUE_LIST})`,
    )
    .option("--json", "emit machine-readable JSON (the agent-friendly output)")
    .option(
      "--concurrency <n>",
      "max concurrent upstream lookups per venue",
      (raw: string): number => {
        const parsed = parsePositiveInt(raw, "--concurrency");
        if (!parsed.ok) throw new InvalidArgumentError(parsed.error);
        return parsed.value;
      },
      10,
    )
    .option(
      "--timeout <ms>",
      "per-venue upstream lookup timeout in milliseconds",
      (raw: string): number => {
        const parsed = parsePositiveInt(raw, "--timeout");
        if (!parsed.ok) throw new InvalidArgumentError(parsed.error);
        return parsed.value;
      },
      10_000,
    )
    .addHelpText(
      "after",
      [
        "",
        "examples:",
        "  isittaken check my-package",
        '  isittaken check "fuzzy picker" other-name --json',
        "  isittaken check mylib -r npm,pypi,crates",
        "  isittaken check symfony/console -r packagist",
      ].join("\n"),
    )
    .action(
      async (
        names: string[],
        options: {
          registry?: string;
          json?: boolean;
          concurrency: number;
          /** Commander camel-cases `--timeout <ms>` to `timeout`. */
          timeout: number;
        },
      ) => {
        let scopeIds: VenueId[] | undefined;
        if (options.registry !== undefined) {
          const scope = parseRegistryIds(options.registry);
          if (!scope.ok) {
            console.error(scope.error);
            process.exitCode = 2;
            return;
          }
          scopeIds = scope.ids;
        }
        try {
          const code = await runCheck(names, {
            registries: scopeIds,
            json: options.json === true,
            concurrency: options.concurrency,
            timeoutMs: options.timeout,
          });
          process.exitCode = code;
        } catch (error) {
          console.error(`check failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 2;
        }
      },
    );

  return program;
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already wrote usage errors to stderr and help/version to
      // stdout; here we only translate the exit code (usage errors exit 2).
      process.exitCode = error.exitCode === 0 ? 0 : 2;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
