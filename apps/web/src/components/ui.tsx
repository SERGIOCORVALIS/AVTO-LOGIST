import type { ReactNode } from "react";

export function GoldCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-gold-500/25 bg-navy-900/80 p-5 shadow-gold backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs leading-relaxed text-white/50">{children}</p>;
}

export function StatusBadge({ status }: { status: string }) {
  const hot = status === "awaiting_manager" || status === "negotiation";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        hot
          ? "bg-gold-500/20 text-gold-300"
          : "bg-navy-600/50 text-white/80"
      }`}
    >
      {status}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "gold",
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "gold" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const cls =
    variant === "gold"
      ? "bg-gold-500 text-navy-950 hover:bg-gold-300"
      : variant === "danger"
        ? "bg-red-900/70 text-white hover:bg-red-800"
        : "border border-gold-500/40 text-gold-300 hover:bg-gold-500/10";
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-40 ${cls} ${className}`.trim()}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wider text-gold-300/80">
        {label}
      </span>
      {children}
      {hint ? <Hint>{hint}</Hint> : null}
    </label>
  );
}

export function inputClass() {
  return "w-full rounded-lg border border-gold-500/20 bg-navy-950 px-3 py-2 text-sm text-white outline-none focus:border-gold-400";
}
