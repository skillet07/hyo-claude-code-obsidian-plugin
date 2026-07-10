import React from "react";
import type { PermissionRequestData } from "../chat-types";
import type { ProviderApprovalSelection } from "../providers/types";

interface PermissionRequestProps {
  request: PermissionRequestData;
  onRespond: (requestId: string, selection: ProviderApprovalSelection) => void;
}

export function PermissionRequest({ request, onRespond }: PermissionRequestProps) {
  const { requestId, toolName, input } = request;
  const summary = getPermissionSummary(request);
  const decisions = request.availableDecisions ?? ["deny", "allow", "allow_session"];

  return (
    <div className="hyo-permission">
      <div className="hyo-permission-tool">{toolName}</div>
      {summary && <div className="hyo-permission-summary">{summary}</div>}
      {request.reason && <div className="hyo-permission-reason">Reason: {request.reason}</div>}
      {request.proposedAmendments?.execpolicy && (
        <div className="hyo-permission-amendment">
          Proposed command policy: {safeStringify(request.proposedAmendments.execpolicy)}
        </div>
      )}
      {(request.proposedAmendments?.networkPolicy ?? []).map((amendment, index) => (
        <div key={`network-detail-${index}`} className="hyo-permission-amendment">
          Proposed network rule {index + 1}: {safeStringify(amendment)}
        </div>
      ))}
      {input !== undefined && (
        <details className="hyo-permission-full-data">
          <summary>Full request data</summary>
          <pre>{safeStringify(input)}</pre>
        </details>
      )}
      <div className="hyo-permission-buttons">
        {decisions.flatMap((decision) => {
          if (decision === "apply_network_policy_amendment") {
            return (request.proposedAmendments?.networkPolicy ?? []).map((amendment, index) => (
              <button key={`${decision}-${index}`} onClick={() => onRespond(requestId, {
                decision, networkPolicyAmendment: amendment,
              })}>Apply network rule {index + 1}</button>
            ));
          }
          if (decision === "allow_execpolicy_amendment") {
            const amendment = request.proposedAmendments?.execpolicy;
            return amendment ? [<button key={decision} onClick={() => onRespond(requestId, {
              decision, execpolicyAmendment: amendment,
            })}>Allow with proposed command policy</button>] : [];
          }
          const label = decision === "allow" ? "Allow once"
            : decision === "allow_session" ? (request.availableDecisions ? "Allow for session" : "Always allow")
            : decision === "deny" ? "Deny" : "Cancel";
          const className = decision === "allow_session"
            ? "hyo-permission-allow-always"
            : `hyo-permission-${decision}`;
          return [<button key={decision} className={className} onClick={() => {
            if (request.approvalKind === "permissions" && (decision === "allow" || decision === "allow_session")) {
              onRespond(requestId, { decision: "permissions", permissions: request.input?.permissions ?? {}, scope: decision === "allow_session" ? "session" : "turn" });
            } else if (request.approvalKind === "permissions" && decision === "deny") {
              onRespond(requestId, { decision: "permissions", permissions: {}, scope: "turn" });
            } else onRespond(requestId, { decision });
          }}>{label}</button>];
        })}
      </div>
    </div>
  );
}

function getPermissionSummary(request: PermissionRequestData): string {
  const { toolName, input, approvalKind } = request;
  if (!input) return "";

  if (approvalKind === "command_execution") {
    const command = typeof input.command === "string" ? input.command : safeStringify(input.command);
    const cwd = typeof input.cwd === "string" ? input.cwd : "";
    const network = input.networkApprovalContext ? `\nNetwork: ${safeStringify(input.networkApprovalContext)}` : "";
    return `${command}${cwd ? `\nWorking directory: ${cwd}` : ""}${network}`;
  }
  if (approvalKind === "file_change") {
    return input.grantRoot ? `Grant root: ${String(input.grantRoot)}` : "File change requested";
  }
  if (approvalKind === "permissions") {
    return `Requested permissions: ${safeStringify(input.permissions ?? {})}`;
  }

  switch (toolName) {
    case "Edit":
    case "Write":
    case "Read":
      return input.file_path || "";
    case "Bash":
      return input.command || input.description || "";
    case "Glob":
      return input.pattern || "";
    case "Grep":
      return `"${input.pattern || ""}"`;
    default:
      if (toolName.startsWith("mcp__")) {
        return toolName.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
      }
      return "";
  }
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "[unavailable]"; }
}
