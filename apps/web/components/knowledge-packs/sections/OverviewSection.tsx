"use client";

import type { KnowledgePackDetail } from "../../../lib/types";
import { Card } from "../../ui/Card";
import { ChipsInput } from "../../ui/ChipsInput";
import { FormField } from "../../ui/FormField";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import { AdvancedJson } from "../AdvancedJson";
import { STATUS_HELP } from "../labels";
import { readList, readStr, setList, setStr } from "../objectFields";
import styles from "./sections.module.css";

const INDUSTRY_KEYS = ["industry", "region", "audience"];
const STRATEGY_KEYS = ["cadence", "channels"];

const CADENCE_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
];

interface OverviewSectionProps {
  pack: KnowledgePackDetail;
  name: string;
  onNameChange: (next: string) => void;
  industryProfile: Record<string, unknown>;
  publishingStrategy: Record<string, unknown>;
  onIndustryChange: (next: Record<string, unknown>) => void;
  onStrategyChange: (next: Record<string, unknown>) => void;
  readOnly: boolean;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function OverviewSection({
  pack,
  name,
  onNameChange,
  industryProfile,
  publishingStrategy,
  onIndustryChange,
  onStrategyChange,
  readOnly,
}: OverviewSectionProps) {
  const cadence = readStr(publishingStrategy, "cadence");
  const cadenceOptions = CADENCE_OPTIONS.some((o) => o.value === cadence) || cadence === ""
    ? CADENCE_OPTIONS
    : [...CADENCE_OPTIONS, { value: cadence, label: cadence }];

  return (
    <div className={styles.stack}>
      <Card>
        <p className={styles.cardTitle}>Basics</p>
        <p className={styles.cardHint}>{STATUS_HELP[pack.status]}</p>
        <div className={styles.stack}>
          <FormField label="Name">
            {(field) => (
              <Input
                {...field}
                value={name}
                readOnly={readOnly}
                maxLength={200}
                placeholder="e.g. EV Buyer Content Pack"
                onChange={(e) => onNameChange(e.target.value)}
              />
            )}
          </FormField>
        </div>
        <dl className={styles.metaList}>
          <div>
            <dt>Version</dt>
            <dd>v{pack.versionNumber}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(pack.createdAt)}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatDate(pack.updatedAt)}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <p className={styles.cardTitle}>Industry profile</p>
        <p className={styles.cardHint}>What space this content operates in — used to ground research and drafting.</p>
        <div className={styles.stack}>
          <FormField label="Industry">
            {(field) => (
              <Input
                {...field}
                value={readStr(industryProfile, "industry")}
                readOnly={readOnly}
                placeholder="e.g. Electric vehicles"
                onChange={(e) => onIndustryChange(setStr(industryProfile, "industry", e.target.value))}
              />
            )}
          </FormField>
          <FormField label="Region / market" optional>
            {(field) => (
              <Input
                {...field}
                value={readStr(industryProfile, "region")}
                readOnly={readOnly}
                placeholder="e.g. India"
                onChange={(e) => onIndustryChange(setStr(industryProfile, "region", e.target.value))}
              />
            )}
          </FormField>
          <FormField label="Target audience" optional>
            {(field) => (
              <Textarea
                {...field}
                value={readStr(industryProfile, "audience")}
                readOnly={readOnly}
                rows={2}
                placeholder="Who this content is for"
                onChange={(e) => onIndustryChange(setStr(industryProfile, "audience", e.target.value))}
              />
            )}
          </FormField>
          <AdvancedJson value={industryProfile} onChange={onIndustryChange} readOnly={readOnly} noun="industry profile" knownKeys={INDUSTRY_KEYS} />
        </div>
      </Card>

      <Card>
        <p className={styles.cardTitle}>Publishing strategy</p>
        <p className={styles.cardHint}>How often and where this content is published.</p>
        <div className={styles.stack}>
          <FormField label="Publishing cadence">
            {(field) => (
              <Select
                {...field}
                value={cadence}
                disabled={readOnly}
                onChange={(e) => onStrategyChange(setStr(publishingStrategy, "cadence", e.target.value))}
              >
                <option value="">Not set</option>
                {cadenceOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Channels" optional hint="Press Enter or comma to add each channel.">
            {(field) => (
              <ChipsInput
                {...field}
                value={readList(publishingStrategy, "channels")}
                readOnly={readOnly}
                placeholder="blog, youtube, newsletter…"
                onChange={(v) => onStrategyChange(setList(publishingStrategy, "channels", v))}
              />
            )}
          </FormField>
          <AdvancedJson value={publishingStrategy} onChange={onStrategyChange} readOnly={readOnly} noun="publishing strategy" knownKeys={STRATEGY_KEYS} />
        </div>
      </Card>
    </div>
  );
}
