import type { ReactNode } from "react";

type MetricCardProps = {
  label: string;
  loading?: boolean;
  value?: ReactNode;
  hint?: ReactNode;
  className?: string;
  valueClassName?: string;
};

export default function MetricCard({
  label,
  loading = false,
  value,
  hint,
  className = "",
  valueClassName = "metricValue",
}: MetricCardProps) {
  const classes = `card metricCard ${className}`.trim();

  return (
    <article className={classes}>
      <p className="metricLabel">{label}</p>
      {loading ? <span className="valueSkeleton" /> : <div className={valueClassName}>{value}</div>}
      {hint ? <p className="metricHint">{hint}</p> : null}
    </article>
  );
}
