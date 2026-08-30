"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { videoApi } from "../../lib/api/video";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { VIDEO_TARGET_PLATFORMS, type KnowledgePackSummary, type VideoTargetPlatform } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { TARGET_PLATFORM_LABEL } from "./videoLabels";
import styles from "./CreateVideoForm.module.css";

export function CreateVideoForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [packs, setPacks] = useState<KnowledgePackSummary[] | null>(null);
  const [topic, setTopic] = useState("");
  const [knowledgePackVersionId, setKnowledgePackVersionId] = useState("");
  const [targetPlatform, setTargetPlatform] = useState<VideoTargetPlatform>("YOUTUBE_LONG");
  const [durationSecondsTarget, setDurationSecondsTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    knowledgePacksApi
      .list(workspaceId)
      .then((all) => setPacks(all.filter((p) => p.status === "ACTIVE")))
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId]);

  const durationNum = durationSecondsTarget.trim() ? Number(durationSecondsTarget) : undefined;
  const durationValid = durationNum === undefined || (Number.isInteger(durationNum) && durationNum >= 5 && durationNum <= 7200);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending || !topic.trim() || !knowledgePackVersionId || !durationValid) return;
    setPending(true);
    setError(null);
    try {
      const pipeline = await videoApi.create(workspaceId, {
        topic: topic.trim(),
        knowledgePackVersionId,
        targetPlatform,
        ...(durationNum !== undefined ? { durationSecondsTarget: durationNum } : {}),
      });
      router.push(`/workspaces/${workspaceId}/video/${pipeline.contentItem.publicId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : friendlyMessage(err));
      setPending(false);
    }
  }

  const backHref = `/workspaces/${workspaceId}/video`;

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="New Video"
        description="Pick a topic, a target platform and an active Knowledge Pack. The pipeline generates a brief immediately, then walks through script, scene plan, assets, voice, subtitles, render, QA and scoring before human review."
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Video
          </a>
        }
      />

      {packs === null && !error && <LoadingState label="Loading Knowledge Packs…" />}
      {error && <Alert tone="danger">{error}</Alert>}

      {packs !== null && packs.length === 0 && (
        <Alert tone="warning" title="No active Knowledge Pack">
          A video is generated against an <strong>Active</strong> Knowledge Pack. Activate one first, then come back here.
        </Alert>
      )}

      {packs !== null && packs.length > 0 && (
        <Card>
          <form onSubmit={handleSubmit} className={styles.form} aria-label="New Video">
            <FormField label="Topic" hint="A clear, specific subject for the video.">
              {(field) => (
                <Input
                  {...field}
                  required
                  autoFocus
                  value={topic}
                  placeholder="e.g. How to charge an EV at home"
                  onChange={(e) => setTopic(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Target platform" hint="Sets the export profile (resolution, aspect ratio, frame rate).">
              {(field) => (
                <Select {...field} required value={targetPlatform} onChange={(e) => setTargetPlatform(e.target.value as VideoTargetPlatform)}>
                  {VIDEO_TARGET_PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {TARGET_PLATFORM_LABEL[p]}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <FormField label="Knowledge Pack" hint="Its brand voice, keyword sets and SEO rules ground every stage.">
              {(field) => (
                <Select {...field} required value={knowledgePackVersionId} onChange={(e) => setKnowledgePackVersionId(e.target.value)}>
                  <option value="" disabled>
                    Select an active Knowledge Pack…
                  </option>
                  {packs.map((pack) => (
                    <option key={pack.publicId} value={pack.publicId}>
                      {pack.name} (v{pack.versionNumber})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <FormField
              label="Target duration"
              optional
              hint="Seconds (5–7200). A hint for the brief agent — leave blank to let it decide."
              error={durationValid ? undefined : "Enter a whole number of seconds between 5 and 7200."}
            >
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={7200}
                  value={durationSecondsTarget}
                  placeholder="e.g. 120"
                  onChange={(e) => setDurationSecondsTarget(e.target.value)}
                />
              )}
            </FormField>

            <div className={styles.actions}>
              <Button href={backHref} variant="ghost">
                Cancel
              </Button>
              <Button type="submit" loading={pending} disabled={!topic.trim() || !knowledgePackVersionId || !durationValid}>
                Create Video
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
