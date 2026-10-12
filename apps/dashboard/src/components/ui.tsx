import type { ReactNode } from "react";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning";
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function ErrorNotice({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="notice notice--error" role="alert">
      <p>{message}</p>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        ✧
      </span>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function formattedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}
