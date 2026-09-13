"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-ink-soft shadow-card ${className}`}>{children}</div>
  );
}

export function Badge({ children, tone = "text-mist border-line" }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${tone}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-ink-soft p-4 shadow-card">
      <div className="text-[11px] tracking-wide text-mist uppercase">{label}</div>
      <div className="mt-1.5 text-lg text-chalk break-all">{value}</div>
      {sub && <div className="mt-1 text-xs text-mist">{sub}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-chalk">{label}</span>
      {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputBase =
  "w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-chalk outline-none transition-colors placeholder:text-mist/50 focus:border-bug-dim";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputBase} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputBase} font-mono ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${inputBase} appearance-none ${props.className ?? ""}`}>
      {props.children}
    </select>
  );
}

type BtnVariant = "primary" | "ghost" | "danger";
const variants: Record<BtnVariant, string> = {
  primary: "border-bug-dim bg-bug-dim/10 text-bug hover:bg-bug-dim/20",
  ghost: "border-line text-chalk hover:border-mist",
  danger: "border-red-500/40 bg-red-500/5 text-red-400 hover:bg-red-500/10",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return (
    <button
      {...props}
      className={`rounded-md border px-4 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    />
  );
}

export function LinkButton({
  href,
  variant = "ghost",
  children,
}: {
  href: string;
  variant?: BtnVariant;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`inline-block rounded-md border px-4 py-2 text-sm transition-colors ${variants[variant]}`}
    >
      {children}
    </Link>
  );
}

/** Copy-to-clipboard chip for hashes and addresses. */
export function Copyable({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
      className="inline-flex items-center gap-1.5 font-mono text-xs text-mist transition-colors hover:text-chalk"
      title="copy"
    >
      <span className="break-all">{display ?? value}</span>
      <span className="text-bug-dim">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-xs tracking-widest text-mist uppercase">{children}</h2>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-ink-soft/50 p-8 text-center text-sm text-mist">
      {children}
    </div>
  );
}
