import { LoadingState } from "../components/ui/Feedback";

export default function RootLoading() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <LoadingState />
    </div>
  );
}
