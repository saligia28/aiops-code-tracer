import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './PageHeader.css';

export interface PageHeaderProps {
  /** Editorial index number, e.g. "02". */
  index: string;
  /** Short uppercase mono label, e.g. "GRAPH". */
  kicker: string;
  /** Page title. */
  title: string;
  /** Optional plain-text description. */
  description?: string;
  /** Optional back target; renders a declarative back link when set. */
  backTo?: string;
  /** Right-aligned actions slot. */
  actions?: ReactNode;
}

export function PageHeader({ index, kicker, title, description, backTo, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__meta">
        <span className="page-header__folio">
          <span className="page-header__index">{index}</span>
          <span className="page-header__sep" aria-hidden="true">·</span>
          <span className="page-header__kicker">{kicker}</span>
        </span>
        {backTo && (
          <Link to={backTo} className="page-header__back">
            ← 返回
          </Link>
        )}
      </div>

      <div className="page-header__bar">
        <h1 className="page-header__title">{title}</h1>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>

      {description && <p className="page-header__desc">{description}</p>}
    </header>
  );
}
