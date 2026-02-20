import type { ReactNode } from "react";

type PanelProps = {
  title: string;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
};

export default function Panel({ title, right, className = "", children }: PanelProps) {
  const classes = `panel ${className}`.trim();

  return (
    <article className={classes}>
      <div className="panelHead">
        <h2>{title}</h2>
        {right ? <small>{right}</small> : null}
      </div>
      {children}
    </article>
  );
}
