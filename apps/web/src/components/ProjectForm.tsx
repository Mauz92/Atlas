import { useId, useState } from "react";
import type { FormEvent } from "react";

import type { Project, ProjectFields } from "../api/client";

interface ProjectFormProps {
  /** The project being edited; omitted when creating one. */
  project?: Project;
  submitLabel: string;
  /** Persist the values. A rejection is shown verbatim and the form keeps what was typed. */
  onSubmit: (name: string, fields: ProjectFields) => Promise<void>;
  onCancel?: () => void;
}

/**
 * Create / edit form for a project (MU-02): name, description and the optional start and target
 * dates. It only gathers values; the server validates them and its message is shown unchanged.
 */
export function ProjectForm({
  project,
  submitLabel,
  onSubmit,
  onCancel,
}: ProjectFormProps) {
  const ids = useId();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [startDate, setStartDate] = useState(project?.start_date ?? "");
  const [targetDate, setTargetDate] = useState(project?.target_date ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), {
        description: description.trim() === "" ? null : description,
        start_date: startDate === "" ? null : startDate,
        target_date: targetDate === "" ? null : targetDate,
      });
      if (!project) {
        setName("");
        setDescription("");
        setStartDate("");
        setTargetDate("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="project-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={`${ids}-name`}>Project name</label>
      <input
        id={`${ids}-name`}
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor={`${ids}-description`}>Project description</label>
      <textarea
        id={`${ids}-description`}
        rows={3}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <div className="project-form-dates">
        <div>
          <label htmlFor={`${ids}-start`}>Start date</label>
          <input
            id={`${ids}-start`}
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${ids}-target`}>Target date</label>
          <input
            id={`${ids}-target`}
            type="date"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
          />
        </div>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="project-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
