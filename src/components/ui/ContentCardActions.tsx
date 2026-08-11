import React from "react";
import { Eye, Zap, Pencil, Trash2, ListPlus } from "lucide-react";
import { cn } from "./cn";
import { Button, type ButtonVariant, type ButtonSize } from "./Button";

export interface ContentCardActionsProps {
  onPreview?: () => void;
  onStage?: () => void;
  onLive?: () => void;
  onAddToSchedule?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Dense one-line row (default) vs a multi-button grid for wide cards. */
  dense?: boolean;
  hidePreview?: boolean;
  deleteVariant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** Standardized content action vocabulary shared by every library row:
 *  Preview, Stage, Go Live, Add to Service, Edit, Delete. Never hover-only. */
export function ContentCardActions({
  onPreview,
  onStage,
  onLive,
  onAddToSchedule,
  onEdit,
  onDelete,
  dense = false,
  hidePreview = false,
  deleteVariant = "live",
  size = "sm",
  className,
}: ContentCardActionsProps) {
  const stageBtn = (v: ButtonVariant, label: string, icon?: React.ReactNode, onClick?: () => void, key?: string) => (
    <Button
      key={key ?? `${v}-${label}`}
      variant={v}
      size={size}
      icon={icon}
      onClick={(e) => { e?.stopPropagation(); onClick?.(); }}
      className={cn(dense && "px-1.5 text-[8px]")}
    >
      {label}
    </Button>
  );

  const actions: React.ReactNode[] = [];
  if (onPreview && !hidePreview) actions.push(stageBtn("bare", "Preview", <Eye size={11} />, onPreview, "preview"));
  if (onStage) actions.push(stageBtn("ghost", "Stage", undefined, onStage, "stage"));
  if (onLive) actions.push(stageBtn("primary", "Go Live", <Zap size={11} />, onLive, "live"));
  if (onAddToSchedule) actions.push(stageBtn("bare", "Service", <ListPlus size={11} />, onAddToSchedule, "service"));
  if (onEdit) actions.push(stageBtn("ghost", "Edit", <Pencil size={11} />, onEdit, "edit"));
  if (onDelete) actions.push(stageBtn(deleteVariant, "Delete", <Trash2 size={11} />, onDelete, "delete"));

  return (
    <div
      className={cn(
        "flex items-center gap-1 flex-wrap",
        dense ? "" : "grid grid-cols-3 gap-1",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {actions}
    </div>
  );
}