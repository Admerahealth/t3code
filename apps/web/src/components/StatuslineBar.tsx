/**
 * Persistent bottom statusline: Admera knowledge-base reachability and
 * today's cached Bedrock spend. Each segment is independently hidden by its
 * own client setting; the bar renders nothing when both are off.
 */
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

function formatUsd(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

export function StatuslineBar() {
  const { showStatuslineKbStatus, showStatuslineBedrockSpend } = useClientSettings((settings) => ({
    showStatuslineKbStatus: settings.showStatuslineKbStatus,
    showStatuslineBedrockSpend: settings.showStatuslineBedrockSpend,
  }));
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.adminStatus({ environmentId, input: {} }),
  );

  if (!showStatuslineKbStatus && !showStatuslineBedrockSpend) {
    return null;
  }

  // `null` (not yet answered) reads as unknown/loading, distinct from a
  // confirmed offline probe.
  const kbOnline = data?.kb.online ?? null;
  const bedrockDaily = data?.bedrockDaily ?? null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex h-5 items-center gap-3 border-t border-border bg-muted/90 px-2 text-xs backdrop-blur-sm"
      data-statusline=""
    >
      {showStatuslineKbStatus && (
        <span
          className={cn(
            "pointer-events-auto",
            kbOnline === true && "text-success",
            kbOnline === false && "text-destructive",
            kbOnline === null && "text-muted-foreground",
          )}
          title="Admera knowledge base"
        >
          KB {kbOnline === true ? "●" : "○"}
        </span>
      )}
      {showStatuslineBedrockSpend && bedrockDaily !== null && (
        <span
          className="pointer-events-auto text-muted-foreground"
          title={`Bedrock spend for ${bedrockDaily.date} (${bedrockDaily.user})`}
        >
          {"\u{1F4B5}"} {formatUsd(bedrockDaily.cost)}
        </span>
      )}
    </div>
  );
}
