import { KeywordSet } from "./KeywordSet";
import type { NormalizedCluster } from "./keywords";
import styles from "./KeywordClusterView.module.css";

/**
 * Renders one or more keyword clusters (title + primary/secondary sets).
 * Research detail passes several; Topic Cluster detail passes exactly one.
 */
export function KeywordClusterView({ clusters, showTitle = true }: { clusters: NormalizedCluster[]; showTitle?: boolean }) {
  return (
    <div className={styles.list}>
      {clusters.map((cluster, i) => (
        <div key={i} className={styles.cluster}>
          {showTitle && <h3 className={styles.title}>{cluster.title}</h3>}
          <div className={styles.sets}>
            <KeywordSet label="Primary" keywords={cluster.primary} />
            <KeywordSet label="Secondary" keywords={cluster.secondary} />
          </div>
        </div>
      ))}
    </div>
  );
}
