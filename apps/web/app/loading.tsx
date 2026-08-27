import { LoadingState } from "../components/ui/Feedback";
import styles from "./loading.module.css";

export default function RootLoading() {
  return (
    <div className={styles.wrap}>
      <LoadingState />
    </div>
  );
}
