/**
 * Persistent bottom statusline: Admera knowledge-base reachability and
 * today's cached Bedrock spend. Each segment is independently hidden by its
 * own client setting; the bar renders nothing when both are off, and the
 * underlying status query is not even issued in that case.
 */
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
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
  const showBar = showStatuslineKbStatus || showStatuslineBedrockSpend;
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error } = useEnvironmentQuery(
    showBar && environmentId !== null
      ? serverEnvironment.adminStatus({ environmentId, input: {} })
      : null,
  );

  if (!showBar) {
    return null;
  }

  // `null` (not yet answered) reads as unknown/loading, distinct from a
  // confirmed offline probe or a transport failure.
  const kbIndicator: "error" | "unknown" | "online" | "offline" =
    error !== null ? "error" : data === null ? "unknown" : data.kb.online ? "online" : "offline";
  const bedrockDaily = data?.bedrockDaily ?? null;

  return (
    <div
      className="flex h-5 shrink-0 items-center gap-3 border-t border-border bg-muted px-2 text-xs"
      data-statusline=""
    >
      {showStatuslineKbStatus && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  kbIndicator === "online" && "text-success",
                  kbIndicator === "offline" && "text-destructive",
                  kbIndicator === "error" && "text-warning",
                  kbIndicator === "unknown" && "text-muted-foreground",
                )}
              >
                KB {kbIndicator === "online" ? "●" : "○"}
              </span>
            }
          />
          <TooltipPopup side="top">
            {kbIndicator === "error" ? "Status query failed" : "Admera knowledge base"}
          </TooltipPopup>
        </Tooltip>
      )}
      {showStatuslineBedrockSpend && bedrockDaily !== null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="text-muted-foreground">
                {"\u{1F4B5}"} {formatUsd(bedrockDaily.cost)}
              </span>
            }
          />
          <TooltipPopup side="top">
            Bedrock spend for {bedrockDaily.date} ({bedrockDaily.user})
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
