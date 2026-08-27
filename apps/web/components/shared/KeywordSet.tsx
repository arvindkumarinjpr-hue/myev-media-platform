import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Meter } from "../ui/Meter";
import { INTENT_LABEL, type NormalizedKeyword } from "./keywords";
import styles from "./KeywordSet.module.css";

interface KeywordSetProps {
  label: string;
  keywords: NormalizedKeyword[];
}

/** One primary/secondary keyword table. Reused by Research detail and Topic Cluster detail. */
export function KeywordSet({ label, keywords }: KeywordSetProps) {
  if (keywords.length === 0) return null;

  const columns: Column<NormalizedKeyword>[] = [
    {
      key: "term",
      header: "Keyword",
      render: (k) => <span className={styles.term}>{k.term}</span>,
    },
    {
      key: "intent",
      header: "Intent",
      render: (k) => <Badge tone="neutral">{INTENT_LABEL[k.intent]}</Badge>,
    },
    {
      key: "opportunity",
      header: "Opportunity",
      render: (k) => <Meter value={k.opportunityScore} label={`Opportunity score for ${k.term}`} />,
    },
    {
      key: "rationale",
      header: "Why",
      render: (k) => <span className={styles.rationale}>{k.rationale}</span>,
    },
  ];

  return (
    <div className={styles.set}>
      <p className={styles.label}>
        <span>{label}</span>
        <span className={styles.count}>{keywords.length}</span>
      </p>
      <DataTable columns={columns} rows={keywords} rowKey={(k) => k.term} caption={`${label} keywords`} />
    </div>
  );
}
