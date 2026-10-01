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
  const unpricedModels = bedrockDaily?.unpricedModels ?? [];
  const unpricedCalls = unpricedModels.reduce((total, entry) => total + entry.calls, 0);
  const unpricedModelSummary = [...unpricedModels]
    .sort((left, right) => right.calls - left.calls || left.model.localeCompare(right.model))
    .slice(0, 3)
    .map(({ model, calls }) => `${model} (${calls.toLocaleString()} calls)`)
    .join(", ");
  const remainingUnpricedModelCount = Math.max(0, unpricedModels.length - 3);

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
                {"\u{1F4B5}"} {bedrockDaily.stale ? "~" : ""}
                {unpricedModels.length > 0 ? "≥" : ""}
                {formatUsd(bedrockDaily.cost)}
              </span>
            }
          />
          <TooltipPopup side="top">
            <div className="max-w-sm space-y-1">
              <div>
                Bedrock token-cost estimate for {bedrockDaily.date} ({bedrockDaily.user}), updated{" "}
                {bedrockDaily.refreshedAt}. The amount includes models with known token rates.
              </div>
              {bedrockDaily.stale && (
                <div>The cache is over ten minutes old; a refresh has been started.</div>
              )}
              {unpricedModels.length > 0 && (
                <div className="text-warning">
                  The displayed amount is a lower bound. {unpricedCalls.toLocaleString()} calls
                  across {unpricedModels.length} unpriced models are excluded. Examples:{" "}
                  <span className="break-all">
                    {unpricedModelSummary}
                    {remainingUnpricedModelCount > 0 && `, and ${remainingUnpricedModelCount} more`}
                  </span>
                </div>
              )}
            </div>
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
